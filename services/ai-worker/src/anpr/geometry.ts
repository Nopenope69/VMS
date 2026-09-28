/** Planar geometry for DB text-detection post-processing (mirrors cv2.minAreaRect / boxPoints). */
export type Pt = [number, number];

export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 2) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export interface RotatedRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Unit vectors of the two sides. */
  ux: Pt;
  uy: Pt;
}

/** Minimum-area enclosing rectangle by rotating calipers over the convex hull. */
export function minAreaRect(points: Pt[]): RotatedRect {
  const hull = convexHull(points);
  if (hull.length === 0) return { cx: 0, cy: 0, w: 0, h: 0, ux: [1, 0], uy: [0, 1] };
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, ux: [1, 0], uy: [0, 1] };
  let best: RotatedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const ux: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const uy: Pt = [-ux[1], ux[0]];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const q of hull) {
      const u = q[0] * ux[0] + q[1] * ux[1];
      const v = q[0] * uy[0] + q[1] * uy[1];
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      best = { cx: mu * ux[0] + mv * uy[0], cy: mu * ux[1] + mv * uy[1], w: maxU - minU, h: maxV - minV, ux, uy };
    }
  }
  return best!;
}

export function rectCorners(r: RotatedRect): Pt[] {
  const hw = r.w / 2;
  const hh = r.h / 2;
  const c = (a: number, b: number): Pt => [r.cx + a * r.ux[0] + b * r.uy[0], r.cy + a * r.ux[1] + b * r.uy[1]];
  return [c(-hw, -hh), c(hw, -hh), c(hw, hh), c(-hw, hh)];
}

/** RapidOCR get_mini_boxes ordering: top-left, top-right, bottom-right, bottom-left. */
export function orderBox(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const [i1, i4] = p[1][1] > p[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = p[3][1] > p[2][1] ? [2, 3] : [3, 2];
  return [p[i1], p[i2], p[i3], p[i4]];
}

/** Even-odd point-in-polygon for a pixel centre. */
export function inside(x: number, y: number, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
