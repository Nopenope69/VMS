/**
 * Temporal redaction masks from sampled detections (P4.4).
 *
 * Detections come from frames sampled at `fps`. Every detection is expanded by a margin and held
 * for one sample interval before and after its timestamp. Detections of the same kind in
 * consecutive samples that overlap or lie close together are linked, and the union of both boxes
 * covers the interval between them, so a moving face or plate stays covered between samples.
 * Masks of one track whose boxes barely change are merged to keep the ffmpeg filter small.
 * All of this errs towards covering more.
 */
export type RegionKind = 'FACE' | 'LICENSE_PLATE' | 'MANUAL';

export interface SampledDetection {
  kind: Exclude<RegionKind, 'MANUAL'>;
  /** Seconds from the start of the clip. */
  t: number;
  /** [x1, y1, x2, y2] in pixels. */
  box: [number, number, number, number];
  score: number;
}

export interface PlannedMask {
  kind: RegionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  startSec: number;
  endSec: number;
  track?: number;
}

export interface PlanOptions {
  fps: number;
  durationSec: number;
  frameWidth: number;
  frameHeight: number;
  /** Box growth per side, as a fraction of the box size. */
  margin: number;
  /** Merge consecutive masks of one track when the union area is at most this factor of the larger box. */
  mergeAreaFactor: number;
}

type Box = [number, number, number, number];

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

function linked(a: Box, b: Box): boolean {
  const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (ix > 0 && iy > 0) return true;
  const ca = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2];
  const cb = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const size = Math.max(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1]);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) <= 1.5 * size;
}

export function planMasks(dets: SampledDetection[], o: PlanOptions): PlannedMask[] {
  const step = 1 / o.fps;
  const grow = (b: Box): Box => {
    const mx = (b[2] - b[0]) * o.margin;
    const my = (b[3] - b[1]) * o.margin;
    return [Math.max(0, b[0] - mx), Math.max(0, b[1] - my), Math.min(o.frameWidth, b[2] + mx), Math.min(o.frameHeight, b[3] + my)];
  };
  const clampT = (t: number) => Math.max(0, Math.min(o.durationSec, t));

  // Group by kind and sample time.
  const out: PlannedMask[] = [];
  for (const kind of ['FACE', 'LICENSE_PLATE'] as const) {
    const byT = new Map<number, Array<{ box: Box; track: number }>>();
    const times = [...new Set(dets.filter((d) => d.kind === kind).map((d) => d.t))].sort((a, b) => a - b);
    let nextTrack = 0;
    let prevT: number | null = null;
    const pieces: Array<{ track: number; box: Box; start: number; end: number }> = [];
    for (const t of times) {
      const cur = dets.filter((d) => d.kind === kind && d.t === t).map((d) => ({ box: grow(d.box), track: -1 }));
      const prev = prevT !== null && t - prevT <= step * 1.5 ? byT.get(prevT)! : [];
      const taken = new Set<number>();
      for (const c of cur) {
        let best = -1;
        let bestArea = Infinity;
        prev.forEach((p, i) => {
          if (taken.has(i) || !linked(p.box, c.box)) return;
          const u = area(union(p.box, c.box));
          if (u < bestArea) {
            bestArea = u;
            best = i;
          }
        });
        if (best >= 0) {
          taken.add(best);
          c.track = prev[best].track;
          pieces.push({ track: c.track, box: union(prev[best].box, c.box), start: prevT!, end: t });
        } else c.track = nextTrack++;
        pieces.push({ track: c.track, box: c.box, start: clampT(t - step), end: clampT(t + step) });
      }
      byT.set(t, cur);
      prevT = t;
    }
    // Merge per track: pieces sorted by start; extend while the union stays compact.
    const tracks = new Map<number, typeof pieces>();
    for (const p of pieces) tracks.set(p.track, [...(tracks.get(p.track) || []), p]);
    for (const [track, ps] of tracks) {
      ps.sort((a, b) => a.start - b.start || a.end - b.end);
      let cur = { ...ps[0] };
      for (const p of ps.slice(1)) {
        const u = union(cur.box, p.box);
        if (p.start <= cur.end + 1e-9 && area(u) <= o.mergeAreaFactor * Math.max(area(cur.box), area(p.box))) {
          cur = { track, box: u, start: Math.min(cur.start, p.start), end: Math.max(cur.end, p.end) };
        } else {
          out.push(toMask(kind, cur));
          cur = { ...p };
        }
      }
      out.push(toMask(kind, cur));
    }
  }
  return out;
}

function toMask(kind: RegionKind, p: { track: number; box: Box; start: number; end: number }): PlannedMask {
  const x = Math.floor(p.box[0]);
  const y = Math.floor(p.box[1]);
  return { kind, x, y, width: Math.ceil(p.box[2]) - x, height: Math.ceil(p.box[3]) - y, startSec: p.start, endSec: p.end, track: p.track };
}

/**
 * ffmpeg filter for the masks: an opaque filled box per mask. Solid fills are used for every kind
 * because a blur of a plate or face can often be reversed or read; a filled box cannot.
 * Coordinates are clamped to the frame; times are printed with millisecond precision.
 */
export function buildMaskFilter(masks: PlannedMask[], frameWidth: number, frameHeight: number): string {
  if (masks.length === 0) return 'null';
  return masks
    .map((m) => {
      const x = Math.max(0, Math.min(frameWidth - 1, m.x));
      const y = Math.max(0, Math.min(frameHeight - 1, m.y));
      const w = Math.max(1, Math.min(frameWidth - x, m.width));
      const h = Math.max(1, Math.min(frameHeight - y, m.height));
      // Rounded outwards so a mask never becomes shorter than planned.
      const a = (Math.floor(Math.max(0, m.startSec) * 1000) / 1000).toFixed(3);
      const b = (Math.ceil(Math.max(m.startSec, m.endSec) * 1000) / 1000).toFixed(3);
      return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1.0:t=fill:enable='between(t,${a},${b})'`;
    })
    .join(',\n');
}
