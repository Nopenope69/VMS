import { PrismaClient, VehicleCategory, WatchlistCategory, EventSeverity } from '@prisma/client';
import { normalizeIndianPlate, INDIAN_STATE_CODES as STATE_CODES } from '../../contracts/indianPlate.v1';
import { matchWatchlist } from './watchlistMatcher';
import { fromAnprObservation } from '../incident/orchestrator/events';
import type { AiProvenance } from '../incident/orchestrator/types';
import { MetricsService } from '../observability/metrics.service';

/**
 * Multi-frame plate aggregation (P4.1): reads of the same plate on one camera within a session
 * window are voted into one VehicleObservation; the observation is matched against the tenant's
 * known-plate lists (exact, wildcard, regex); and each new observation and each first watchlist
 * match becomes an ANPR_MATCH event in the IncidentOrchestrator, so rules and alarms go through
 * the audited path. Provenance travels with every read and is stored on the observation.
 */
export interface RawPlateDetection {
  tenantId: string;
  cameraId: string;
  trackId?: string;
  plateText: string;
  confidence: number;
  vehicleCategory?: VehicleCategory;
  snapshotPath?: string;
  timestamp?: Date;
  rawText?: string;
  lines?: number;
  provenance?: AiProvenance | null;
}

export interface AggregatedPlateResult {
  observationId: string;
  plateNumber: string;
  normalizedPlate: string;
  displayPlate: string;
  stateCode: string | null;
  plateFormat: string;
  validFormat: boolean;
  vehicleCategory: VehicleCategory;
  confidence: number;
  observationCount: number;
  isNewObservation: boolean;
  matchedWatchlist: Array<{ id: string; category: WatchlistCategory; matchType: string; notes?: string | null; ownerName?: string | null }>;
}

export const INDIAN_STATE_CODES = STATE_CODES;

interface TrackBuffer {
  key: string;
  tenantId: string;
  cameraId: string;
  observations: RawPlateDetection[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  bestConfidence: number;
  bestSnapshotPath?: string;
  categoryVotes: Map<VehicleCategory, number>;
  vehicleObservationId?: string;
  consensus: string;
  announcedWatchlistIds: Set<string>;
}

export type EventSink = (event: ReturnType<typeof fromAnprObservation>) => Promise<unknown>;
export type AlarmSink = (event: ReturnType<typeof fromAnprObservation>, entry: { id: string; category: WatchlistCategory; severity: EventSeverity; notes?: string | null }) => Promise<unknown>;

const hamming = (a: string, b: string) => {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
};

export class PlateTrackAggregatorService {
  private activeTracks: Map<string, TrackBuffer> = new Map();
  private sessionWindowMs = 30000;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private eventSink: EventSink | null = null;
  private alarmSink: AlarmSink | null = null;

  constructor(private prisma: PrismaClient) {}

  /** Where ANPR_MATCH events go (the IncidentOrchestrator in the app; a stub in unit tests). */
  public setEventSink(sink: EventSink | null) {
    this.eventSink = sink;
  }

  /** Alarm for list entries with alertOnMatch (raised through the orchestrator, audited). */
  public setAlarmSink(sink: AlarmSink | null) {
    this.alarmSink = sink;
  }

  public start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.evictStaleTracks(), 10000);
  }

  public stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
    this.activeTracks.clear();
  }

  /** Compatibility wrapper over contracts/indianPlate.v1 (the authoritative rules). */
  public static normalizeIndianPlate(rawText: string): { normalizedPlate: string; stateCode: string | null; isValidFormat: boolean } {
    const r = normalizeIndianPlate(rawText);
    return { normalizedPlate: r.normalized, stateCode: r.stateCode, isValidFormat: r.valid };
  }

  /**
   * Confidence-weighted per-character vote over reads of the most common length. Reads are
   * normalised first so a read's letter/digit correction does not split the vote.
   */
  public static voteConsensus(observations: RawPlateDetection[]): string {
    if (observations.length === 0) return '';
    const norm = observations.map((o) => ({ t: normalizeIndianPlate(o.plateText).normalized, c: o.confidence }));
    const byLen = new Map<number, number>();
    for (const o of norm) byLen.set(o.t.length, (byLen.get(o.t.length) || 0) + o.c);
    const len = [...byLen.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    const same = norm.filter((o) => o.t.length === len);
    let out = '';
    for (let i = 0; i < len; i++) {
      const score = new Map<string, number>();
      for (const o of same) score.set(o.t[i], (score.get(o.t[i]) || 0) + o.c);
      out += [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    }
    return out;
  }

  private findTrack(tenantId: string, cameraId: string, plate: string, at: number): TrackBuffer | null {
    let best: TrackBuffer | null = null;
    let bestD = Infinity;
    for (const t of this.activeTracks.values()) {
      if (t.tenantId !== tenantId || t.cameraId !== cameraId) continue;
      if (at - t.lastSeenAt.getTime() > this.sessionWindowMs) continue;
      const d = hamming(t.consensus, plate);
      if (d <= 2 && d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  public async processDetection(raw: RawPlateDetection): Promise<AggregatedPlateResult> {
    const timestamp = raw.timestamp || new Date();
    const first = normalizeIndianPlate(raw.plateText);
    let track = this.findTrack(raw.tenantId, raw.cameraId, first.normalized, timestamp.getTime());
    const isNew = !track;
    if (!track) {
      track = {
        key: `${raw.tenantId}_${raw.cameraId}_${first.normalized}_${timestamp.getTime()}`,
        tenantId: raw.tenantId,
        cameraId: raw.cameraId,
        observations: [],
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        bestConfidence: raw.confidence,
        bestSnapshotPath: raw.snapshotPath,
        categoryVotes: new Map(),
        consensus: first.normalized,
        announcedWatchlistIds: new Set(),
      };
      this.activeTracks.set(track.key, track);
    }
    track.observations.push(raw);
    track.lastSeenAt = timestamp;
    if (raw.confidence >= track.bestConfidence) {
      track.bestConfidence = raw.confidence;
      if (raw.snapshotPath) track.bestSnapshotPath = raw.snapshotPath;
    }
    const cat = raw.vehicleCategory || VehicleCategory.UNKNOWN;
    track.categoryVotes.set(cat, (track.categoryVotes.get(cat) || 0) + 1);
    track.consensus = PlateTrackAggregatorService.voteConsensus(track.observations);
    const plate = normalizeIndianPlate(track.consensus);
    const category = [...track.categoryVotes.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const entries = await this.prisma.vehicleWatchlist.findMany({ where: { tenantId: raw.tenantId, active: true } });
    const matches = matchWatchlist(plate.normalized, entries);

    const data = {
      plateNumber: plate.display,
      normalizedPlate: plate.normalized,
      stateCode: plate.stateCode,
      vehicleCategory: category,
      lastSeenAt: track.lastSeenAt,
      observationCount: track.observations.length,
      bestConfidence: track.bestConfidence,
      bestSnapshotPath: track.bestSnapshotPath,
      matchedWatchlistId: matches[0]?.id ?? null,
      plateFormat: plate.format,
      rawText: raw.rawText ?? raw.plateText,
      lines: raw.lines ?? null,
      provenanceJson: (raw.provenance as any) ?? undefined,
    };
    if (!track.vehicleObservationId) {
      const created = await this.prisma.vehicleObservation.create({
        data: { tenantId: raw.tenantId, cameraId: raw.cameraId, trackId: raw.trackId ?? null, firstSeenAt: track.firstSeenAt, ...data },
      });
      track.vehicleObservationId = created.id;
      MetricsService.incCounter('vigilone_anpr_observations_total', 'Vehicle observations created from plate reads', { format: plate.format });
      await this.emit(track, plate.normalized, raw, null);
    } else {
      await this.prisma.vehicleObservation.update({ where: { id: track.vehicleObservationId }, data });
    }
    for (const m of matches) {
      if (track.announcedWatchlistIds.has(m.id)) continue;
      track.announcedWatchlistIds.add(m.id);
      MetricsService.incCounter('vigilone_anpr_watchlist_matches_total', 'Known-plate list matches', { category: m.category, match_type: m.matchType });
      await this.emit(track, plate.normalized, raw, m);
    }

    return {
      observationId: track.vehicleObservationId!,
      plateNumber: plate.display,
      normalizedPlate: plate.normalized,
      displayPlate: plate.display,
      stateCode: plate.stateCode,
      plateFormat: plate.format,
      validFormat: plate.valid,
      vehicleCategory: category,
      confidence: track.bestConfidence,
      observationCount: track.observations.length,
      isNewObservation: isNew,
      matchedWatchlist: matches.map((m) => ({ id: m.id, category: m.category, matchType: m.matchType, notes: m.notes, ownerName: m.ownerName })),
    };
  }

  private async emit(track: TrackBuffer, plate: string, raw: RawPlateDetection, wl: { id: string; category: WatchlistCategory; severity: EventSeverity; alertOnMatch: boolean; notes?: string | null } | null) {
    if (!this.eventSink) return;
    const ev = fromAnprObservation({
      id: wl ? `ev_anpr_${track.vehicleObservationId}_wl_${wl.id}` : `ev_anpr_${track.vehicleObservationId}`,
      tenantId: track.tenantId,
      cameraId: track.cameraId,
      plateText: plate,
      confidence: track.bestConfidence,
      watchlistCategory: wl?.category,
      matchedWatchlistId: wl?.id,
      provenance: raw.provenance ?? undefined,
      ...(wl && (wl.category === WatchlistCategory.BLACKLIST || wl.category === WatchlistCategory.SUSPECT) ? { severity: EventSeverity.CRITICAL } : {}),
    } as any);
    ev.timestampUtc = raw.timestamp || new Date();
    await this.eventSink(ev);
    if (wl && wl.alertOnMatch && this.alarmSink) await this.alarmSink(ev, wl);
  }

  private evictStaleTracks(): void {
    const now = Date.now();
    for (const [key, track] of this.activeTracks.entries()) {
      if (now - track.lastSeenAt.getTime() > this.sessionWindowMs) this.activeTracks.delete(key);
    }
  }
}

export default PlateTrackAggregatorService;
