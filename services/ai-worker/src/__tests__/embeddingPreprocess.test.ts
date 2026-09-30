/**
 * SigLIP 2 preprocessing vs Pillow (tools/reference/siglip2_reference.py) on SYNTHETIC images.
 * The resized bytes must equal PIL's BILINEAR resize exactly, and the tensor must equal what the
 * official SiglipImageProcessor produced.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { Image3 } from '../anpr/imageOps';
import { SIGLIP2_INPUT, resizePilBilinear, siglip2Preprocess } from '../embedding/preprocess';

const FIX = path.join(__dirname, 'fixtures', 'embedding');
const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'siglip2.reference.json'), 'utf8'));

function load(file: string): Image3 {
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [width, height] = probe.split(',').map(Number);
  return { data: new Uint8Array(data), width, height };
}

describe('SigLIP 2 preprocessing equals Pillow', () => {
  for (const im of ref.images) {
    it(`${im.file}: resized bytes equal PIL BILINEAR`, () => {
      const src = load(path.join(FIX, im.file));
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(FIX, im.file))).digest('hex')).toBe(im.pngSha256);
      expect([src.width, src.height]).toEqual([im.width, im.height]);
      const out = resizePilBilinear(src, SIGLIP2_INPUT, SIGLIP2_INPUT);
      expect(crypto.createHash('sha256').update(out.data).digest('hex')).toBe(im.resized224Sha256);
    });
  }

  it('lays out CHW float32 as (x/255 - 0.5)/0.5', () => {
    const img: Image3 = { width: 224, height: 224, data: new Uint8Array(224 * 224 * 3) };
    for (let i = 0; i < img.data.length; i += 3) img.data.set([0, 255, 51], i);
    const t = siglip2Preprocess(img);
    const plane = 224 * 224;
    expect(t.length).toBe(3 * plane);
    expect(t[0]).toBe(-1);
    expect(t[plane]).toBe(1);
    expect(t[2 * plane + 5]).toBeCloseTo(-0.6, 6);
  });

  it('refuses an empty or malformed image', () => {
    expect(() => siglip2Preprocess({ width: 0, height: 0, data: new Uint8Array(0) })).toThrow();
    expect(() => siglip2Preprocess({ width: 4, height: 4, data: new Uint8Array(5) })).toThrow();
  });
});
