/**
 * P4.1 golden tests: the TypeScript ANPR path (PP-OCRv4 DB text detection, plate candidates,
 * fast-plate-ocr) against the Python reference (tools/reference/anpr_reference.py, which runs
 * RapidOCR's own DB post-processing and fast_plate_ocr's pre/post-processing with cv2) on
 * SYNTHETIC scenes (tools/anpr/synth_plates.py). The models are candidate models (training-data
 * licence pending human review); tests load them directly.
 *
 * Skipped when the models are absent unless VIGILONE_REQUIRE_MODEL_TESTS=1 (CI), then it fails.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { artifactPathFor, findCandidateEntry, resolveModelsDir } from '../modelCatalog';
import { OrtSession } from '../anpr/ortSession';
import { TextDetector, dbResizeDims } from '../anpr/textDetector';
import { PlateOcr, parsePlateConfig } from '../anpr/plateOcr';
import { AnprPipeline } from '../anpr/anprPipeline';
import { groupCandidates, padBox, aabb } from '../anpr/plateCandidates';
import { Image3, crop, resizeBilinear } from '../anpr/imageOps';

const FIX = path.join(__dirname, 'fixtures', 'anpr');
const det = findCandidateEntry('ppocrv4-det');
const ocrEntry = findCandidateEntry('fast-plate-ocr-cct-s-v2');
const detPath = artifactPathFor(det);
const ocrPath = artifactPathFor(ocrEntry);
const cfgPath = path.join(resolveModelsDir(), ocrEntry.extraFiles![0].fileName);
const present = [detPath, ocrPath, cfgPath].every((p) => fs.existsSync(p));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';

function load(file: string): Image3 {
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [width, height] = probe.split(',').map(Number);
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  return { data: new Uint8Array(data), width, height };
}

const iou = (a: number[], b: number[]) => {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
};

if (!present && required) {
  test('ANPR candidate models required (VIGILONE_REQUIRE_MODEL_TESTS=1)', () => {
    throw new Error(`missing ${[detPath, ocrPath, cfgPath].filter((p) => !fs.existsSync(p)).join(', ')}: scripts/models/fetch-model.sh ppocrv4-det && scripts/models/fetch-model.sh fast-plate-ocr-cct-s-v2`);
  });
}

(present ? describe : describe.skip)('ANPR golden (SYNTHETIC scenes vs Python reference)', () => {
  const reference = JSON.parse(fs.readFileSync(path.join(FIX, 'reference.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'SYNTHETIC_manifest.json'), 'utf8'));
  let detector: TextDetector;
  let ocr: PlateOcr;
  let pipeline: AnprPipeline;

  beforeAll(async () => {
    detector = new TextDetector(await OrtSession.create(fs.readFileSync(detPath)));
    ocr = new PlateOcr(await OrtSession.create(fs.readFileSync(ocrPath)), parsePlateConfig(fs.readFileSync(cfgPath, 'utf8')));
    pipeline = new AnprPipeline(detector, ocr);
  }, 60000);

  it('bilinear resize stays within 2 intensity levels of cv2 INTER_LINEAR', () => {
    const r = JSON.parse(fs.readFileSync(path.join(FIX, 'resize.reference.json'), 'utf8'));
    const img = load(path.join(FIX, 'SYNTHETIC_private_hsrp.png'));
    const [y1, y2, x1, x2] = r.crop;
    const out = resizeBilinear(crop(img, x1, y1, x2, y2), r.size[0], r.size[1]);
    let maxd = 0;
    let sumd = 0;
    for (let i = 0; i < out.data.length; i++) {
      const d = Math.abs(out.data[i] - r.data[i]);
      maxd = Math.max(maxd, d);
      sumd += d;
    }
    expect(maxd).toBeLessThanOrEqual(2);
    expect(sumd / out.data.length).toBeLessThan(0.5);
  });

  for (const name of ['SYNTHETIC_private_hsrp.png', 'SYNTHETIC_commercial.png', 'SYNTHETIC_ev_green.png', 'SYNTHETIC_bharat_series.png', 'SYNTHETIC_two_line_two_wheeler.png', 'SYNTHETIC_mono_font.png']) {
    it(`${name}: same network input size, text boxes, candidates and OCR text as the reference`, async () => {
      const ref = reference[name];
      const img = load(path.join(FIX, name));
      const dims = dbResizeDims(img.width, img.height, { limitSideLen: 736, limitType: 'min' });
      expect([1, 3, dims.h, dims.w]).toEqual(ref.inputShape);

      const boxes = await detector.detect(img);
      expect(boxes.length).toBe(ref.boxes.length);
      for (let i = 0; i < ref.boxes.length; i++) {
        const want = aabb(ref.boxes[i]);
        const best = Math.max(...boxes.map((b) => iou(aabb(b.points), want)));
        expect(best).toBeGreaterThan(0.85);
        const match = boxes.reduce((m, b) => (iou(aabb(b.points), want) > iou(aabb(m.points), want) ? b : m));
        expect(Math.abs(match.score - ref.scores[i])).toBeLessThan(0.05);
      }

      const cands = groupCandidates(boxes);
      expect(cands.map((c) => c.lines)).toEqual(ref.candidates.map((c: any) => c.lines));
      for (let i = 0; i < cands.length; i++) {
        const want = ref.candidates[i];
        expect(iou(cands[i].box, want.box)).toBeGreaterThan(0.85);
        const pb = padBox(cands[i].box, img.width, img.height);
        const [r] = await ocr.read([crop(img, pb[0], pb[1], pb[2], pb[3])]);
        // Plate-shaped candidates must read identically; the tiny HSRP "IND" strip is noise in
        // both implementations and only has to stay low-confidence.
        if (Math.min(...want.charProbs) >= 0.5) {
          expect(r.text).toBe(want.text);
          r.charProbs.forEach((p, k) => expect(Math.abs(p - want.charProbs[k])).toBeLessThan(0.08));
        } else {
          expect(r.confidence).toBeLessThan(0.5);
        }
      }
    }, 30000);
  }

  it('the pipeline returns exactly the ground-truth plate on every synthetic scene, and nothing else', async () => {
    for (const item of manifest.images) {
      const img = load(path.join(FIX, item.file));
      const { plates } = await pipeline.read(img);
      expect(plates.map((p) => p.plate.normalized)).toEqual([item.plateText]);
      const [x, y, w, h] = item.plateBoxXYWH;
      // The text region lies inside the pasted plate (border and IND strip excluded).
      const [bx1, by1, bx2, by2] = plates[0].box;
      expect(bx1).toBeGreaterThanOrEqual(x - 2);
      expect(by1).toBeGreaterThanOrEqual(y - 2);
      expect(bx2).toBeLessThanOrEqual(x + w + 2);
      expect(by2).toBeLessThanOrEqual(y + h + 2);
      expect((bx2 - bx1) * (by2 - by1)).toBeGreaterThan(0.25 * w * h);
      if (item.lines.length === 2) expect(plates[0].lines).toBe(2);
    }
  }, 60000);
});
