import { PrismaClient, VehicleCategory, WatchlistCategory, EventSeverity, AlarmState } from '@prisma/client';
import alarmService from '../alarm/alarm.service';

export interface RawPlateDetection {
  tenantId: string;
  cameraId: string;
  trackId?: string;
  plateText: string;
  confidence: number;
  vehicleCategory?: VehicleCategory;
  snapshotPath?: string;
  timestamp?: Date;
}

export interface AggregatedPlateResult {
  plateNumber: string;
  normalizedPlate: string;
  stateCode: string | null;
  vehicleCategory: VehicleCategory;
  confidence: number;
  bestSnapshotPath?: string;
  matchedWatchlist?: {
    id: string;
    category: WatchlistCategory;
    notes?: string | null;
    ownerName?: string | null;
  } | null;
}

// Indian 36 States & Union Territories + Pan-India Bharat (BH)
export const INDIAN_STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BH', 'BR', 'CH', 'CG', 'DD', 'DL',
  'DN', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA',
  'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB',
  'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UA', 'UK', 'UP', 'WB',
]);

interface TrackBuffer {
  tenantId: string;
  cameraId: string;
  trackId: string;
  observations: RawPlateDetection[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  bestConfidence: number;
  bestSnapshotPath?: string;
  categoryVotes: Map<VehicleCategory, number>;
  vehicleObservationId?: string;
}

export class PlateTrackAggregatorService {
  private prisma: PrismaClient;
  private activeTracks: Map<string, TrackBuffer> = new Map();
  private sessionCooldownMs = 30000; // 30s session timeout
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.evictStaleTracks();
    }, 10000);
  }

  public stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.activeTracks.clear();
  }

  /**
   * Normalizes raw OCR plate string into clean Indian standard format.
   * Corrects positional character confusions (e.g. 0 <-> O, 1 <-> I).
   */
  public static normalizeIndianPlate(rawText: string): {
    normalizedPlate: string;
    stateCode: string | null;
    isValidFormat: boolean;
  } {
    // 1. Remove non-alphanumerics and uppercase
    let clean = rawText.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length < 6 || clean.length > 11) {
      return { normalizedPlate: clean, stateCode: null, isValidFormat: false };
    }

    // 2. Check Bharat (BH) Series: YY BH #### AA (e.g. 22BH1234AA)
    const bhMatch = clean.match(/^([0-9]{2})(BH)([0-9]{4})([A-Z]{1,2})$/);
    if (bhMatch) {
      return {
        normalizedPlate: clean,
        stateCode: 'BH',
        isValidFormat: true,
      };
    }

    // 3. Positional Character Confusion Correction:
    // Slot 0-1: State letters (convert 0->O, 1->I, 8->B, 5->S, 2->Z)
    const chars = clean.split('');
    const numToChar: Record<string, string> = { '0': 'O', '1': 'I', '8': 'B', '5': 'S', '2': 'Z' };
    const charToNum: Record<string, string> = { 'O': '0', 'I': '1', 'B': '8', 'S': '5', 'Z': '2', 'D': '0' };

    if (numToChar[chars[0]]) chars[0] = numToChar[chars[0]];
    if (numToChar[chars[1]]) chars[1] = numToChar[chars[1]];

    const potentialState = chars.slice(0, 2).join('');
    const isValidState = INDIAN_STATE_CODES.has(potentialState);

    // Slot 2-3: District digits
    if (chars.length >= 4) {
      if (charToNum[chars[2]]) chars[2] = charToNum[chars[2]];
      if (charToNum[chars[3]]) chars[3] = charToNum[chars[3]];
    }

    // Last 4 characters are digits
    const len = chars.length;
    for (let i = Math.max(4, len - 4); i < len; i++) {
      if (charToNum[chars[i]]) chars[i] = charToNum[chars[i]];
    }

    const corrected = chars.join('');
    // Standard Indian plate regex: 2 letters, 1-2 digits, 0-3 series letters, 4 digits
    const standardRegex = /^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{4})$/;
    const matches = standardRegex.test(corrected);

    return {
      normalizedPlate: corrected,
      stateCode: isValidState ? potentialState : null,
      isValidFormat: matches && isValidState,
    };
  }

  /**
   * Multi-frame OCR voting across an array of plate string observations.
   * Finds character consensus at each character index weighted by confidence.
   */
  public static voteConsensus(observations: RawPlateDetection[]): string {
    if (observations.length === 0) return '';
    if (observations.length === 1) return observations[0].plateText;

    // Filter to top confidence observations
    const sorted = [...observations].sort((a, b) => b.confidence - a.confidence);
    const topObservations = sorted.slice(0, 7);

    // Find median/modal length
    const lengthCounts: Record<number, number> = {};
    for (const obs of topObservations) {
      const len = obs.plateText.length;
      lengthCounts[len] = (lengthCounts[len] || 0) + 1;
    }
    const targetLength = Number(
      Object.keys(lengthCounts).reduce((a, b) => (lengthCounts[Number(a)] > lengthCounts[Number(b)] ? a : b))
    );

    // For each slot index, calculate weighted voting
    const resultChars: string[] = [];
    for (let i = 0; i < targetLength; i++) {
      const charScores: Record<string, number> = {};
      for (const obs of topObservations) {
        if (i < obs.plateText.length) {
          const char = obs.plateText[i];
          charScores[char] = (charScores[char] || 0) + obs.confidence;
        }
      }

      let bestChar = '';
      let bestScore = -1;
      for (const [char, score] of Object.entries(charScores)) {
        if (score > bestScore) {
          bestScore = score;
          bestChar = char;
        }
      }
      resultChars.push(bestChar || sorted[0].plateText[i] || '?');
    }

    return resultChars.join('');
  }

  /**
   * Ingests a raw plate detection into the temporal tracker and updates vehicle observation sessions.
   */
  public async processDetection(raw: RawPlateDetection): Promise<AggregatedPlateResult> {
    const timestamp = raw.timestamp || new Date();
    const trackKey = `${raw.tenantId}_${raw.cameraId}_${raw.trackId || raw.plateText.slice(0, 6)}`;

    let track = this.activeTracks.get(trackKey);
    if (!track) {
      track = {
        tenantId: raw.tenantId,
        cameraId: raw.cameraId,
        trackId: raw.trackId || `track_${Date.now()}`,
        observations: [],
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        bestConfidence: raw.confidence,
        bestSnapshotPath: raw.snapshotPath,
        categoryVotes: new Map(),
      };
      this.activeTracks.set(trackKey, track);
    }

    // Accumulate observation
    track.observations.push(raw);
    track.lastSeenAt = timestamp;
    if (raw.confidence > track.bestConfidence) {
      track.bestConfidence = raw.confidence;
      if (raw.snapshotPath) track.bestSnapshotPath = raw.snapshotPath;
    }

    // Category vote
    const cat = raw.vehicleCategory || VehicleCategory.FOUR_WHEELER;
    track.categoryVotes.set(cat, (track.categoryVotes.get(cat) || 0) + 1);

    // Determine consensus
    const consensusRaw = PlateTrackAggregatorService.voteConsensus(track.observations);
    const { normalizedPlate, stateCode } = PlateTrackAggregatorService.normalizeIndianPlate(consensusRaw);

    // Resolve majority vehicle category
    let majorityCategory: VehicleCategory = VehicleCategory.FOUR_WHEELER;
    let maxVotes = -1;
    for (const [vCat, votes] of track.categoryVotes.entries()) {
      if (votes > maxVotes) {
        maxVotes = votes;
        majorityCategory = vCat;
      }
    }

    // Check against Watchlist
    const watchlistEntry = await this.prisma.vehicleWatchlist.findFirst({
      where: {
        tenantId: raw.tenantId,
        normalizedPlate,
        active: true,
      },
    });

    // Create or update VehicleObservation session record (deduplication invariant)
    if (!track.vehicleObservationId) {
      const created = await this.prisma.vehicleObservation.create({
        data: {
          tenantId: raw.tenantId,
          cameraId: raw.cameraId,
          trackId: track.trackId,
          plateNumber: consensusRaw,
          normalizedPlate,
          stateCode,
          vehicleCategory: majorityCategory,
          firstSeenAt: track.firstSeenAt,
          lastSeenAt: track.lastSeenAt,
          observationCount: track.observations.length,
          bestConfidence: track.bestConfidence,
          bestSnapshotPath: track.bestSnapshotPath,
          matchedWatchlistId: watchlistEntry ? watchlistEntry.id : undefined,
        },
      });
      track.vehicleObservationId = created.id;

      // Trigger Alarm if watchlist entry matches and alert is requested
      if (watchlistEntry && watchlistEntry.alertOnMatch) {
        await this.triggerWatchlistAlarm(raw.tenantId, raw.cameraId, normalizedPlate, watchlistEntry, track.bestSnapshotPath);
      }
    } else {
      await this.prisma.vehicleObservation.update({
        where: { id: track.vehicleObservationId },
        data: {
          plateNumber: consensusRaw,
          normalizedPlate,
          stateCode,
          vehicleCategory: majorityCategory,
          lastSeenAt: track.lastSeenAt,
          observationCount: track.observations.length,
          bestConfidence: track.bestConfidence,
          bestSnapshotPath: track.bestSnapshotPath,
          matchedWatchlistId: watchlistEntry ? watchlistEntry.id : undefined,
        },
      });
    }

    return {
      plateNumber: consensusRaw,
      normalizedPlate,
      stateCode,
      vehicleCategory: majorityCategory,
      confidence: track.bestConfidence,
      bestSnapshotPath: track.bestSnapshotPath,
      matchedWatchlist: watchlistEntry
        ? {
            id: watchlistEntry.id,
            category: watchlistEntry.category,
            notes: watchlistEntry.notes,
            ownerName: watchlistEntry.ownerName,
          }
        : null,
    };
  }

  private async triggerWatchlistAlarm(
    tenantId: string,
    cameraId: string,
    plate: string,
    watchlist: any,
    snapshotPath?: string
  ): Promise<void> {
    try {
      const isCritical = watchlist.category === WatchlistCategory.BLACKLIST || watchlist.category === WatchlistCategory.SUSPECT;
      const severity = isCritical ? EventSeverity.CRITICAL : watchlist.severity || EventSeverity.WARNING;

      await alarmService.createAlarm({
        tenantId,
        cameraId,
        title: `WATCHLIST ALERT: ${watchlist.category} Vehicle [${plate}] Detected`,
        description: `Vehicle plate ${plate} on ${watchlist.category} list detected on camera feed. Notes: ${watchlist.notes || 'No notes'}`,
        severity,
        metadataJson: {
          plateNumber: plate,
          watchlistCategory: watchlist.category,
          ownerName: watchlist.ownerName,
          snapshotPath,
        },
      });
    } catch (err: any) {
      console.error('[PlateTrackAggregator] Failed to trigger watchlist alarm:', err.message);
    }
  }

  /**
   * Cleans up expired tracks after operator cooldown
   */
  private evictStaleTracks(): void {
    const now = Date.now();
    for (const [key, track] of this.activeTracks.entries()) {
      if (now - track.lastSeenAt.getTime() > this.sessionCooldownMs) {
        this.activeTracks.delete(key);
      }
    }
  }
}

export default PlateTrackAggregatorService;
