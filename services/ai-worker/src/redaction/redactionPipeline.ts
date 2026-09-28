/**
 * Redaction regions pipeline (P4.4): faces (YuNet) and plate-like text regions (PP-OCRv4 DB text
 * detection grouped into plate candidates, no OCR). Used by the redaction adapter; the backend
 * turns per-frame regions into temporal masks and burns them into a derivative with ffmpeg.
 *
 * Plate regions deliberately over-cover: every text group with plate-like geometry is returned
 * (stickers and badges too), because a missed plate is a privacy failure and an extra mask is not.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { OrtSession } from '../anpr/ortSession';
import { TextDetector, DbConfig } from '../anpr/textDetector';
import { groupCandidates } from '../anpr/plateCandidates';
import { Image3 } from '../anpr/imageOps';
import { AnprLoadError, VerifiedComponent, verifyPipelineComponents } from '../anpr/anprService';
import { resolveModelLockPath } from '../modelCatalog';
import { FaceDetector, FaceDetectorOptions } from './faceDetector';

export interface RedactionPipelineDefinition {
  name: string;
  version: string;
  tasks: string[];
  components: Array<{ role: string; key: string; sha256: string }>;
  faceDetection: FaceDetectorOptions;
  textDetection: DbConfig;
  plateRegions: { minHeightPx: number; padFraction: number };
}

export interface Region {
  kind: 'face' | 'license_plate';
  /** [x1, y1, x2, y2] in frame pixels. */
  box: [number, number, number, number];
  score: number;
}

export interface LoadedRedactionPipeline {
  definition: RedactionPipelineDefinition;
  definitionSha256: string;
  components: VerifiedComponent[];
  faces(img: Image3): Promise<Region[]>;
  plates(img: Image3): Promise<Region[]>;
}

export function resolveRedactionPipelinePath(): string {
  return path.join(path.dirname(resolveModelLockPath()), 'pipelines', 'redaction-v1.json');
}

export async function loadRedactionPipeline(opts: { definitionPath?: string; evaluationOnly?: boolean; modelsDir?: string } = {}): Promise<LoadedRedactionPipeline> {
  const defPath = opts.definitionPath ?? resolveRedactionPipelinePath();
  if (!fs.existsSync(defPath)) throw new AnprLoadError('ARTIFACT_MISSING', `pipeline definition ${defPath} not found`);
  const raw = fs.readFileSync(defPath);
  const def = JSON.parse(raw.toString('utf8')) as RedactionPipelineDefinition;
  if (!Array.isArray(def.components) || !Array.isArray(def.tasks) || !def.tasks.includes('face_detection_for_redaction')) {
    throw new AnprLoadError('INVALID_PIPELINE', `${defPath} is not a redaction pipeline`);
  }
  const { loaded, buffers } = verifyPipelineComponents(def.components, opts);
  if (!buffers.face_detector || !buffers.text_detector) throw new AnprLoadError('INVALID_PIPELINE', 'a face_detector and a text_detector component are required');
  const face = new FaceDetector(await OrtSession.create(buffers.face_detector), def.faceDetection);
  const text = new TextDetector(await OrtSession.create(buffers.text_detector), def.textDetection);
  const pad = def.plateRegions.padFraction;
  return {
    definition: def,
    definitionSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    components: loaded,
    async faces(img) {
      return (await face.detect(img)).map((f) => ({ kind: 'face' as const, box: f.box, score: f.score }));
    },
    async plates(img) {
      const boxes = await text.detect(img);
      return groupCandidates(boxes, def.plateRegions.minHeightPx).map((c) => {
        const h = c.box[3] - c.box[1];
        const p = h * pad;
        const box: Region['box'] = [Math.max(0, c.box[0] - p), Math.max(0, c.box[1] - p), Math.min(img.width, c.box[2] + p), Math.min(img.height, c.box[3] + p)];
        const score = Math.max(0, ...boxes.filter((b) => b.points.every(([x, y]) => x >= c.box[0] - 2 && x <= c.box[2] + 2 && y >= c.box[1] - 2 && y <= c.box[3] + 2)).map((b) => b.score));
        return { kind: 'license_plate' as const, box, score };
      });
    },
  };
}
