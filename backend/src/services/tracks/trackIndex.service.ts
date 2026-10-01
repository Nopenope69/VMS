/**
 * The track index (feature TRACK_INDEX, default OFF): one ObjectTrack row per tracked object per camera, so an
 * investigation sees "a person in a blue shirt walked from the gate to the loading bay in 40 s" instead of the
 * hundreds of per-frame detection rows that make it up.
 *
 *  - observe(): every stored confirmed-track detection updates its track under a row lock: class vote, first and
 *    last seen, best detection, thinned ground-point path, overall direction, visits to the camera's named zones
 *    (enabled INCLUSION DetectionZones) and colour votes from the worker's colour attributes.
 *  - linkPlate(): a plate read is tied to the vehicle track whose box contains the plate's centre in the nearest
 *    frame (within PLATE_LINK_WINDOW_MS). No containing vehicle box, no link: never a guess.
 *  - The track holds no picture and no plate text; the plate stays in VehicleObservation (and goes with it at the
 *    plate retention purge). Tracks themselves are purged with detection snapshots (dataProtection.service.ts).
 *
 * observeSafely() and linkPlateSafely() never throw: a track-index failure is logged and counted, and the
 * detection or plate read it came from is still stored.
 */
import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { MetricsService } from '../observability/metrics.service';
import {
  Box,
  ColourVotes,
  PathPoint,
  Votes,
  ZoneDef,
  ZoneVisit,
  addColourVotes,
  addVote,
  appendPath,
  centreInside,
  colourOf,
  directionOf,
  emptyColourVotes,
  groundPoint,
  majority,
  parseColour,
  updateZoneVisits,
  zonesAt,
} from './trackMath';

/** A plate read links to a vehicle detection at most this far apart in time. */
export const PLATE_LINK_WINDOW_MS = 1000;
const ZONE_CACHE_MS = 10_000;

export interface TrackObservation {
  tenantId: string;
  cameraId: string;
  detectionId: string;
  trackId: string;
  objectClass: string;
  confidence: number;
  boundingBox: Box;
  at: Date;
  /** When the worker's tracker first saw the object (before it was confirmed). */
  trackFirstSeenAt?: Date;
  attributes?: unknown;
  modelSha256?: string;
}

export interface PlateLinkInput {
  tenantId: string;
  cameraId: string;
  at: Date;
  plateBox: Box;
  vehicleObservationId: string;
}

export type PlateLinkOutcome = 'linked' | 'already_linked' | 'no_vehicle_track' | 'conflict';

interface TrackRow {
  id: string;
  tenantId: string;
  objectClass: string;
  classVotesJson: Votes;
  firstSeenAt: Date;
  lastSeenAt: Date;
  observationCount: number;
  maxConfidence: number;
  bestDetectionId: string | null;
  pathJson: PathPoint[];
  zonesJson: ZoneVisit[];
  colourVotesJson: ColourVotes | Record<string, never>;
  modelSha256: string | null;
}

const OBSERVE_METRIC = 'vigilone_track_index_observations_total';
const OBSERVE_HELP = 'Detections applied to the track index, by outcome';
const LINK_METRIC = 'vigilone_track_index_plate_links_total';
const LINK_HELP = 'Plate reads tied to vehicle tracks, by outcome';

export class TrackIndexService {
  private zoneCache = new Map<string, { at: number; zones: ZoneDef[] }>();

  constructor(private prisma: PrismaClient) {}

  async observeSafely(o: TrackObservation): Promise<void> {
    try {
      await this.observe(o);
      MetricsService.incCounter(OBSERVE_METRIC, OBSERVE_HELP, { outcome: 'applied' });
    } catch (err: any) {
      MetricsService.incCounter(OBSERVE_METRIC, OBSERVE_HELP, { outcome: 'failed' });
      console.error(`[TrackIndex] track ${o.trackId} on camera ${o.cameraId} not updated: ${err?.message || err}`);
    }
  }

  async observe(o: TrackObservation): Promise<void> {
    const zones = await this.zones(o.cameraId);
    const ground = groundPoint(o.boundingBox);
    const inZones = zonesAt(ground, zones);
    const colour = parseColour(o.attributes);
    const firstSeen = o.trackFirstSeenAt && o.trackFirstSeenAt.getTime() <= o.at.getTime() ? o.trackFirstSeenAt : o.at;

    await this.prisma.$transaction(async (tx) => {
      // Create the row if this is the track's first detection, then lock it: concurrent detections of one track
      // (a retry racing the next frame) are applied one after the other, never lost.
      await tx.$executeRaw`
        INSERT INTO "ObjectTrack" ("id", "tenantId", "cameraId", "trackId", "objectClass", "classVotesJson", "firstSeenAt", "lastSeenAt",
                                   "pathJson", "zonesJson", "colourVotesJson", "modelSha256", "updatedAt")
        VALUES (${crypto.randomUUID()}, ${o.tenantId}, ${o.cameraId}, ${o.trackId}, ${o.objectClass}, '{}'::jsonb, ${firstSeen}, ${o.at},
                '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, ${o.modelSha256 ?? null}, NOW())
        ON CONFLICT ("cameraId", "trackId") DO NOTHING`;
      const rows = await tx.$queryRaw<TrackRow[]>`
        SELECT "id", "tenantId", "objectClass", "classVotesJson", "firstSeenAt", "lastSeenAt", "observationCount", "maxConfidence",
               "bestDetectionId", "pathJson", "zonesJson", "colourVotesJson", "modelSha256"
        FROM "ObjectTrack" WHERE "cameraId" = ${o.cameraId} AND "trackId" = ${o.trackId} FOR UPDATE`;
      const t = rows[0];
      if (!t) throw new Error('track row missing after insert');
      if (t.tenantId !== o.tenantId) throw new Error(`track ${o.trackId} belongs to another tenant`);

      const classVotes = addVote(t.classVotesJson || {}, o.objectClass);
      const prevColour = (t.colourVotesJson as ColourVotes)?.upper ? (t.colourVotesJson as ColourVotes) : emptyColourVotes();
      const colourVotes = addColourVotes(prevColour, colour);
      const path = appendPath(t.pathJson || [], { t: o.at.getTime(), ...ground });
      const visits = updateZoneVisits(t.zonesJson || [], inZones, o.at);
      const best = o.confidence > t.maxConfidence || !t.bestDetectionId;
      const first = firstSeen < t.firstSeenAt ? firstSeen : t.firstSeenAt;
      const last = o.at > t.lastSeenAt ? o.at : t.lastSeenAt;

      await tx.objectTrack.update({
        where: { id: t.id },
        data: {
          objectClass: majority(classVotes) ?? t.objectClass,
          classVotesJson: classVotes,
          firstSeenAt: first,
          lastSeenAt: last,
          dwellSeconds: Math.round((last.getTime() - first.getTime()) / 100) / 10,
          observationCount: t.observationCount + 1,
          maxConfidence: Math.max(t.maxConfidence, o.confidence),
          bestDetectionId: best ? o.detectionId : t.bestDetectionId,
          pathJson: path as unknown as Prisma.InputJsonValue,
          direction: directionOf(path),
          zonesJson: visits as unknown as Prisma.InputJsonValue,
          zoneIds: [...new Set(visits.map((v) => v.zoneId))],
          colourVotesJson: colourVotes as unknown as Prisma.InputJsonValue,
          upperColour: colourOf(colourVotes.upper),
          lowerColour: colourOf(colourVotes.lower),
          bodyColour: colourOf(colourVotes.body),
          modelSha256: t.modelSha256 ?? o.modelSha256 ?? null,
        },
      });
    });
  }

  async linkPlateSafely(p: PlateLinkInput): Promise<PlateLinkOutcome | 'failed'> {
    try {
      const outcome = await this.linkPlate(p);
      MetricsService.incCounter(LINK_METRIC, LINK_HELP, { outcome });
      return outcome;
    } catch (err: any) {
      MetricsService.incCounter(LINK_METRIC, LINK_HELP, { outcome: 'failed' });
      console.error(`[TrackIndex] plate read ${p.vehicleObservationId} not linked: ${err?.message || err}`);
      return 'failed';
    }
  }

  /** Ties a plate read to the vehicle track whose box contains the plate in the nearest frame. */
  async linkPlate(p: PlateLinkInput): Promise<PlateLinkOutcome> {
    const t0 = p.at.getTime();
    const candidates = await this.prisma.detectionEvent.findMany({
      where: {
        tenantId: p.tenantId,
        cameraId: p.cameraId,
        type: 'VEHICLE_DETECTED',
        trackId: { not: null },
        timestamp: { gte: new Date(t0 - PLATE_LINK_WINDOW_MS), lte: new Date(t0 + PLATE_LINK_WINDOW_MS) },
      },
      select: { trackId: true, boundingBox: true, timestamp: true },
    });
    const containing = candidates
      .filter((d) => d.boundingBox && centreInside(p.plateBox, d.boundingBox as unknown as Box))
      .map((d) => {
        const b = d.boundingBox as unknown as Box;
        return { trackId: d.trackId!, dt: Math.abs(d.timestamp.getTime() - t0), area: b.width * b.height };
      })
      // Nearest frame first; within it the smallest box, so a plate inside a car inside a bus's box goes to the car.
      .sort((a, b) => a.dt - b.dt || a.area - b.area);
    for (const c of containing) {
      const track = await this.prisma.objectTrack.findUnique({ where: { cameraId_trackId: { cameraId: p.cameraId, trackId: c.trackId } }, select: { id: true, vehicleObservationId: true } });
      if (!track) continue;
      if (track.vehicleObservationId === p.vehicleObservationId) return 'already_linked';
      if (track.vehicleObservationId) return 'conflict'; // the first plate stays; a second plate in the same vehicle box is not trusted
      const linked = await this.prisma.objectTrack.updateMany({ where: { id: track.id, vehicleObservationId: null }, data: { vehicleObservationId: p.vehicleObservationId } });
      if (linked.count === 0) return 'conflict';
      await this.prisma.vehicleObservation.updateMany({ where: { id: p.vehicleObservationId, trackId: null }, data: { trackId: c.trackId } });
      return 'linked';
    }
    return 'no_vehicle_track';
  }

  /** The camera's enabled INCLUSION zones (10 s cache). */
  private async zones(cameraId: string): Promise<ZoneDef[]> {
    const hit = this.zoneCache.get(cameraId);
    if (hit && Date.now() - hit.at < ZONE_CACHE_MS) return hit.zones;
    const rows = await this.prisma.detectionZone.findMany({ where: { cameraId, enabled: true, type: 'INCLUSION' }, select: { id: true, name: true, polygonCoordinates: true } });
    const zones = rows.filter((z) => Array.isArray(z.polygonCoordinates)).map((z) => ({ id: z.id, name: z.name, polygon: z.polygonCoordinates as unknown as ZoneDef['polygon'] }));
    this.zoneCache.set(cameraId, { at: Date.now(), zones });
    return zones;
  }

  /** Test hook: forget cached zones. */
  clearZoneCache(): void {
    this.zoneCache.clear();
  }
}
