/**
 * SigLIP 2 image preprocessing (Phase 5, P5.3), reproducing what the model's reference implementation
 * (Hugging Face SiglipImageProcessor, preprocessor_config.json) does to an image before the vision tower:
 *
 *   1. RGB, resized straight to 224x224 with PIL bilinear (no aspect-ratio-preserving letterbox),
 *   2. scaled by 1/255,
 *   3. normalised with mean 0.5 and standard deviation 0.5 per channel,
 *   4. laid out as CHW float32.
 *
 * Step 1 is Pillow's resampling and is NOT OpenCV's INTER_LINEAR: when an image is reduced, Pillow widens
 * the bilinear (triangle) filter by the reduction factor, which is an anti-aliasing filter. Using the
 * cheaper OpenCV form gives visibly different embeddings on downscaled crops. This file implements
 * Pillow's algorithm (Resample.c: precompute_coeffs and the 8-bit horizontal and vertical passes, with its
 * 22-bit fixed-point coefficients and its 8-bit intermediate), so the resized bytes can equal PIL's exactly;
 * embeddingPreprocess.test.ts checks that against PIL output on real images.
 */
import { Image3 } from '../anpr/imageOps';

export const SIGLIP2_INPUT = 224;
const PRECISION_BITS = 32 - 8 - 2; // Pillow: 22
const MEAN = 0.5;
const STD = 0.5;

interface Coeffs {
  bounds: Array<[number, number]>; // [xmin, count] per output pixel
  kk: Int32Array[]; // fixed-point weights per output pixel
}

/** Pillow precompute_coeffs for the BILINEAR filter (support 1). */
function precomputeCoeffs(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 1 * filterscale;
  const bounds: Array<[number, number]> = [];
  const kk: Int32Array[] = [];
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    const k = new Float64Array(xmax);
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const a = (x + xmin - center + 0.5) / filterscale;
      const w = Math.abs(a) < 1 ? 1 - Math.abs(a) : 0;
      k[x] = w;
      ww += w;
    }
    const fixed = new Int32Array(xmax);
    for (let x = 0; x < xmax; x++) {
      const w = ww !== 0 ? k[x] / ww : k[x];
      fixed[x] = w < 0 ? Math.trunc(-0.5 + w * (1 << PRECISION_BITS)) : Math.trunc(0.5 + w * (1 << PRECISION_BITS));
    }
    bounds.push([xmin, xmax]);
    kk.push(fixed);
  }
  return { bounds, kk };
}

const clip8 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Pillow's 8-bit separable resize: horizontal pass to an 8-bit intermediate, then vertical pass. */
export function resizePilBilinear(img: Image3, width: number, height: number): Image3 {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1) throw new Error(`invalid image size ${img.width}x${img.height}`);
  if (img.data.length !== img.width * img.height * 3) throw new Error(`image data is ${img.data.length} bytes, expected ${img.width * img.height * 3}`);
  if (img.width === width && img.height === height) return { data: Uint8Array.from(img.data), width, height };
  const half = 1 << (PRECISION_BITS - 1);
  const div = 1 << PRECISION_BITS;
  const h = precomputeCoeffs(img.width, width);
  const v = precomputeCoeffs(img.height, height);

  // horizontal: img.height rows -> width columns
  const mid = new Uint8Array(width * img.height * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < width; x++) {
      const [xmin, n] = h.bounds[x];
      const k = h.kk[x];
      for (let c = 0; c < 3; c++) {
        let ss = half;
        for (let i = 0; i < n; i++) ss += img.data[(y * img.width + xmin + i) * 3 + c] * k[i];
        mid[(y * width + x) * 3 + c] = clip8(Math.floor(ss / div));
      }
    }
  }
  // vertical: width columns, img.height rows -> height rows
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const [ymin, n] = v.bounds[y];
    const k = v.kk[y];
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let ss = half;
        for (let i = 0; i < n; i++) ss += mid[((ymin + i) * width + x) * 3 + c] * k[i];
        out[(y * width + x) * 3 + c] = clip8(Math.floor(ss / div));
      }
    }
  }
  return { data: out, width, height };
}

/** RGB 8-bit image -> the vision tower's input tensor: float32 CHW, 3 x 224 x 224. */
export function siglip2Preprocess(img: Image3): Float32Array {
  const r = resizePilBilinear(img, SIGLIP2_INPUT, SIGLIP2_INPUT);
  const plane = SIGLIP2_INPUT * SIGLIP2_INPUT;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      // (v / 255 - mean) / std, in float64 then stored as float32 (the reference does the same in numpy)
      out[c * plane + i] = Math.fround(((r.data[i * 3 + c] / 255) - MEAN) / STD);
    }
  }
  return out;
}
