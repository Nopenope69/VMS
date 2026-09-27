/**
 * YuNet face detection (P4.4) vs OpenCV FaceDetectorYN (tools/reference/yunet_reference.py) on a
 * SYNTHETIC scene holding a public-domain NASA portrait. The model is a candidate (training-data
 * licence pending human review); tests load it directly.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { artifactPathFor, findCandidateEntry } from '../modelCatalog';
import { OrtSession } from '../anpr/ortSession';
import { Image3 } from '../anpr/imageOps';
import { FaceDetector, decodeYunet, iou, preprocessYunet } from '../redaction/faceDetector';

const FIX = path.join(__dirname, 'fixtures', 'redaction');
const modelPath = artifactPathFor(findCandidateEntry('yunet-2023mar'));
const present = fs.existsSync(modelPath);
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';

function load(file: string): Image3 {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [width, height] = probe.split(',').map(Number);
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  return { data: new Uint8Array(data), width, height };
}

describe('YuNet decoding (no model)', () => {
  it('decodes an anchor with OpenCV geometry and applies NMS', () => {
    const mk = (n: number, k: number) => new Float32Array(n * k);
    const out: Record<string, { data: Float32Array }> = {};
    for (const s of [8, 16, 32]) {
      const n = (640 / s) ** 2;
      out[`cls_${s}`] = { data: mk(n, 1) };
      out[`obj_${s}`] = { data: mk(n, 1) };
      out[`bbox_${s}`] = { data: mk(n, 4) };
      out[`kps_${s}`] = { data: mk(n, 10) };
    }
    // stride 16, row 3, col 5: centre ((5+0.5)*16, (3+0.5)*16), size exp(1)*16
    const i = 3 * 40 + 5;
    out.cls_16.data[i] = 0.81;
    out.obj_16.data[i] = 1;
    out.bbox_16.data.set([0.5, 0.5, 1, 1], i * 4);
    // overlapping weaker duplicate at the next anchor is suppressed
    out.cls_16.data[i + 1] = 0.64;
    out.obj_16.data[i + 1] = 1;
    out.bbox_16.data.set([-0.5, 0.5, 1, 1], (i + 1) * 4);
    const faces = decodeYunet(out);
    expect(faces).toHaveLength(1);
    expect(faces[0].score).toBeCloseTo(0.9);
    const w = Math.exp(1) * 16;
    expect(faces[0].box[0]).toBeCloseTo(88 - w / 2);
    expect(faces[0].box[3]).toBeCloseTo(56 + w / 2);
  });

  it('letterboxes top-left in BGR order with raw 0..255 values', () => {
    const img: Image3 = { width: 2, height: 1, data: new Uint8Array([10, 20, 30, 40, 50, 60]) };
    const { tensor, scale } = preprocessYunet(img);
    expect(scale).toBe(320);
    const plane = 640 * 640;
    expect([tensor[0], tensor[plane], tensor[2 * plane]]).toEqual([30, 20, 10]);
    expect(tensor[640 * 639 + 639]).toBe(0);
  });
});

if (!present && required) {
  test('YuNet model required (VIGILONE_REQUIRE_MODEL_TESTS=1)', () => {
    throw new Error(`missing ${modelPath}: scripts/models/fetch-model.sh yunet-2023mar`);
  });
}

(present ? describe : describe.skip)('YuNet golden (vs OpenCV FaceDetectorYN)', () => {
  it('matches the reference boxes and scores', async () => {
    const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'yunet.reference.json'), 'utf8'));
    const det = new FaceDetector(await OrtSession.create(fs.readFileSync(modelPath)));
    for (const [file, want] of Object.entries<any[]>(ref.images)) {
      const got = await det.detect(load(path.join(FIX, file)), { scoreThreshold: ref.scoreThreshold });
      expect(got).toHaveLength(want.length);
      want.forEach((w, k) => {
        expect(iou(got[k].box, w.box)).toBeGreaterThan(0.97);
        expect(Math.abs(got[k].score - w.score)).toBeLessThan(0.01);
      });
    }
  }, 60000);

  it('finds the face inside the pasted portrait', async () => {
    const m = JSON.parse(fs.readFileSync(path.join(FIX, 'SYNTHETIC_redaction_manifest.json'), 'utf8'));
    const det = new FaceDetector(await OrtSession.create(fs.readFileSync(modelPath)));
    const faces = await det.detect(load(path.join(FIX, m.file)));
    const [x1, y1, x2, y2] = m.portraitBoxXYXY;
    expect(faces.length).toBeGreaterThanOrEqual(1);
    expect(faces[0].box[0]).toBeGreaterThanOrEqual(x1);
    expect(faces[0].box[2]).toBeLessThanOrEqual(x2);
    expect(faces[0].box[1]).toBeGreaterThanOrEqual(y1);
    expect(faces[0].box[3]).toBeLessThanOrEqual(y2);
  }, 60000);
});
