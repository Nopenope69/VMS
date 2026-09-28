import { RuntimeConfig } from './types';

/**
 * Converts an interleaved RGB24 frame (what FrameExtractor emits) into the planar NCHW float32
 * tensor a model expects, according to its manifest runtime config:
 *
 *  - colorSpace 'BGR' swaps channels (YOLOX was trained on OpenCV BGR images);
 *  - normalization 'none' keeps raw 0..255 values (YOLOX);
 *  - normalization 'scale' divides by `value` (default 255);
 *  - normalization 'mean_std' computes (x / 255 - mean) / std per channel (ImageNet, RF-DETR).
 *
 * A config without a normalization block keeps the historical behaviour (divide by 255).
 */
export function fillPlanarTensor(
  rgb: Buffer | Uint8Array,
  out: Float32Array,
  width: number,
  height: number,
  config: RuntimeConfig
): void {
  const pixelCount = width * height;
  if (rgb.length !== pixelCount * 3) {
    throw new Error(
      `INVALID_FRAME: frame has ${rgb.length} bytes, expected ${pixelCount * 3} for ${width}x${height} RGB24`
    );
  }
  if (out.length < pixelCount * 3) {
    throw new Error(`Tensor buffer too small: ${out.length} < ${pixelCount * 3}`);
  }

  const bgr = (config.colorSpace || 'RGB').toUpperCase() === 'BGR';
  // Source channel feeding tensor plane 0, 1, 2.
  const srcCh = bgr ? [2, 1, 0] : [0, 1, 2];

  const norm = config.normalization;
  const type = (norm?.type || 'scale').toLowerCase();

  let mul = [1, 1, 1];
  let add = [0, 0, 0];
  if (type === 'none' || type === 'raw') {
    // keep 0..255
  } else if (type === 'mean_std' || type === 'meanstd' || type === 'imagenet') {
    const mean = norm?.mean ?? [0.485, 0.456, 0.406];
    const std = norm?.std ?? [0.229, 0.224, 0.225];
    if (mean.length !== 3 || std.length !== 3 || std.some((s) => !s)) {
      throw new Error('normalization mean_std requires 3 means and 3 non-zero stds');
    }
    // (x/255 - m) / s  ==  x * (1 / (255 s)) + (-m / s); planes are in model channel order.
    mul = [0, 1, 2].map((p) => 1 / (255 * std[p]));
    add = [0, 1, 2].map((p) => -mean[p] / std[p]);
  } else {
    const v = norm?.value;
    const div = Array.isArray(v) ? v[0] : typeof v === 'number' ? v : 255;
    if (!div) throw new Error('normalization scale value must be non-zero');
    mul = [1 / div, 1 / div, 1 / div];
  }

  for (let p = 0; p < 3; p++) {
    const base = p * pixelCount;
    const ch = srcCh[p];
    const m = mul[p];
    const a = add[p];
    for (let i = 0; i < pixelCount; i++) {
      out[base + i] = rgb[i * 3 + ch] * m + a;
    }
  }
}
