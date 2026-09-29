/**
 * Crop extraction from the worker's RGB24 canvas with real ffmpeg: a coloured block placed at known
 * source coordinates in a letterboxed canvas must come back as exactly that block, and degenerate
 * inputs must be reported, never guessed.
 */
import { execFileSync } from 'child_process';
import { CoordinateTransformer } from '../coordinateTransformer';
import { copyRegionRgb24, cropToJpeg, MIN_CROP_SIDE_PX, regionInCanvas } from '../cropExtractor';

// 1280x720 source letterboxed into a 640x640 canvas: 640x360 image, 140 px padding above and below.
const g = CoordinateTransformer.computeGeometry(1280, 720, 640, 640, true);
const W = g.modelWidth;

/** Canvas: blue everywhere, a red block at source (320..640, 180..360) = canvas x 160..320, y 230..320. */
function canvas(): Buffer {
  const b = Buffer.alloc(W * g.modelHeight * 3);
  for (let i = 0; i < b.length; i += 3) b.set([0, 0, 255], i);
  for (let y = 230; y < 320; y++) for (let x = 160; x < 320; x++) b.set([255, 0, 0], (y * W + x) * 3);
  return b;
}
const decode = (jpeg: Buffer) => execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { input: jpeg, maxBuffer: 64 << 20 });
const size = (jpeg: Buffer) =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', 'pipe:0'], { input: jpeg, encoding: 'utf8' }).trim().split(',').map(Number);
const px = (raw: Buffer, w: number, x: number, y: number) => [...raw.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];

describe('P5.1 worker crop extraction', () => {
  it('maps a source-normalised box into the letterboxed canvas, skipping the padding', () => {
    expect(regionInCanvas({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, g)).toEqual({ x: 160, y: 230, width: 160, height: 90 });
    expect(regionInCanvas({ x: 0, y: 0, width: 1, height: 1 }, g)).toEqual({ x: 0, y: 140, width: 640, height: 360 });
    // a box that runs past the image edge is clipped to it
    expect(regionInCanvas({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, g)).toEqual({ x: 576, y: 464, width: 64, height: 36 });
  });

  it('returns exactly the block a detection covers, as a JPEG of the right size and colour', async () => {
    const jpeg = await cropToJpeg(canvas(), g, { x: 0.25, y: 0.25, width: 0.25, height: 0.25 });
    expect(jpeg).not.toBeNull();
    expect([jpeg![0], jpeg![1]]).toEqual([0xff, 0xd8]);
    expect(size(jpeg!)).toEqual([160, 90]);
    const raw = decode(jpeg!);
    for (const [x, y] of [[5, 5], [80, 45], [154, 84]]) {
      const [r, gr, b] = px(raw, 160, x, y);
      expect(r).toBeGreaterThan(200);
      expect(gr).toBeLessThan(60);
      expect(b).toBeLessThan(60);
    }
    // the top-left corner of the source is blue, not red
    const other = decode((await cropToJpeg(canvas(), g, { x: 0, y: 0, width: 0.2, height: 0.2 }))!);
    const [r, , b] = px(other, 128, 10, 10);
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
  });

  it('a box too small to be useful gives null; an inconsistent frame throws instead of guessing', async () => {
    expect(await cropToJpeg(canvas(), g, { x: 0.5, y: 0.5, width: (MIN_CROP_SIDE_PX - 1) / 640, height: 0.2 })).toBeNull();
    await expect(cropToJpeg(Buffer.alloc(100), g, { x: 0.1, y: 0.1, width: 0.3, height: 0.3 })).rejects.toThrow(/canvas/);
    expect(() => copyRegionRgb24(Buffer.alloc(10), g, { x: 0, y: 0, width: 8, height: 8 })).toThrow();
  });
});
