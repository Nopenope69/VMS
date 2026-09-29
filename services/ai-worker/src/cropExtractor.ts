/**
 * Object-crop extraction for the backend crop store (Phase 5, P5.1).
 *
 * The worker holds the sampled frame as an RGB24 canvas (the model input, letterboxed or
 * stretched). A detection's box is normalised to the SOURCE image, so it is mapped back into the
 * canvas with the frame's own geometry (the inverse of CoordinateTransformer.reverseTransformBox),
 * that region alone is copied out and encoded to JPEG with ffmpeg. The full frame is never written
 * anywhere and never leaves the process; only the crop does, and only when AI_ATTACH_CROPS is on.
 * The backend still decides whether to keep it (feature flag and per-site person policy).
 *
 * Resolution: the crop comes from the model-input canvas, so it is at most that resolution, not the
 * camera's native one. That is what the pipeline holds; it is stated here so nobody assumes more.
 */
import { spawn } from 'child_process';
import { FrameGeometry } from './types';

/** A crop smaller than this on either side carries nothing useful for search. */
export const MIN_CROP_SIDE_PX = 8;
/** Larger encodes are refused (the backend refuses them too). */
export const MAX_CROP_JPEG_BYTES = 256 * 1024;

export interface NormalizedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The canvas pixels a source-normalised box covers, clipped to the real image area; null if too small. */
export function regionInCanvas(box: NormalizedBox, g: FrameGeometry): CanvasRegion | null {
  const activeW = g.scaledWidth ?? g.modelWidth - g.padX * 2;
  const activeH = g.scaledHeight ?? g.modelHeight - g.padY * 2;
  if (!(activeW > 0 && activeH > 0)) throw new Error('FrameGeometry is inconsistent: no active image area');
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x1 = Math.round(g.padX + clamp(box.x, 0, 1) * activeW);
  const y1 = Math.round(g.padY + clamp(box.y, 0, 1) * activeH);
  const x2 = Math.round(g.padX + clamp(box.x + box.width, 0, 1) * activeW);
  const y2 = Math.round(g.padY + clamp(box.y + box.height, 0, 1) * activeH);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < MIN_CROP_SIDE_PX || height < MIN_CROP_SIDE_PX) return null;
  return { x: x1, y: y1, width, height };
}

/** Copies a region out of an RGB24 canvas. Throws if the buffer is not exactly the canvas. */
export function copyRegionRgb24(frame: Buffer, g: FrameGeometry, r: CanvasRegion): Buffer {
  if (frame.length !== g.modelWidth * g.modelHeight * 3) {
    throw new Error(`frame is ${frame.length} bytes, the ${g.modelWidth}x${g.modelHeight} RGB24 canvas is ${g.modelWidth * g.modelHeight * 3}`);
  }
  const out = Buffer.allocUnsafe(r.width * r.height * 3);
  for (let row = 0; row < r.height; row++) {
    const from = ((r.y + row) * g.modelWidth + r.x) * 3;
    frame.copy(out, row * r.width * 3, from, from + r.width * 3);
  }
  return out;
}

function encodeJpeg(rgb: Buffer, width: number, height: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let err = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      done(() => reject(new Error(`ffmpeg crop encode timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    p.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_CROP_JPEG_BYTES) {
        p.kill('SIGKILL');
        done(() => reject(new Error(`crop JPEG exceeds ${MAX_CROP_JPEG_BYTES} bytes`)));
        return;
      }
      chunks.push(c);
    });
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.stdin.on('error', () => undefined); // a dead ffmpeg is reported by its exit below
    p.on('error', (e) => done(() => reject(new Error(`cannot run ffmpeg: ${e.message}`))));
    p.on('close', (code) =>
      done(() => {
        const out = Buffer.concat(chunks);
        if (code !== 0 || out.length === 0) reject(new Error(`ffmpeg crop encode failed (exit ${code}): ${err.trim().slice(0, 300)}`));
        else resolve(out);
      })
    );
    p.stdin.end(rgb);
  });
}

/**
 * JPEG of the region a detection covers, or null when the box is too small to be worth keeping.
 * Throws on any real failure (inconsistent frame, ffmpeg missing or failing); the caller decides
 * how to report it and must not let it stop the detection.
 */
export async function cropToJpeg(frame: Buffer, g: FrameGeometry, box: NormalizedBox, timeoutMs = 5000): Promise<Buffer | null> {
  const region = regionInCanvas(box, g);
  if (!region) return null;
  return encodeJpeg(copyRegionRgb24(frame, g, region), region.width, region.height, timeoutMs);
}
