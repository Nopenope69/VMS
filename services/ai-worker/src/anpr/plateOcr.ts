import { OrtSession } from './ortSession';
import { Image3, resizeBilinear } from './imageOps';

/**
 * fast-plate-ocr recognition: stretch-resize the plate crop to the model size (bilinear,
 * aspect not kept), feed uint8 RGB NHWC, argmax per character slot, drop trailing pad chars.
 */
export interface OcrConfig {
  alphabet: string;
  padChar: string;
  maxPlateSlots: number;
  inputWidth: number;
  inputHeight: number;
}

export interface OcrResult {
  text: string;
  /** Max probability of each kept slot. */
  charProbs: number[];
  /** Product-free summary: the weakest character's probability. */
  confidence: number;
}

/** Reads the model's YAML config (flat key: value lines only). */
export function parsePlateConfig(yaml: string): OcrConfig {
  const get = (k: string) => {
    const m = new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(yaml);
    if (!m) throw new Error(`plate config has no ${k}`);
    return m[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
  };
  return {
    alphabet: get('alphabet'),
    padChar: get('pad_char'),
    maxPlateSlots: Number(get('max_plate_slots')),
    inputWidth: Number(get('img_width')),
    inputHeight: Number(get('img_height')),
  };
}

export function decodeSlots(probs: Float32Array, offset: number, cfg: OcrConfig): OcrResult {
  const A = cfg.alphabet.length;
  const chars: string[] = [];
  const p: number[] = [];
  for (let s = 0; s < cfg.maxPlateSlots; s++) {
    let best = 0;
    let bi = 0;
    for (let a = 0; a < A; a++) {
      const v = probs[offset + s * A + a];
      if (v > best || a === 0) {
        best = v;
        bi = a;
      }
    }
    chars.push(cfg.alphabet[bi]);
    p.push(best);
  }
  let end = chars.length;
  while (end > 0 && chars[end - 1] === cfg.padChar) end--;
  const text = chars.slice(0, end).join('');
  const kept = p.slice(0, end);
  return { text, charProbs: kept, confidence: kept.length ? Math.min(...kept) : 0 };
}

export class PlateOcr {
  constructor(private session: OrtSession, public readonly cfg: OcrConfig) {}

  async read(crops: Image3[]): Promise<OcrResult[]> {
    if (crops.length === 0) return [];
    const { inputWidth: w, inputHeight: h } = this.cfg;
    const batch = new Uint8Array(crops.length * w * h * 3);
    crops.forEach((c, i) => batch.set(resizeBilinear(c, w, h).data, i * w * h * 3));
    const out = await this.session.run({ [this.session.inputNames[0]]: { type: 'uint8', data: batch, dims: [crops.length, h, w, 3] } });
    const plate = out['plate'] ?? out[this.session.outputNames[0]];
    const per = this.cfg.maxPlateSlots * this.cfg.alphabet.length;
    if (plate.data.length !== per * crops.length) throw new Error(`OCR output has ${plate.data.length} values, expected ${per * crops.length}`);
    return crops.map((_, i) => decodeSlots(plate.data, i * per, this.cfg));
  }
}
