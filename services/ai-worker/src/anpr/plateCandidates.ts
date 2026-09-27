import type { TextBox } from './textDetector';

/**
 * Text-line boxes -> plate candidates. Lines too small or taller than wide are dropped;
 * two vertically stacked lines with overlapping x-extent and similar height form one
 * two-line candidate (Indian two-wheeler plates). Same rules as
 * tools/reference/anpr_reference.py group_candidates (golden-tested).
 */
export type Rect = [number, number, number, number]; // x1 y1 x2 y2

export interface PlateCandidate {
  box: Rect;
  lines: 1 | 2;
  lineBoxes: Rect[];
}

export function aabb(points: Array<[number, number]>): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function groupCandidates(boxes: TextBox[], minH = 8): PlateCandidate[] {
  const rects = boxes
    .map((b) => aabb(b.points))
    .filter((r) => r[3] - r[1] >= minH && r[2] - r[0] >= (r[3] - r[1]) * 1.2)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const used = new Array(rects.length).fill(false);
  const out: PlateCandidate[] = [];
  for (let i = 0; i < rects.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group: Rect[] = [rects[i]];
    for (let j = i + 1; j < rects.length; j++) {
      if (used[j] || group.length >= 2) continue;
      const last = group[group.length - 1];
      const b = rects[j];
      const h = last[3] - last[1];
      const ov = Math.min(last[2], b[2]) - Math.max(last[0], b[0]);
      const gap = b[1] - last[3];
      const ratio = (b[3] - b[1]) / h;
      if (ov > 0.5 * Math.min(last[2] - last[0], b[2] - b[0]) && gap >= -0.3 * h && gap <= 0.6 * h && ratio >= 0.6 && ratio <= 1.6) {
        group.push(b);
        used[j] = true;
      }
    }
    out.push({
      box: [Math.min(...group.map((r) => r[0])), Math.min(...group.map((r) => r[1])), Math.max(...group.map((r) => r[2])), Math.max(...group.map((r) => r[3]))],
      lines: group.length as 1 | 2,
      lineBoxes: group,
    });
  }
  return out;
}

/** Candidate box padded by pad x its height, clamped, integer (as the reference crop_pad). */
export function padBox(box: Rect, W: number, H: number, pad = 0.08): Rect {
  const ph = (box[3] - box[1]) * pad;
  return [
    Math.max(0, Math.floor(box[0] - ph)),
    Math.max(0, Math.floor(box[1] - ph)),
    Math.min(W, Math.ceil(box[2] + ph)),
    Math.min(H, Math.ceil(box[3] + ph)),
  ];
}
