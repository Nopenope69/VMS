import { FrameGeometry } from '../types';

/**
 * Bilinear resize of an interleaved 3-channel frame into the model canvas described by `g`
 * (scaled image at padX/padY, padding filled with `padValue`). Used for frames posted to the
 * adapter's /v1/infer at arbitrary sizes; the stream pipeline gets frames already letterboxed
 * by ffmpeg. `swapRB` converts BGR input to RGB.
 */
export function letterboxInto(
  src: Buffer,
  srcW: number,
  srcH: number,
  g: FrameGeometry,
  padValue: number,
  swapRB = false
): Buffer {
  if (src.length !== srcW * srcH * 3) {
    throw new Error(`INVALID_FRAME: ${src.length} bytes is not ${srcW}x${srcH}x3`);
  }
  const W = g.modelWidth;
  const H = g.modelHeight;
  const sw = g.scaledWidth ?? W;
  const sh = g.scaledHeight ?? H;
  const out = Buffer.alloc(W * H * 3, Math.max(0, Math.min(255, Math.round(padValue))));
  const r = swapRB ? 2 : 0;
  const b = swapRB ? 0 : 2;

  const sx = srcW / sw;
  const sy = srcH / sh;
  for (let y = 0; y < sh; y++) {
    // Half-pixel centres, as in ffmpeg/OpenCV bilinear.
    const fy = Math.max(0, Math.min(srcH - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < sw; x++) {
      const fx = Math.max(0, Math.min(srcW - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = fx - x0;
      const o = ((y + g.padY) * W + (x + g.padX)) * 3;
      const i00 = (y0 * srcW + x0) * 3;
      const i01 = (y0 * srcW + x1) * 3;
      const i10 = (y1 * srcW + x0) * 3;
      const i11 = (y1 * srcW + x1) * 3;
      for (let c = 0; c < 3; c++) {
        const sc = c === 0 ? r : c === 2 ? b : 1;
        const top = src[i00 + sc] * (1 - wx) + src[i01 + sc] * wx;
        const bot = src[i10 + sc] * (1 - wx) + src[i11 + sc] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}
