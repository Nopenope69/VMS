/**
 * Minimal image operations for the ANPR / redaction paths (packed 8-bit, 3 channels).
 * resizeBilinear follows OpenCV INTER_LINEAR geometry (half-pixel centres, edge clamping) in
 * floating point, so values can differ from cv2's fixed-point uint8 path by a unit or two
 * (checked against cv2 in the golden tests).
 */
export interface Image3 {
  data: Uint8Array;
  width: number;
  height: number;
}

export function crop(img: Image3, x1: number, y1: number, x2: number, y2: number): Image3 {
  const X1 = Math.max(0, Math.min(img.width, Math.floor(x1)));
  const Y1 = Math.max(0, Math.min(img.height, Math.floor(y1)));
  const X2 = Math.max(X1, Math.min(img.width, Math.ceil(x2)));
  const Y2 = Math.max(Y1, Math.min(img.height, Math.ceil(y2)));
  const w = X2 - X1;
  const h = Y2 - Y1;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const src = ((Y1 + y) * img.width + X1) * 3;
    out.set(img.data.subarray(src, src + w * 3), y * w * 3);
  }
  return { data: out, width: w, height: h };
}

function coeffs(dst: number, src: number) {
  const scale = src / dst;
  const i0 = new Int32Array(dst);
  const i1 = new Int32Array(dst);
  const w1 = new Float64Array(dst);
  for (let d = 0; d < dst; d++) {
    let f = (d + 0.5) * scale - 0.5;
    let s = Math.floor(f);
    f -= s;
    if (s < 0) {
      f = 0;
      s = 0;
    }
    if (s >= src - 1) {
      f = 0;
      s = src - 1;
    }
    i0[d] = s;
    i1[d] = Math.min(s + 1, src - 1);
    w1[d] = f;
  }
  return { i0, i1, w1 };
}

export function resizeBilinear(img: Image3, width: number, height: number): Image3 {
  if (img.width === width && img.height === height) return { data: img.data.slice(), width, height };
  const cx = coeffs(width, img.width);
  const cy = coeffs(height, img.height);
  const out = new Uint8Array(width * height * 3);
  const row0 = new Float64Array(width * 3);
  const row1 = new Float64Array(width * 3);
  const hrow = (y: number, into: Float64Array) => {
    const base = y * img.width * 3;
    for (let x = 0; x < width; x++) {
      const a = base + cx.i0[x] * 3;
      const b = base + cx.i1[x] * 3;
      const f = cx.w1[x];
      for (let c = 0; c < 3; c++) into[x * 3 + c] = img.data[a + c] * (1 - f) + img.data[b + c] * f;
    }
  };
  for (let y = 0; y < height; y++) {
    hrow(cy.i0[y], row0);
    hrow(cy.i1[y], row1);
    const f = cy.w1[y];
    const o = y * width * 3;
    for (let i = 0; i < width * 3; i++) {
      const v = row0[i] * (1 - f) + row1[i] * f;
      out[o + i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
  return { data: out, width, height };
}

/** Swaps R and B (RGB <-> BGR) into a new buffer. */
export function swapRB(img: Image3): Image3 {
  const d = new Uint8Array(img.data.length);
  for (let i = 0; i < d.length; i += 3) {
    d[i] = img.data[i + 2];
    d[i + 1] = img.data[i + 1];
    d[i + 2] = img.data[i];
  }
  return { data: d, width: img.width, height: img.height };
}
