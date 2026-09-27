import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { OrtSession } from './ortSession';
import { TextDetector, DbConfig } from './textDetector';
import { PlateOcr, parsePlateConfig } from './plateOcr';
import { AnprPipeline } from './anprPipeline';
import {
  artifactPathFor,
  assertCandidateApproved,
  findCandidateEntry,
  ModelLicenseApproval,
  ModelLockEntry,
  readModelLock,
  resolveModelLockPath,
  resolveModelsDir,
} from '../modelCatalog';

/**
 * Loads the ANPR pipeline named by a pipeline definition (scripts/models/pipelines/*.json):
 * every component must be a pinned model whose file on disk has the pinned SHA-256, and, since
 * the components are candidate models, a human approval for that exact hash unless
 * `evaluationOnly` is set (tests and evaluation tools only; never set by main.ts).
 */
export interface PipelineDefinition {
  name: string;
  version: string;
  task: 'plate_recognition';
  components: Array<{ role: string; key: string; sha256: string }>;
  textDetection: DbConfig;
  recognition: { minConfidence: number; requireValidFormat: boolean };
}

export interface LoadedAnprPipeline {
  pipeline: AnprPipeline;
  definition: PipelineDefinition;
  definitionSha256: string;
  components: Array<{ role: string; entry: ModelLockEntry; approval: ModelLicenseApproval | null }>;
}

export class AnprLoadError extends Error {
  constructor(public readonly code: 'LICENSE_REJECTED' | 'MODEL_INTEGRITY_FAILED' | 'ARTIFACT_MISSING' | 'INVALID_PIPELINE', message: string) {
    super(`${code}: ${message}`);
  }
}

export function resolvePipelinePath(name = 'anpr-india-v1'): string {
  return path.join(path.dirname(resolveModelLockPath()), 'pipelines', `${name}.json`);
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export async function loadAnprPipeline(opts: { definitionPath?: string; evaluationOnly?: boolean; modelsDir?: string } = {}): Promise<LoadedAnprPipeline> {
  const defPath = opts.definitionPath ?? resolvePipelinePath();
  if (!fs.existsSync(defPath)) throw new AnprLoadError('ARTIFACT_MISSING', `pipeline definition ${defPath} not found`);
  const raw = fs.readFileSync(defPath);
  const def = JSON.parse(raw.toString('utf8')) as PipelineDefinition;
  if (def.task !== 'plate_recognition' || !Array.isArray(def.components)) throw new AnprLoadError('INVALID_PIPELINE', `${defPath} is not a plate_recognition pipeline`);
  const lock = readModelLock();
  const modelsDir = opts.modelsDir ?? resolveModelsDir();
  const loaded: LoadedAnprPipeline['components'] = [];
  const buffers: Record<string, Buffer> = {};
  for (const c of def.components) {
    const entry = findCandidateEntry(c.key, lock);
    if (entry.sha256 !== c.sha256) throw new AnprLoadError('INVALID_PIPELINE', `${c.key}: pipeline pins ${c.sha256}, lock file has ${entry.sha256}`);
    let approval: ModelLicenseApproval | null = null;
    if (!opts.evaluationOnly) {
      try {
        approval = assertCandidateApproved(entry);
      } catch (e: any) {
        throw new AnprLoadError('LICENSE_REJECTED', e.message.replace(/^LICENSE_REJECTED: /, ''));
      }
    }
    const file = artifactPathFor(entry, modelsDir);
    if (!fs.existsSync(file)) throw new AnprLoadError('ARTIFACT_MISSING', `${file} (scripts/models/fetch-model.sh ${c.key})`);
    const buf = fs.readFileSync(file);
    const got = sha(buf);
    if (got !== entry.sha256) throw new AnprLoadError('MODEL_INTEGRITY_FAILED', `${file} has SHA-256 ${got}, expected ${entry.sha256}`);
    for (const x of entry.extraFiles || []) {
      const xf = path.join(modelsDir, x.fileName);
      if (!fs.existsSync(xf)) throw new AnprLoadError('ARTIFACT_MISSING', xf);
      const xb = fs.readFileSync(xf);
      if (sha(xb) !== x.sha256) throw new AnprLoadError('MODEL_INTEGRITY_FAILED', `${xf} does not match its pinned SHA-256`);
      buffers[`${c.role}:${x.fileName}`] = xb;
    }
    buffers[c.role] = buf;
    loaded.push({ role: c.role, entry, approval });
  }
  const detEntry = loaded.find((l) => l.role === 'text_detector');
  const ocrEntry = loaded.find((l) => l.role === 'plate_ocr');
  if (!detEntry || !ocrEntry) throw new AnprLoadError('INVALID_PIPELINE', 'a text_detector and a plate_ocr component are required');
  const cfgName = ocrEntry.entry.extraFiles?.[0]?.fileName;
  if (!cfgName) throw new AnprLoadError('INVALID_PIPELINE', 'plate_ocr needs its config file');
  const detector = new TextDetector(await OrtSession.create(buffers.text_detector), def.textDetection);
  const ocr = new PlateOcr(await OrtSession.create(buffers.plate_ocr), parsePlateConfig(buffers[`plate_ocr:${cfgName}`].toString('utf8')));
  return { pipeline: new AnprPipeline(detector, ocr), definition: def, definitionSha256: sha(raw), components: loaded };
}
