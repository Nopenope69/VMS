import { Point2D, SpatialGeometry } from './geometry';
import { Box } from './threatRules';

/**
 * Threat rules that read a person's body pose (17 COCO keypoints from the ai-worker, normalised image coordinates):
 *
 *  - PERSON_DOWN: a person inside the zone goes from upright to lying and stays lying, hardly moving, for the rule's
 *    time. "A fall seen happening" (upright within the fall window before the first lying sample) is the strong alert.
 *    Optionally a separate, weaker alert for someone found lying who was never seen upright (`lyingStillSeconds`).
 *  - FENCE_CLIMB: a person at the fence base line raises a wrist above the fence-top line for the rule's time
 *    (CLIMBING), and later has their hips on the protected side of the base line after starting on the other side
 *    (CROSSED). One alert per track and stage.
 *
 * Honest limits, all deliberate:
 *  - Pose is a 2-D picture of a 3-D scene. Torso angle and "hand above the fence top" are read in the image, not in
 *    the world; camera height and angle change what they mean. The rules are advisory and tuned per camera.
 *  - Without usable keypoints (score below `minKeypointScore`) PERSON_DOWN falls back to the person's box shape
 *    (wide and short means lying) and says so (`basis: 'box'`); FENCE_CLIMB does nothing, because a box cannot show a
 *    raised hand (use a tripwire for plain line crossing).
 *  - "Feet off the ground" is not used: it needs depth the picture does not give.
 *  - State lives in memory, bounded and pruned. A restart forgets it.
 */

export const NUM_KEYPOINTS = 17;
export const KP = {
  nose: 0,
  leftShoulder: 5,
  rightShoulder: 6,
  leftWrist: 9,
  rightWrist: 10,
  leftHip: 11,
  rightHip: 12,
  leftAnkle: 15,
  rightAnkle: 16,
} as const;

export type Keypoint = [number, number, number]; // x, y (0..1 of the image), score (0..1)

/** The worker's `attributesJson.pose`, or null when it is missing or malformed (a bad pose is never half-used). */
export function parsePose(attributes: unknown): Keypoint[] | null {
  const pose = (attributes as any)?.pose;
  const kps = pose?.keypoints;
  if (!Array.isArray(kps) || kps.length !== NUM_KEYPOINTS) return null;
  for (const k of kps) {
    if (!Array.isArray(k) || k.length !== 3) return null;
    if (!k.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
    if (k[2] < 0 || k[2] > 1) return null;
  }
  return kps as Keypoint[];
}

const mid = (pts: Point2D[]): Point2D => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
const usable = (k: Keypoint, minScore: number) => k[2] >= minScore;
const pt = (k: Keypoint): Point2D => ({ x: k[0], y: k[1] });
const dist = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);

/** Centre of the keypoints that pass the score floor, or null if none does. */
function centreOf(kps: Keypoint[], idx: number[], minScore: number): Point2D | null {
  const ok = idx.map((i) => kps[i]).filter((k) => usable(k, minScore));
  return ok.length ? mid(ok.map(pt)) : null;
}

export type Posture = 'UPRIGHT' | 'LYING' | 'UNKNOWN';
export interface PostureReading {
  posture: Posture;
  basis: 'pose' | 'box' | 'none';
  /** Torso angle from vertical in degrees (pose basis only). */
  torsoAngle?: number;
}

export const LYING_ANGLE = 60;
export const UPRIGHT_ANGLE = 35;
export const DEFAULT_ASPECT = 16 / 9;
export const DEFAULT_MIN_SCORE = 0.3;

/**
 * Upright, lying or unknown from the torso (shoulder centre to hip centre). Dx is scaled by the image aspect so the
 * angle is read in pixels, not in normalised units. Between 35 and 60 degrees is UNKNOWN: bending, sitting, crouching.
 */
export function classifyPosture(kps: Keypoint[] | null, box: Box | null, opts: { minScore?: number; aspect?: number } = {}): PostureReading {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const aspect = opts.aspect ?? DEFAULT_ASPECT;
  if (kps) {
    const shoulders = centreOf(kps, [KP.leftShoulder, KP.rightShoulder], minScore);
    const hips = centreOf(kps, [KP.leftHip, KP.rightHip], minScore);
    if (shoulders && hips && dist(shoulders, hips) > 0.005) {
      const dx = Math.abs(hips.x - shoulders.x) * aspect;
      const dy = Math.abs(hips.y - shoulders.y);
      const angle = (Math.atan2(dx, dy) * 180) / Math.PI;
      const posture: Posture = angle >= LYING_ANGLE ? 'LYING' : angle <= UPRIGHT_ANGLE ? 'UPRIGHT' : 'UNKNOWN';
      return { posture, basis: 'pose', torsoAngle: Math.round(angle) };
    }
  }
  if (box && box.width > 0 && box.height > 0) {
    const ratio = (box.width * aspect) / box.height;
    if (ratio >= 1.3) return { posture: 'LYING', basis: 'box' };
    if (ratio <= 0.6) return { posture: 'UPRIGHT', basis: 'box' };
  }
  return { posture: 'UNKNOWN', basis: 'none' };
}

// ----------------------------------------------------------------------------------------------- person down

export interface PersonDownRuleInput {
  id: string;
  polygon: Point2D[];
  /** Lying for this long (after a seen fall) raises the alert. */
  lyingSeconds: number;
  /** Upright this recently before the first lying sample counts as a fall seen happening. Default 3. */
  fallWindowSeconds?: number;
  /** 0 = off. Otherwise found lying (never seen upright) and still for this long raises the weaker alert. Default 0. */
  lyingStillSeconds?: number;
  /** Movement beyond this (normalised) restarts the lying clock. Default 0.03. */
  stillTolerance?: number;
  minKeypointScore?: number;
  aspectRatio?: number;
}

export interface PersonDownResult {
  ruleId: string;
  trackId: string;
  kind: 'FALL' | 'LYING_STILL';
  lyingSeconds: number;
  basis: 'pose' | 'box';
  torsoAngle: number | null;
}

export const DEFAULT_FALL_WINDOW_S = 3;
export const DEFAULT_STILL_TOLERANCE = 0.03;
/** No sample for this long and the track's lying story starts over (pose arrives about twice a second). */
export const SAMPLE_GAP_MS = 10_000;
const STATE_TTL_MS = 5 * 60_000;
const MAX_STATES = 5000;

interface DownState {
  uprightAt: number | null;
  lyingSince: number | null;
  anchor: Point2D | null;
  observedFall: boolean;
  basis: 'pose' | 'box';
  torsoAngle: number | null;
  lastSample: number;
  alerted: Set<'FALL' | 'LYING_STILL'>;
}

export class PoseRuleLedger {
  private down = new Map<string, DownState>();
  private climbs = new Map<string, ClimbState>();

  evaluatePersonDown(
    rule: PersonDownRuleInput,
    trackId: string,
    reading: PostureReading,
    centroid: Point2D,
    atMs: number
  ): PersonDownResult | null {
    const key = `${rule.id}|${trackId}`;
    if (!SpatialGeometry.isPointInPolygon(centroid, rule.polygon)) {
      this.down.delete(key);
      return null;
    }
    let s = this.down.get(key);
    if (!s || atMs - s.lastSample > SAMPLE_GAP_MS) {
      s = { uprightAt: null, lyingSince: null, anchor: null, observedFall: false, basis: 'pose', torsoAngle: null, lastSample: atMs, alerted: new Set() };
      this.down.set(key, s);
    }
    s.lastSample = atMs;
    this.prune(atMs);

    if (reading.posture === 'UPRIGHT') {
      // Standing again: the story is over and a later fall alerts again.
      s.uprightAt = atMs;
      s.lyingSince = null;
      s.anchor = null;
      s.observedFall = false;
      s.alerted.clear();
      return null;
    }
    if (reading.posture === 'UNKNOWN') return null; // bending, sitting, a weak read: neither evidence nor a reset

    // LYING
    const tolerance = rule.stillTolerance ?? DEFAULT_STILL_TOLERANCE;
    if (s.lyingSince === null) {
      s.lyingSince = atMs;
      s.anchor = centroid;
      s.observedFall = s.uprightAt !== null && atMs - s.uprightAt <= (rule.fallWindowSeconds ?? DEFAULT_FALL_WINDOW_S) * 1000;
    } else if (s.anchor && dist(centroid, s.anchor) > tolerance) {
      s.lyingSince = atMs; // moving about: the still clock restarts (a seen fall stays seen)
      s.anchor = centroid;
    }
    s.basis = reading.basis === 'box' ? 'box' : 'pose';
    s.torsoAngle = reading.torsoAngle ?? null;

    const lyingMs = atMs - s.lyingSince;
    const stillSeconds = Math.round(lyingMs / 1000);
    if (s.observedFall && !s.alerted.has('FALL') && lyingMs >= rule.lyingSeconds * 1000) {
      s.alerted.add('FALL');
      return { ruleId: rule.id, trackId, kind: 'FALL', lyingSeconds: stillSeconds, basis: s.basis, torsoAngle: s.torsoAngle };
    }
    const found = rule.lyingStillSeconds ?? 0;
    if (!s.observedFall && found > 0 && !s.alerted.has('LYING_STILL') && lyingMs >= found * 1000) {
      s.alerted.add('LYING_STILL');
      return { ruleId: rule.id, trackId, kind: 'LYING_STILL', lyingSeconds: stillSeconds, basis: s.basis, torsoAngle: s.torsoAngle };
    }
    return null;
  }

  // ----------------------------------------------------------------------------------------------- fence climb

  evaluateFenceClimb(rule: FenceClimbRuleInput, trackId: string, kps: Keypoint[] | null, centroid: Point2D, atMs: number): FenceClimbResult | null {
    const key = `${rule.id}|${trackId}`;
    if (!SpatialGeometry.isPointInPolygon(centroid, rule.polygon)) {
      this.climbs.delete(key);
      return null;
    }
    if (!kps) return null; // no pose, no climb: a box cannot show a raised hand
    const minScore = rule.minKeypointScore ?? DEFAULT_MIN_SCORE;
    const hips = centreOf(kps, [KP.leftHip, KP.rightHip], minScore);
    if (!hips) return null;

    let s = this.climbs.get(key);
    if (!s) {
      s = { climbingSince: null, climbedAt: null, startedOuter: false, lastSample: atMs, alerted: new Set() };
      this.climbs.set(key, s);
    }
    s.lastSample = atMs;
    this.prune(atMs);

    const near = distanceToSegment(hips, rule.base[0], rule.base[1]) <= (rule.nearDistance ?? DEFAULT_NEAR);
    const wrists = [kps[KP.leftWrist], kps[KP.rightWrist]].filter((k) => usable(k, minScore)).map(pt);
    const baseMid = mid([rule.base[0], rule.base[1]]);
    const topSideOfBase = sideOf(rule.top[0], rule.top[1], baseMid);
    // A wrist is above the fence top when it is on the far side of the top line from the base line.
    const handAboveTop = wrists.some((w) => sideOf(rule.top[0], rule.top[1], w) * topSideOfBase < 0);
    const protectedSign = rule.protectedSide === 'RIGHT' ? 1 : -1;
    const hipSide = sideOf(rule.base[0], rule.base[1], hips);
    const onProtectedSide = hipSide * protectedSign > 0;

    if (near && handAboveTop) {
      if (s.climbingSince === null) {
        s.climbingSince = atMs;
        s.startedOuter = !onProtectedSide;
      }
      s.climbedAt = atMs;
    } else if (s.climbingSince !== null && atMs - (s.climbedAt ?? atMs) > CLIMB_GAP_MS) {
      s.climbingSince = null; // hands came down and stayed down
    }

    if (s.climbingSince !== null && s.startedOuter && !s.alerted.has('CLIMBING') && atMs - s.climbingSince >= (rule.climbSeconds ?? DEFAULT_CLIMB_S) * 1000) {
      s.alerted.add('CLIMBING');
      return { ruleId: rule.id, trackId, stage: 'CLIMBING', climbSeconds: Math.round((atMs - s.climbingSince) / 100) / 10 };
    }
    if (
      s.climbedAt !== null &&
      s.startedOuter &&
      onProtectedSide &&
      !s.alerted.has('CROSSED') &&
      atMs - s.climbedAt <= (rule.maxClimbSeconds ?? DEFAULT_MAX_CLIMB_S) * 1000
    ) {
      s.alerted.add('CROSSED');
      return { ruleId: rule.id, trackId, stage: 'CROSSED', climbSeconds: s.climbingSince !== null ? Math.round((atMs - s.climbingSince) / 100) / 10 : 0 };
    }
    return null;
  }

  private prune(atMs: number): void {
    for (const m of [this.down, this.climbs] as Map<string, { lastSample: number }>[]) {
      if (m.size <= MAX_STATES) continue;
      for (const [k, v] of m) if (atMs - v.lastSample > STATE_TTL_MS) m.delete(k);
      while (m.size > MAX_STATES) m.delete(m.keys().next().value as string);
    }
  }

  sizes(): { down: number; climbs: number } {
    return { down: this.down.size, climbs: this.climbs.size };
  }

  clear(): void {
    this.down.clear();
    this.climbs.clear();
  }
}

// ----------------------------------------------------------------------------------------------- fence helpers

export interface FenceClimbRuleInput {
  id: string;
  /** Where the rule applies (around the fence). */
  polygon: Point2D[];
  /** The fence base line on the ground. */
  base: [Point2D, Point2D];
  /** The fence top, drawn along the top edge. */
  top: [Point2D, Point2D];
  /** Which side of the base line (looking from its first point to its second, on the picture) is protected. */
  protectedSide: 'LEFT' | 'RIGHT';
  climbSeconds?: number;
  nearDistance?: number;
  maxClimbSeconds?: number;
  minKeypointScore?: number;
}

export interface FenceClimbResult {
  ruleId: string;
  trackId: string;
  stage: 'CLIMBING' | 'CROSSED';
  climbSeconds: number;
}

interface ClimbState {
  climbingSince: number | null;
  climbedAt: number | null;
  startedOuter: boolean;
  lastSample: number;
  alerted: Set<'CLIMBING' | 'CROSSED'>;
}

export const DEFAULT_CLIMB_S = 1.5;
export const DEFAULT_NEAR = 0.08;
export const DEFAULT_MAX_CLIMB_S = 30;
/** Hands may drop out of view for this long without ending a climb (pose is sampled about twice a second). */
export const CLIMB_GAP_MS = 3000;

/** > 0 right of the directed line a to b on the picture (y down), < 0 left, 0 on it. */
export function sideOf(a: Point2D, b: Point2D, p: Point2D): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

export function distanceToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}
