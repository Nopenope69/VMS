/**
 * Pure rules of the track index (no database): how one confirmed-track detection updates a track's summary.
 * trackIndex.service.ts applies them under a row lock. Coordinates are normalised to the source image (0..1).
 */
import { SpatialGeometry, Point2D } from '../spatial/engine';

export interface PathPoint {
  /** Epoch milliseconds. */
  t: number;
  x: number;
  y: number;
}

export interface ZoneVisit {
  zoneId: string;
  name: string;
  enteredAt: string;
  exitedAt: string;
}

export interface ZoneDef {
  id: string;
  name: string;
  polygon: Point2D[];
}

export type Votes = Record<string, number>;

export interface ColourVotes {
  upper: Votes;
  lower: Votes;
  body: Votes;
  /** Detections whose frame was monochrome (IR), so they carried no colour names. */
  monochrome: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A new path point is kept when this much time has passed since the previous kept point... */
export const PATH_MIN_INTERVAL_MS = 1000;
/** ...or the object moved this far (normalised). Otherwise the newest point only replaces the last one. */
export const PATH_MIN_DISTANCE = 0.03;
/** At most this many points; beyond it every second inner point is dropped (first and last always stay). */
export const PATH_MAX_POINTS = 120;
/** Net movement below this (normalised) from first to last point is STATIONARY. */
export const STATIONARY_DISTANCE = 0.05;
/** A gap shorter than this inside a zone continues the same visit. */
export const ZONE_GAP_MS = 5000;
export const MAX_ZONE_VISITS = 50;
/** A region's colour is reported when it has this many votes and the leading colour has at least this share. */
export const COLOUR_MIN_VOTES = 2;
export const COLOUR_MIN_SHARE = 0.5;

export const COLOUR_NAMES = ['black', 'white', 'grey', 'red', 'orange', 'brown', 'yellow', 'green', 'blue', 'purple', 'pink'] as const;
export const DIRECTIONS = ['UP', 'UP_RIGHT', 'RIGHT', 'DOWN_RIGHT', 'DOWN', 'DOWN_LEFT', 'LEFT', 'UP_LEFT', 'STATIONARY'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Where the object touches the ground in the image: the bottom centre of its box. Zones are tested with it. */
export function groundPoint(b: Box): { x: number; y: number } {
  return { x: round4(b.x + b.width / 2), y: round4(Math.min(1, b.y + b.height)) };
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Adds an observation to a thinned path. All points but the last are fixed waypoints; the last is the track's
 * current end and moves with every observation. When the current end is far enough (in time or space) from the
 * last waypoint, it becomes a waypoint and the new observation becomes the end. Out-of-order points are ignored.
 */
export function appendPath(path: PathPoint[], p: PathPoint): PathPoint[] {
  const out = path.slice();
  const end = out[out.length - 1];
  if (!end) return [p];
  if (p.t <= end.t) return out;
  if (out.length === 1) {
    out.push(p);
  } else {
    const waypoint = out[out.length - 2];
    if (end.t - waypoint.t >= PATH_MIN_INTERVAL_MS || dist(end, waypoint) >= PATH_MIN_DISTANCE) out.push(p);
    else out[out.length - 1] = p;
  }
  return out.length > PATH_MAX_POINTS ? thin(out) : out;
}

function thin(path: PathPoint[]): PathPoint[] {
  const inner = path.slice(1, -1).filter((_, i) => i % 2 === 1);
  return [path[0], ...inner, path[path.length - 1]];
}

/** Overall movement in the image, from the first to the last path point (y grows downwards). */
export function directionOf(path: PathPoint[]): Direction | null {
  if (path.length < 2) return null;
  const a = path[0];
  const b = path[path.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < STATIONARY_DISTANCE) return 'STATIONARY';
  // 0 degrees = right, counter-clockwise with "up" as the image's top.
  const deg = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
  const sector = Math.round(deg / 45) % 8;
  return (['RIGHT', 'UP_RIGHT', 'UP', 'UP_LEFT', 'LEFT', 'DOWN_LEFT', 'DOWN', 'DOWN_RIGHT'] as const)[sector];
}

/** Zones whose polygon contains the point. */
export function zonesAt(point: { x: number; y: number }, zones: ZoneDef[]): ZoneDef[] {
  return zones.filter((z) => z.polygon.length >= 3 && SpatialGeometry.isPointInPolygon(point, z.polygon));
}

/** Extends the open visit of each zone the object is in, or opens a new one. Visits beyond the cap are dropped. */
export function updateZoneVisits(visits: ZoneVisit[], inZones: ZoneDef[], at: Date): ZoneVisit[] {
  const out = visits.map((v) => ({ ...v }));
  const iso = at.toISOString();
  for (const z of inZones) {
    let open: ZoneVisit | undefined;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].zoneId === z.id) {
        open = out[i];
        break;
      }
    }
    if (open && at.getTime() - Date.parse(open.exitedAt) <= ZONE_GAP_MS) {
      if (at.getTime() > Date.parse(open.exitedAt)) open.exitedAt = iso;
    } else if (out.length < MAX_ZONE_VISITS) {
      out.push({ zoneId: z.id, name: z.name, enteredAt: iso, exitedAt: iso });
    }
  }
  return out;
}

export function addVote(votes: Votes, key: string): Votes {
  return { ...votes, [key]: (votes[key] || 0) + 1 };
}

/** The leading key, or null when there are too few votes or no clear leader. */
export function majority(votes: Votes, minVotes = 1, minShare = 0): string | null {
  const entries = Object.entries(votes);
  const total = entries.reduce((n, [, c]) => n + c, 0);
  if (total < minVotes || entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [key, count] = entries[0];
  if (entries.length > 1 && entries[1][1] === count) return null; // a tie is not a colour
  return count / total >= minShare ? key : null;
}

/** The worker's colour attributes, if they are well formed (anything else is ignored, never stored). */
export function parseColour(attributes: unknown): { monochrome: boolean; upper?: string; lower?: string; body?: string } | null {
  const c = (attributes as any)?.colour;
  if (!c || typeof c !== 'object' || typeof c.monochrome !== 'boolean') return null;
  const ok = (v: unknown) => (typeof v === 'string' && (COLOUR_NAMES as readonly string[]).includes(v) ? v : undefined);
  return { monochrome: c.monochrome, upper: ok(c.upper), lower: ok(c.lower), body: ok(c.body) };
}

export function addColourVotes(v: ColourVotes, c: ReturnType<typeof parseColour>): ColourVotes {
  if (!c) return v;
  if (c.monochrome) return { ...v, monochrome: v.monochrome + 1 };
  return {
    upper: c.upper ? addVote(v.upper, c.upper) : v.upper,
    lower: c.lower ? addVote(v.lower, c.lower) : v.lower,
    body: c.body ? addVote(v.body, c.body) : v.body,
    monochrome: v.monochrome,
  };
}

export const emptyColourVotes = (): ColourVotes => ({ upper: {}, lower: {}, body: {}, monochrome: 0 });

export const colourOf = (votes: Votes) => majority(votes, COLOUR_MIN_VOTES, COLOUR_MIN_SHARE);

/** Is the centre of `inner` inside `outer`? Used to tie a plate to the vehicle box that contains it. */
export function centreInside(inner: Box, outer: Box): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height;
}
