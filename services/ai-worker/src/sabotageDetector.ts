import { VideoFrame } from './types';

/**
 * Camera-sabotage detection (ADR 0019): a covered, defocused, moved or blinded camera, read from the sampled substream
 * frames with classical image measurements. No model, no training data, no licence question.
 *
 * Per camera the detector first learns a reference view (sharpness, brightness, a coarse picture and a coarse edge
 * map) and then follows slow changes such as daylight. A condition must hold for `holdMs` before it is reported, once;
 * it is reported again only after it has been gone for `clearMs`. While a condition is suspected the reference is not
 * updated, so a sabotaged view is never learnt as normal. The one exception: a camera that stays moved for `relearnMs`
 * after the report learns its new view, because a moved camera stays moved until someone fixes it.
 *
 * Measurements are made on the picture area of the frame only (letterbox padding excluded), reduced by block averaging
 * to at most `analysisWidth` pixels wide, which also smooths sensor noise at night.
 */
export type SabotageType = 'OCCLUSION' | 'DEFOCUS' | 'DISPLACEMENT' | 'BLINDED';

export const SABOTAGE_METHOD = 'classical-v1';

export interface SabotageMeasurements {
  meanLuma: number;
  stdLuma: number;
  darkFraction: number;
  brightFraction: number;
  sharpness: number;
  referenceSharpness: number;
  /** Similarity of the view to the reference (-1..1, 1 = the same picture), the higher of the picture and edge maps. */
  similarity: number;
}

export interface SabotageFinding {
  cameraId: string;
  tenantId: string;
  type: SabotageType;
  /** 0..1, how far the measurement is past normal (see `threshold`). */
  score: number;
  /** The score above which a single frame counts towards this type. */
  threshold: number;
  startedAt: Date;
  confirmedAt: Date;
  measurements: SabotageMeasurements;
}

export interface SabotageDetectorOptions {
  /** A condition must last this long before it is reported. Default 10 s. */
  holdMs?: number;
  /** Frames without the condition for this long end it (and re-arm the report). Default 30 s. */
  clearMs?: number;
  /** A suspected condition survives this long without a matching frame (one odd frame does not reset the hold). Default 3 s. */
  graceMs?: number;
  /** Frames needed to learn the reference view. Default 20. */
  learnFrames?: number;
  /** Weight of each normal frame in the slowly followed reference. Default 0.02. */
  followRate?: number;
  /** A camera still moved this long after the report learns its new view. Default 15 min. */
  relearnMs?: number;
  /** A gap between frames longer than this drops suspected conditions (the stream was down). Default 60 s. */
  maxGapMs?: number;
  analysisWidth?: number;
  /** Share of saturated pixels (>= 250) that counts as blinded, in a scene that normally has under half that. Default 0.4. */
  blindedFraction?: number;
  /** Standard deviation of grey levels at or below which a picture is flat (nothing to see). Default 12. */
  flatStd?: number;
  /** A flat picture whose similarity to the reference is below this counts as covered. Default 0.5. */
  coveredSimilarity?: number;
  /** Sharpness at or below this share of the reference counts as out of focus. Default 0.5. */
  defocusSharpnessRatio?: number;
  /** Similarity to the reference below this, in a picture that is still sharp, counts as moved. Default 0.45. */
  displacedSimilarity?: number;
}

const THUMB_W = 32;
const THUMB_H = 18;
const EDGE_W = 16;
const EDGE_H = 9;
/** Gradient histogram for the percentile: quarter-level bins up to 256. */
const GRAD_BIN_SCALE = 4;
const GRAD_BINS = 256 * GRAD_BIN_SCALE;

interface Reference {
  frames: number;
  sharpness: number;
  stdLuma: number;
  brightFraction: number;
  thumb: Float64Array;
  edges: Float64Array;
}

interface Suspect {
  since: number;
  lastSeen: number;
  score: number;
}

interface CameraState {
  ref: Reference | null;
  lastFrameAt?: number;
  suspects: Map<SabotageType, Suspect>;
  /** Conditions already reported, with the last time each was seen. */
  active: Map<SabotageType, { reportedAt: number; lastSeen: number }>;
}

export interface FrameAnalysis extends Omit<SabotageMeasurements, 'referenceSharpness' | 'similarity'> {
  thumb: Float64Array;
  edges: Float64Array;
}

export class SabotageDetector {
  private readonly o: Required<SabotageDetectorOptions>;
  private readonly cameras = new Map<string, CameraState>();

  constructor(options: SabotageDetectorOptions = {}) {
    this.o = {
      holdMs: options.holdMs ?? 10_000,
      clearMs: options.clearMs ?? 30_000,
      graceMs: options.graceMs ?? 3_000,
      learnFrames: Math.max(1, options.learnFrames ?? 20),
      followRate: options.followRate ?? 0.02,
      relearnMs: options.relearnMs ?? 15 * 60_000,
      maxGapMs: options.maxGapMs ?? 60_000,
      analysisWidth: Math.max(EDGE_W * 2, options.analysisWidth ?? 320),
      blindedFraction: options.blindedFraction ?? 0.4,
      flatStd: options.flatStd ?? 12,
      coveredSimilarity: options.coveredSimilarity ?? 0.5,
      defocusSharpnessRatio: options.defocusSharpnessRatio ?? 0.5,
      displacedSimilarity: options.displacedSimilarity ?? 0.45,
    };
  }

  public forget(cameraId: string): void {
    this.cameras.delete(cameraId);
  }

  /** Whether the camera's reference view is learnt (false while learning). */
  public isReady(cameraId: string): boolean {
    const ref = this.cameras.get(cameraId)?.ref;
    return !!ref && ref.frames >= this.o.learnFrames;
  }

  /** Conditions currently reported and not yet cleared. */
  public activeConditions(cameraId: string): SabotageType[] {
    return [...(this.cameras.get(cameraId)?.active.keys() ?? [])];
  }

  /**
   * Looks at one sampled frame. Returns the findings confirmed by this frame (usually none). Never throws for a
   * well-formed frame; a frame whose size does not match its buffer is ignored.
   */
  public observe(frame: VideoFrame): SabotageFinding[] {
    const a = analyseFrame(frame, this.o.analysisWidth);
    if (!a) return [];
    const t = frame.sampledAt.getTime();
    let cam = this.cameras.get(frame.cameraId);
    if (!cam) {
      cam = { ref: null, suspects: new Map(), active: new Map() };
      this.cameras.set(frame.cameraId, cam);
    }
    if (cam.lastFrameAt !== undefined && t - cam.lastFrameAt > this.o.maxGapMs) cam.suspects.clear();
    cam.lastFrameAt = t;

    if (!cam.ref || cam.ref.frames < this.o.learnFrames) {
      cam.ref = learn(cam.ref, a);
      return [];
    }
    const ref = cam.ref;
    const similarity = Math.max(ncc(a.thumb, ref.thumb), ncc(a.edges, ref.edges));
    const m: SabotageMeasurements = {
      meanLuma: round(a.meanLuma),
      stdLuma: round(a.stdLuma),
      darkFraction: round(a.darkFraction),
      brightFraction: round(a.brightFraction),
      sharpness: round(a.sharpness),
      referenceSharpness: round(ref.sharpness),
      similarity: round(similarity),
    };
    const seen = this.classify(a, ref, similarity);

    const findings: SabotageFinding[] = [];
    for (const [type, score] of seen) {
      const s = cam.suspects.get(type);
      if (s && t - s.lastSeen <= this.o.graceMs) {
        s.lastSeen = t;
        s.score = score;
      } else cam.suspects.set(type, { since: t, lastSeen: t, score });
      const act = cam.active.get(type);
      if (act) {
        act.lastSeen = t;
        continue;
      }
      const sus = cam.suspects.get(type)!;
      if (t - sus.since >= this.o.holdMs) {
        cam.active.set(type, { reportedAt: t, lastSeen: t });
        findings.push({
          cameraId: frame.cameraId,
          tenantId: frame.tenantId,
          type,
          score: round(score),
          threshold: this.thresholdFor(type),
          startedAt: new Date(sus.since),
          confirmedAt: new Date(t),
          measurements: m,
        });
      }
    }
    for (const [type, s] of cam.suspects) if (t - s.lastSeen > this.o.graceMs) cam.suspects.delete(type);
    for (const [type, act] of cam.active) if (t - act.lastSeen >= this.o.clearMs) cam.active.delete(type);

    const moved = cam.active.get('DISPLACEMENT');
    if (moved && seen.has('DISPLACEMENT') && t - moved.reportedAt >= this.o.relearnMs) {
      // The camera stays moved: its new view becomes the reference (the move was reported once).
      cam.suspects.clear();
      cam.active.delete('DISPLACEMENT');
      cam.ref = learn(null, a);
    } else if (seen.size === 0 && cam.suspects.size === 0 && cam.active.size === 0) {
      follow(ref, a, this.o.followRate);
    }
    return findings;
  }

  /** Scores of the conditions this frame shows: at most one, checked in the order blinded, covered, defocused, moved. */
  private classify(a: FrameAnalysis, ref: Reference, similarity: number): Map<SabotageType, number> {
    const out = new Map<SabotageType, number>();
    if (a.brightFraction >= this.o.blindedFraction && ref.brightFraction < this.o.blindedFraction / 2) {
      out.set('BLINDED', a.brightFraction);
      return out;
    }
    // A reference with almost no detail (a blank wall, a dark scene) cannot show that detail went missing.
    if (ref.stdLuma <= this.o.flatStd * 1.5) return out;
    const flat = a.stdLuma <= this.o.flatStd || a.darkFraction >= 0.95;
    const ratio = a.sharpness / Math.max(ref.sharpness, 1e-6);
    if (flat && similarity < this.o.coveredSimilarity) out.set('OCCLUSION', clamp01(1 - similarity));
    else if (!flat && ratio <= this.o.defocusSharpnessRatio) out.set('DEFOCUS', clamp01(1 - ratio));
    else if (!flat && similarity < this.o.displacedSimilarity) out.set('DISPLACEMENT', clamp01(1 - similarity));
    return out;
  }

  private thresholdFor(type: SabotageType): number {
    switch (type) {
      case 'BLINDED':
        return this.o.blindedFraction;
      case 'OCCLUSION':
        return round(1 - this.o.coveredSimilarity);
      case 'DEFOCUS':
        return round(1 - this.o.defocusSharpnessRatio);
      case 'DISPLACEMENT':
        return round(1 - this.o.displacedSimilarity);
    }
  }
}

/** The picture area of the frame (padding excluded) as block-averaged grey levels, and the measurements on it. */
export function analyseFrame(frame: Pick<VideoFrame, 'data' | 'width' | 'height' | 'geometry'>, analysisWidth = 320): FrameAnalysis | null {
  const { width, height, data, geometry: g } = frame;
  if (!width || !height || data.length < width * height * 3) return null;
  const x0 = Math.max(0, Math.round(g?.padX ?? 0));
  const y0 = Math.max(0, Math.round(g?.padY ?? 0));
  const cw = Math.min(width - x0, Math.round(g?.scaledWidth ?? (g ? g.sourceWidth * g.scale : width)));
  const ch = Math.min(height - y0, Math.round(g?.scaledHeight ?? (g ? g.sourceHeight * g.scale : height)));
  if (cw < EDGE_W * 2 || ch < EDGE_H * 2) return null;

  const block = Math.max(1, Math.floor(cw / analysisWidth));
  const w = Math.floor(cw / block);
  const h = Math.floor(ch / block);
  const grey = new Float64Array(w * h);
  const n = block * block;
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let s = 0;
      for (let dy = 0; dy < block; dy++) {
        let i = ((y0 + by * block + dy) * width + x0 + bx * block) * 3;
        for (let dx = 0; dx < block; dx++, i += 3) s += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      }
      grey[by * w + bx] = s / n;
    }
  }

  let sum = 0;
  let sq = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < grey.length; i++) {
    const v = grey[i];
    sum += v;
    sq += v * v;
    if (v < 20) dark++;
    if (v >= 250) bright++;
  }
  const mean = sum / grey.length;
  const std = Math.sqrt(Math.max(0, sq / grey.length - mean * mean));

  // Gradient magnitude (central differences): its 99th percentile, divided by the picture's contrast, is the
  // sharpness. Strong edges lose height when the lens is out of focus; sensor noise and dim light barely move it.
  // The mean gradient per coarse cell is the edge map.
  const hist = new Uint32Array(GRAD_BINS);
  const edges = new Float64Array(EDGE_W * EDGE_H);
  const edgeCount = new Float64Array(EDGE_W * EDGE_H);
  let gradN = 0;
  for (let y = 1; y < h - 1; y++) {
    const cy = Math.min(EDGE_H - 1, Math.floor((y * EDGE_H) / h));
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = Math.hypot(grey[i + 1] - grey[i - 1], grey[i + w] - grey[i - w]) / 2;
      hist[Math.min(GRAD_BINS - 1, Math.floor(v * GRAD_BIN_SCALE))]++;
      gradN++;
      const c = cy * EDGE_W + Math.min(EDGE_W - 1, Math.floor((x * EDGE_W) / w));
      edges[c] += v;
      edgeCount[c]++;
    }
  }
  for (let c = 0; c < edges.length; c++) edges[c] = edgeCount[c] ? edges[c] / edgeCount[c] : 0;
  let p99 = 0;
  const rank = Math.floor(0.99 * (gradN - 1));
  for (let b = 0, seen = 0; b < GRAD_BINS; b++) {
    seen += hist[b];
    if (seen > rank) {
      p99 = (b + 0.5) / GRAD_BIN_SCALE;
      break;
    }
  }

  const thumb = new Float64Array(THUMB_W * THUMB_H);
  const thumbCount = new Float64Array(THUMB_W * THUMB_H);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(THUMB_H - 1, Math.floor((y * THUMB_H) / h));
    for (let x = 0; x < w; x++) {
      const c = ty * THUMB_W + Math.min(THUMB_W - 1, Math.floor((x * THUMB_W) / w));
      thumb[c] += grey[y * w + x];
      thumbCount[c]++;
    }
  }
  for (let c = 0; c < thumb.length; c++) thumb[c] = thumbCount[c] ? thumb[c] / thumbCount[c] : 0;

  return {
    meanLuma: mean,
    stdLuma: std,
    darkFraction: dark / grey.length,
    brightFraction: bright / grey.length,
    sharpness: p99 / (std + 1),
    thumb,
    edges,
  };
}

/** Normalised cross-correlation (-1..1); 0 when either side is flat. Ignores overall brightness and contrast. */
export function ncc(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da < 1e-9 || db < 1e-9) return 0;
  return num / Math.sqrt(da * db);
}

function learn(ref: Reference | null, a: FrameAnalysis): Reference {
  if (!ref) {
    return { frames: 1, sharpness: a.sharpness, stdLuma: a.stdLuma, brightFraction: a.brightFraction, thumb: Float64Array.from(a.thumb), edges: Float64Array.from(a.edges) };
  }
  // Running mean while learning.
  const k = 1 / (ref.frames + 1);
  ref.frames++;
  blend(ref, a, k);
  return ref;
}

function follow(ref: Reference, a: FrameAnalysis, rate: number): void {
  blend(ref, a, rate);
}

function blend(ref: Reference, a: FrameAnalysis, k: number): void {
  ref.sharpness += (a.sharpness - ref.sharpness) * k;
  ref.stdLuma += (a.stdLuma - ref.stdLuma) * k;
  ref.brightFraction += (a.brightFraction - ref.brightFraction) * k;
  for (let i = 0; i < ref.thumb.length; i++) ref.thumb[i] += (a.thumb[i] - ref.thumb[i]) * k;
  for (let i = 0; i < ref.edges.length; i++) ref.edges[i] += (a.edges[i] - ref.edges[i]) * k;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}
