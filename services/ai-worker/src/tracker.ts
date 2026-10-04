import crypto from 'crypto';
import { TrackState, TrackedObject, NormalizedDetectionEvent } from './types';

export interface MultiObjectTrackerConfig {
  iouThreshold?: number; // default: 0.3
  minHitsToConfirm?: number; // default: 2
  maxLostFrames?: number; // default: 3
  maxActiveTracks?: number; // default: 50
  maxTrajectoryPoints?: number; // default: 30
}

export interface TrackerDetectionInput {
  box: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  centroid?: {
    x: number;
    y: number;
  };
  label?: string;
  type?: string;
  classId?: number;
  confidence?: number;
  attributesJson?: Record<string, any>;
}

export interface TrackerStats {
  evictions: number;
  capacityDrops: number;
}

/**
 * Normalizes detection/track class string to canonical category ('person', 'vehicle', etc.)
 * Strictly enforces class-scoped separation.
 */
export function normalizeTrackClass(labelOrType?: string): string {
  const lower = (labelOrType || '').toLowerCase();
  if (lower.includes('person') || lower.includes('human') || lower.includes('pedestrian')) {
    return 'person';
  }
  if (
    lower.includes('vehicle') ||
    lower.includes('car') ||
    lower.includes('truck') ||
    lower.includes('bus') ||
    lower.includes('motorcycle') ||
    lower.includes('bicycle')
  ) {
    return 'vehicle';
  }
  // A carried object can read as a backpack in one frame and a handbag in the next; keep one track.
  if (lower.includes('backpack') || lower.includes('handbag') || lower.includes('suitcase') || lower === 'bag') {
    return 'bag';
  }
  return lower || 'unknown';
}

/**
 * Computes standard 2D Intersection over Union (IoU) between two bounding boxes.
 */
export function computeIoU(
  boxA: { x: number; y: number; width: number; height: number },
  boxB: { x: number; y: number; width: number; height: number }
): number {
  const xA = Math.max(boxA.x, boxB.x);
  const yA = Math.max(boxA.y, boxB.y);
  const xB = Math.min(boxA.x + boxA.width, boxB.x + boxB.width);
  const yB = Math.min(boxA.y + boxA.height, boxB.y + boxB.height);

  const interWidth = Math.max(0, xB - xA);
  const interHeight = Math.max(0, yB - yA);
  const interArea = interWidth * interHeight;

  const boxAArea = boxA.width * boxA.height;
  const boxBArea = boxB.width * boxB.height;
  const unionArea = boxAArea + boxBArea - interArea;

  if (unionArea <= 0) return 0;
  return interArea / unionArea;
}

/**
 * Stateful, camera-isolated Multi-Object Tracking (MOT) engine.
 * 
 * Strict Technical Invariants:
 * 1. Class-Scoped Association: Person never matches vehicle, vehicle never matches person.
 * 2. Deterministic 4-State Lifecycle: TENTATIVE -> CONFIRMED -> LOST -> TERMINATED.
 * 3. Constant-Velocity Projection: Predicted box uses velocity * dt for association.
 * 4. Bounded Capacity (max 50 tracks): Eviction order TERMINATED -> LOST -> TENTATIVE.
 *    CONFIRMED tracks are never evicted for capacity; new candidates dropped if full.
 * 5. Bounded Trajectory: Chronologically capped at max 30 points.
 */
export class MultiObjectTracker {
  private readonly iouThreshold: number;
  private readonly minHitsToConfirm: number;
  private readonly maxLostFrames: number;
  private readonly maxActiveTracks: number;
  private readonly maxTrajectoryPoints: number;

  private tracks: Map<string, TrackedObject> = new Map();
  private stats: TrackerStats = {
    evictions: 0,
    capacityDrops: 0,
  };

  constructor(config?: MultiObjectTrackerConfig) {
    this.iouThreshold = config?.iouThreshold ?? 0.3;
    this.minHitsToConfirm = config?.minHitsToConfirm ?? 2;
    this.maxLostFrames = config?.maxLostFrames ?? 3;
    this.maxActiveTracks = config?.maxActiveTracks ?? 50;
    this.maxTrajectoryPoints = config?.maxTrajectoryPoints ?? 30;
  }

  /**
   * Projects track bounding box at currentTime using constant-velocity model.
   */
  public predictBox(
    track: TrackedObject,
    dtSeconds: number
  ): { x: number; y: number; width: number; height: number } {
    if (dtSeconds <= 0 || (track.velocity.vx === 0 && track.velocity.vy === 0)) {
      return { ...track.box };
    }

    return {
      x: +(track.box.x + track.velocity.vx * dtSeconds).toFixed(4),
      y: +(track.box.y + track.velocity.vy * dtSeconds).toFixed(4),
      width: track.box.width,
      height: track.box.height,
    };
  }

  /**
   * Normalizes incoming detection into standard TrackerDetectionInput.
   */
  private normalizeInput(
    det: TrackerDetectionInput | NormalizedDetectionEvent
  ): TrackerDetectionInput {
    if ('boundingBox' in det) {
      return {
        box: det.boundingBox,
        centroid: det.centroid,
        label: (det as any).attributesJson?.rawLabel || det.type,
        type: det.type,
        classId: (det as any).attributesJson?.rawClassId ?? 0,
        confidence: det.confidence,
        attributesJson: det.attributesJson,
      };
    }
    return det;
  }

  /**
   * Updates tracking state for the current frame.
   * 
   * @param rawDetections Array of detections in current frame
   * @param frameTimestamp Timestamp of current observation frame
   * @returns Array of all active (non-terminated) TrackedObjects
   */
  public update(
    rawDetections: Array<TrackerDetectionInput | NormalizedDetectionEvent>,
    frameTimestamp: Date = new Date()
  ): TrackedObject[] {
    const detections = rawDetections.map((d) => this.normalizeInput(d));
    const activeTracks = Array.from(this.tracks.values()).filter(
      (t) => t.state !== 'TERMINATED'
    );

    // 1. Predict position of all active tracks
    const trackPredictions = new Map<
      string,
      { x: number; y: number; width: number; height: number }
    >();

    for (const track of activeTracks) {
      const dt = (frameTimestamp.getTime() - track.lastSeenAt.getTime()) / 1000;
      trackPredictions.set(track.trackId, this.predictBox(track, Math.max(0, dt)));
    }

    // 2. Class-scoped bipartite association
    // Compute IoU candidate pairs strictly within identical canonical classes
    interface CandidateMatch {
      detIndex: number;
      trackId: string;
      iou: number;
    }

    const candidateMatches: CandidateMatch[] = [];

    for (let d = 0; d < detections.length; d++) {
      const det = detections[d];
      const detClass = normalizeTrackClass(det.label || det.type);

      for (const track of activeTracks) {
        const trackClass = normalizeTrackClass(track.label);

        // HARD INVARIANT 1.1: Class-Scoped Association
        // Cross-class matching is strictly impossible (cost = Infinity)
        if (detClass !== trackClass) {
          continue;
        }

        const predictedBox = trackPredictions.get(track.trackId)!;
        const iou = computeIoU(det.box, predictedBox);

        if (iou >= this.iouThreshold) {
          candidateMatches.push({
            detIndex: d,
            trackId: track.trackId,
            iou,
          });
        }
      }
    }

    // Sort candidate matches deterministically: highest IoU first, tie-break by trackId and detIndex
    candidateMatches.sort((a, b) => {
      if (Math.abs(b.iou - a.iou) > 1e-6) {
        return b.iou - a.iou;
      }
      if (a.trackId !== b.trackId) {
        return a.trackId.localeCompare(b.trackId);
      }
      return a.detIndex - b.detIndex;
    });

    // 3. Greedy assignment
    const matchedDetIndices = new Set<number>();
    const matchedTrackIds = new Set<string>();

    for (const match of candidateMatches) {
      if (matchedDetIndices.has(match.detIndex) || matchedTrackIds.has(match.trackId)) {
        continue;
      }

      matchedDetIndices.add(match.detIndex);
      matchedTrackIds.add(match.trackId);

      const det = detections[match.detIndex];
      const track = this.tracks.get(match.trackId)!;

      // Calculate centroid
      const centroid = det.centroid || {
        x: +(det.box.x + det.box.width / 2).toFixed(4),
        y: +(det.box.y + det.box.height / 2).toFixed(4),
      };

      // Calculate velocity: vx = dx / dt, vy = dy / dt using actual observation delta
      const lastObs = track.trajectory[track.trajectory.length - 1];
      const dt = lastObs
        ? (frameTimestamp.getTime() - lastObs.timestamp.getTime()) / 1000
        : 0;

      if (dt > 0 && lastObs) {
        track.velocity = {
          vx: +((centroid.x - lastObs.x) / dt).toFixed(4),
          vy: +((centroid.y - lastObs.y) / dt).toFixed(4),
        };
      } else {
        track.velocity = { vx: 0, vy: 0 };
      }

      // Update box and centroid
      track.box = { ...det.box };
      track.centroid = centroid;
      track.hits += 1;
      track.consecutiveHits += 1;
      track.lostFrames = 0;
      track.lastSeenAt = frameTimestamp;

      // Add to trajectory (bounded at maxTrajectoryPoints)
      track.trajectory.push({
        x: centroid.x,
        y: centroid.y,
        timestamp: frameTimestamp,
      });
      if (track.trajectory.length > this.maxTrajectoryPoints) {
        track.trajectory.shift();
      }

      // State transitions on hit:
      // TENTATIVE -> CONFIRMED if consecutiveHits >= minHitsToConfirm
      if (track.state === 'TENTATIVE' && track.consecutiveHits >= this.minHitsToConfirm) {
        track.state = 'CONFIRMED';
      } else if (track.state === 'LOST') {
        // Recovery of lost track preserves persistent trackId!
        track.state = 'CONFIRMED';
      }

      // If input detection object is NormalizedDetectionEvent or has trackId/trackState properties, attach tracking metadata
      const rawDet = rawDetections[match.detIndex] as any;
      if (rawDet) {
        rawDet.trackId = track.trackId;
        rawDet.trackState = track.state;
        rawDet.velocity = { ...track.velocity };
        rawDet.centroid = { ...track.centroid };
      }
    }

    // 4. Update unmatched active tracks (missed frame)
    for (const track of activeTracks) {
      if (!matchedTrackIds.has(track.trackId)) {
        track.lostFrames += 1;
        track.consecutiveHits = 0;

        if (track.state === 'CONFIRMED') {
          track.state = 'LOST';
        } else if (track.state === 'TENTATIVE') {
          // Missed tentative track moves to LOST
          track.state = 'LOST';
        }

        // Expire track if lost beyond maxLostFrames
        if (track.lostFrames > this.maxLostFrames) {
          track.state = 'TERMINATED';
        }
      }
    }

    // 5. Create new tracks for unmatched detections
    for (let d = 0; d < detections.length; d++) {
      if (matchedDetIndices.has(d)) continue;

      const det = detections[d];
      const centroid = det.centroid || {
        x: +(det.box.x + det.box.width / 2).toFixed(4),
        y: +(det.box.y + det.box.height / 2).toFixed(4),
      };

      // Check capacity and attempt hierarchical eviction if needed
      const canCreate = this.ensureCapacityForNewTrack();
      if (!canCreate) {
        this.stats.capacityDrops++;
        const rawDet = rawDetections[d] as any;
        if (rawDet) {
          rawDet.trackId = undefined;
          rawDet.trackState = undefined;
        }
        continue;
      }

      const newTrack: TrackedObject = {
        trackId: crypto.randomUUID(),
        classId: det.classId ?? 0,
        label: normalizeTrackClass(det.label || det.type),
        state: 'TENTATIVE',
        box: { ...det.box },
        centroid,
        velocity: { vx: 0, vy: 0 },
        trajectory: [
          {
            x: centroid.x,
            y: centroid.y,
            timestamp: frameTimestamp,
          },
        ],
        hits: 1,
        consecutiveHits: 1,
        lostFrames: 0,
        firstSeenAt: frameTimestamp,
        lastSeenAt: frameTimestamp,
      };

      // If minHitsToConfirm is 1, immediately promote to CONFIRMED
      if (newTrack.consecutiveHits >= this.minHitsToConfirm) {
        newTrack.state = 'CONFIRMED';
      }

      this.tracks.set(newTrack.trackId, newTrack);

      const rawDet = rawDetections[d] as any;
      if (rawDet) {
        rawDet.trackId = newTrack.trackId;
        rawDet.trackState = newTrack.state;
        rawDet.velocity = { ...newTrack.velocity };
        rawDet.centroid = { ...newTrack.centroid };
      }
    }

    // 6. Purge TERMINATED tracks from active tracker memory
    for (const [id, track] of this.tracks.entries()) {
      if (track.state === 'TERMINATED') {
        this.tracks.delete(id);
      }
    }

    return Array.from(this.tracks.values());
  }

  /**
   * Tracks incoming normalized detection events, attaching persistent trackId,
   * trackState, centroid, and velocity in-place.
   */
  public trackDetections(
    events: NormalizedDetectionEvent[],
    frameTimestamp: Date = new Date()
  ): NormalizedDetectionEvent[] {
    this.update(events, frameTimestamp);
    return events;
  }

  /**
   * Enforces bounded capacity with strict eviction order:
   * 1. TERMINATED
   * 2. LOST
   * 3. TENTATIVE
   * 
   * CONFIRMED tracks are NEVER evicted for capacity.
   * If all active slots are occupied by CONFIRMED tracks, returns false (drop candidate).
   */
  private ensureCapacityForNewTrack(): boolean {
    if (this.tracks.size < this.maxActiveTracks) {
      return true;
    }

    const allTracks = Array.from(this.tracks.values());

    // 1. Try TERMINATED
    const terminated = allTracks.find((t) => t.state === 'TERMINATED');
    if (terminated) {
      this.tracks.delete(terminated.trackId);
      this.stats.evictions++;
      return true;
    }

    // 2. Try LOST (oldest first by lastSeenAt, then highest lostFrames)
    const lostTracks = allTracks.filter((t) => t.state === 'LOST');
    if (lostTracks.length > 0) {
      lostTracks.sort((a, b) => {
        if (b.lostFrames !== a.lostFrames) {
          return b.lostFrames - a.lostFrames;
        }
        return a.lastSeenAt.getTime() - b.lastSeenAt.getTime();
      });
      this.tracks.delete(lostTracks[0].trackId);
      this.stats.evictions++;
      return true;
    }

    // 3. Try TENTATIVE (oldest first by firstSeenAt)
    const tentativeTracks = allTracks.filter((t) => t.state === 'TENTATIVE');
    if (tentativeTracks.length > 0) {
      tentativeTracks.sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
      this.tracks.delete(tentativeTracks[0].trackId);
      this.stats.evictions++;
      return true;
    }

    // 4. All tracks are CONFIRMED: DO NOT EVICT!
    return false;
  }

  /**
   * Returns all active tracks currently in tracker memory.
   */
  public getTracks(): TrackedObject[] {
    return Array.from(this.tracks.values());
  }

  /**
   * Returns only CONFIRMED tracks currently in tracker memory.
   */
  public getConfirmedTracks(): TrackedObject[] {
    return Array.from(this.tracks.values()).filter((t) => t.state === 'CONFIRMED');
  }

  /**
   * Returns operational metrics for evictions and capacity drops.
   */
  public getStats(): TrackerStats {
    return { ...this.stats };
  }

  /**
   * Clears all tracks and resets operational counters.
   */
  public clear(): void {
    this.tracks.clear();
    this.stats = {
      evictions: 0,
      capacityDrops: 0,
    };
  }
}
