import { Point2D, SpatialGeometry } from './geometry';

/**
 * Threat rules that need no new model, only the detector's tracks (normalised image coordinates, 0..1):
 *
 *  - UNATTENDED_OBJECT: a carried object (backpack, handbag, suitcase) stays still inside the zone, and no person
 *    is near it, for the rule's threshold. Moving the bag, or a person standing by it, restarts the clock. One
 *    alert per bag track.
 *  - WRONG_WAY: a track inside the zone travels at least `minTravel` against the zone's allowed direction (more
 *    than 120 degrees away from it). Travel the right way moves the reference point along, so a later U-turn is
 *    still caught. One alert per track.
 *
 * State lives in memory, bounded and pruned (like the tripwire and loitering ledger). A restart forgets it: a bag
 * already lying there starts a fresh clock.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UnattendedObjectRuleInput {
  id: string;
  polygon: Point2D[];
  thresholdSeconds: number;
  /** A person whose box is within this distance of the bag's centre attends it. Default 0.08. */
  ownerRadius?: number;
  /** The bag counts as still while it stays within this distance of where it settled. Default 0.02. */
  moveTolerance?: number;
}

export interface UnattendedObjectResult {
  ruleId: string;
  trackId: string;
  unattendedSeconds: number;
  stillSeconds: number;
}

export interface WrongWayRuleInput {
  id: string;
  polygon: Point2D[];
  /** The allowed direction, as an arrow from the first point to the second. */
  allowed: [Point2D, Point2D];
  /** Normalised distance a track must travel against the arrow. Default 0.08. */
  minTravel?: number;
}

export interface WrongWayResult {
  ruleId: string;
  trackId: string;
  angleDegrees: number;
  travel: number;
}

export const DEFAULT_OWNER_RADIUS = 0.08;
export const DEFAULT_MOVE_TOLERANCE = 0.02;
export const DEFAULT_MIN_TRAVEL = 0.08;
/** A person seen near the bag this recently still attends it (detections of one frame arrive one by one). */
export const ATTEND_GRACE_MS = 3000;
/** Wrong way: further than this from the allowed direction (cos 120 degrees). */
const WRONG_WAY_COS = -0.5;
const PERSON_TTL_MS = 10_000;
const STATE_TTL_MS = 5 * 60_000;
const MAX_STATES = 5000;
const MAX_PERSONS_PER_CAMERA = 500;

interface BagState {
  anchor: Point2D;
  stillSince: number;
  unattendedSince: number | null;
  lastSeen: number;
  alerted: boolean;
}

interface WayState {
  ref: Point2D;
  lastSeen: number;
  alerted: boolean;
}

const dist = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from a point to the nearest point of a box (0 inside it). */
export function distanceToBox(p: Point2D, b: Box): number {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
  return Math.hypot(dx, dy);
}

export class ThreatRuleLedger {
  private bags = new Map<string, BagState>();
  private ways = new Map<string, WayState>();
  /** Recent person boxes per camera, keyed by track id. */
  private persons = new Map<string, Map<string, { box: Box; at: number }>>();

  /** Records where a person is; the unattended-object rule asks who is near a bag. */
  notePerson(cameraId: string, trackId: string, box: Box, atMs: number): void {
    let cam = this.persons.get(cameraId);
    if (!cam) this.persons.set(cameraId, (cam = new Map()));
    cam.set(trackId, { box, at: atMs });
    if (cam.size > MAX_PERSONS_PER_CAMERA) {
      for (const [id, p] of cam) if (atMs - p.at > PERSON_TTL_MS) cam.delete(id);
      // Still full: drop the oldest.
      while (cam.size > MAX_PERSONS_PER_CAMERA) cam.delete(cam.keys().next().value as string);
    }
  }

  private personNear(cameraId: string, at: Point2D, radius: number, atMs: number): boolean {
    const cam = this.persons.get(cameraId);
    if (!cam) return false;
    for (const p of cam.values()) {
      if (Math.abs(atMs - p.at) <= ATTEND_GRACE_MS && distanceToBox(at, p.box) <= radius) return true;
    }
    return false;
  }

  evaluateUnattended(rule: UnattendedObjectRuleInput, cameraId: string, trackId: string, centre: Point2D, atMs: number): UnattendedObjectResult | null {
    const key = `${rule.id}|${trackId}`;
    if (!SpatialGeometry.isPointInPolygon(centre, rule.polygon)) {
      this.bags.delete(key);
      return null;
    }
    const tolerance = rule.moveTolerance ?? DEFAULT_MOVE_TOLERANCE;
    let s = this.bags.get(key);
    if (!s || dist(centre, s.anchor) > tolerance) {
      // New, or carried away from where it was: it settles here now (left again later, it alerts again).
      s = { anchor: centre, stillSince: atMs, unattendedSince: null, lastSeen: atMs, alerted: false };
      this.bags.set(key, s);
    }
    s.lastSeen = atMs;
    if (this.personNear(cameraId, centre, rule.ownerRadius ?? DEFAULT_OWNER_RADIUS, atMs)) {
      s.unattendedSince = null;
    } else if (s.unattendedSince === null) {
      s.unattendedSince = atMs;
    }
    this.prune(atMs);
    if (s.alerted || s.unattendedSince === null) return null;
    const unattendedMs = atMs - Math.max(s.unattendedSince, s.stillSince);
    if (unattendedMs < rule.thresholdSeconds * 1000) return null;
    s.alerted = true;
    return { ruleId: rule.id, trackId, unattendedSeconds: Math.round(unattendedMs / 1000), stillSeconds: Math.round((atMs - s.stillSince) / 1000) };
  }

  evaluateWrongWay(rule: WrongWayRuleInput, trackId: string, at: Point2D, atMs: number): WrongWayResult | null {
    const key = `${rule.id}|${trackId}`;
    if (!SpatialGeometry.isPointInPolygon(at, rule.polygon)) {
      this.ways.delete(key);
      return null;
    }
    let s = this.ways.get(key);
    if (!s) {
      this.ways.set(key, { ref: at, lastSeen: atMs, alerted: false });
      this.prune(atMs);
      return null;
    }
    s.lastSeen = atMs;
    const ax = rule.allowed[1].x - rule.allowed[0].x;
    const ay = rule.allowed[1].y - rule.allowed[0].y;
    const alen = Math.hypot(ax, ay);
    const dx = at.x - s.ref.x;
    const dy = at.y - s.ref.y;
    const travel = Math.hypot(dx, dy);
    if (alen === 0 || travel < (rule.minTravel ?? DEFAULT_MIN_TRAVEL)) return null;
    const cos = (dx * ax + dy * ay) / (travel * alen);
    if (cos > WRONG_WAY_COS) {
      // Not against the arrow: start measuring again from here.
      s.ref = at;
      return null;
    }
    if (s.alerted) return null;
    s.alerted = true;
    const angleDegrees = Math.round((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
    return { ruleId: rule.id, trackId, angleDegrees, travel: Math.round(travel * 1000) / 1000 };
  }

  private prune(atMs: number): void {
    for (const m of [this.bags, this.ways] as Map<string, { lastSeen: number }>[]) {
      if (m.size <= MAX_STATES) continue;
      for (const [k, v] of m) if (atMs - v.lastSeen > STATE_TTL_MS) m.delete(k);
      while (m.size > MAX_STATES) m.delete(m.keys().next().value as string);
    }
  }

  sizes(): { bags: number; ways: number; persons: number } {
    let persons = 0;
    for (const c of this.persons.values()) persons += c.size;
    return { bags: this.bags.size, ways: this.ways.size, persons };
  }

  clear(): void {
    this.bags.clear();
    this.ways.clear();
    this.persons.clear();
  }
}
