import { Image3, crop } from './imageOps';
import { TextDetector, TextBox } from './textDetector';
import { PlateOcr, OcrResult } from './plateOcr';
import { groupCandidates, padBox, Rect } from './plateCandidates';
import { normalizeIndianPlate, NormalizedPlate } from './indianPlate.v1';

/**
 * ANPR on one image (a full LPR-camera frame, or a vehicle crop): text detection -> plate
 * candidates -> OCR -> Indian-format selection. For a two-line candidate both readings are
 * tried (the whole plate, and the lines read separately and joined) and the one that forms a
 * valid Indian plate with the higher confidence wins.
 *
 * Nothing is invented: a candidate whose text does not form a known Indian format is returned
 * with valid=false and is filtered by minConfidence/requireValidFormat, never "fixed" beyond
 * the positional letter/digit correction.
 */
export interface PlateRead {
  box: Rect;
  lines: 1 | 2;
  rawText: string;
  plate: NormalizedPlate;
  confidence: number;
  detectorScore: number;
  reading: 'whole' | 'per_line';
}

export interface AnprOptions {
  minConfidence: number;
  requireValidFormat: boolean;
  /** Region of interest in the image (LPR lane), default whole image. */
  roi?: Rect;
}

export const DEFAULT_ANPR_OPTIONS: AnprOptions = { minConfidence: 0.5, requireValidFormat: true };

export class AnprPipeline {
  constructor(private detector: TextDetector, private ocr: PlateOcr) {}

  async read(img: Image3, opts: AnprOptions = DEFAULT_ANPR_OPTIONS): Promise<{ plates: PlateRead[]; textBoxes: TextBox[]; candidates: number }> {
    let src = img;
    let ox = 0;
    let oy = 0;
    if (opts.roi) {
      src = crop(img, opts.roi[0], opts.roi[1], opts.roi[2], opts.roi[3]);
      ox = Math.max(0, Math.floor(opts.roi[0]));
      oy = Math.max(0, Math.floor(opts.roi[1]));
    }
    const textBoxes = await this.detector.detect(src);
    const cands = groupCandidates(textBoxes);
    const plates: PlateRead[] = [];
    const scoreOf = (box: Rect) => {
      let best = 0;
      for (const t of textBoxes) {
        const xs = t.points.map((p) => p[0]);
        const ys = t.points.map((p) => p[1]);
        if (Math.min(...xs) >= box[0] - 2 && Math.max(...xs) <= box[2] + 2 && Math.min(...ys) >= box[1] - 2 && Math.max(...ys) <= box[3] + 2) best = Math.max(best, t.score);
      }
      return best;
    };
    for (const c of cands) {
      const pb = padBox(c.box, src.width, src.height);
      const whole = crop(src, pb[0], pb[1], pb[2], pb[3]);
      const readings: Array<{ text: string; conf: number; reading: PlateRead['reading'] }> = [];
      const [w] = await this.ocr.read([whole]);
      readings.push({ text: w.text, conf: w.confidence, reading: 'whole' });
      if (c.lines === 2) {
        const lineCrops = c.lineBoxes.map((lb) => {
          const p = padBox(lb, src.width, src.height);
          return crop(src, p[0], p[1], p[2], p[3]);
        });
        const lr: OcrResult[] = await this.ocr.read(lineCrops);
        readings.push({ text: lr.map((r) => r.text).join(''), conf: Math.min(...lr.map((r) => r.confidence)), reading: 'per_line' });
      }
      const scored = readings
        .map((r) => ({ ...r, plate: normalizeIndianPlate(r.text) }))
        .sort((a, b) => Number(b.plate.valid) - Number(a.plate.valid) || b.conf - a.conf || a.plate.corrections - b.plate.corrections);
      const best = scored[0];
      if (best.conf < opts.minConfidence) continue;
      if (opts.requireValidFormat && !best.plate.valid) continue;
      plates.push({
        box: [c.box[0] + ox, c.box[1] + oy, c.box[2] + ox, c.box[3] + oy],
        lines: c.lines,
        rawText: best.text,
        plate: best.plate,
        confidence: best.conf,
        detectorScore: scoreOf(c.box),
        reading: best.reading,
      });
    }
    return { plates, textBoxes, candidates: cands.length };
  }
}
