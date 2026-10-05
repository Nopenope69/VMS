/**
 * Alarm second opinion (Phase 5 Wave C, ADR 0005 decision 2): SmolVLM2 served by llama.cpp's llama-server.
 *
 * The worker starts llama-server itself, as a child process, with the model files it has just verified
 * (pinned SHA-256 and, for these candidate models, a human approval per hash), on a loopback port with a
 * fresh random API key. It then checks that the server reports the pinned llama.cpp commit and the verified
 * model path before it answers anything. So the model that answers is provably the one named in provenance.
 *
 * The prompt is a fixed, versioned template from the pipeline file; callers name only an object class from
 * the pipeline's list. Output is constrained by a JSON schema (answer: yes | no | unclear, a short reason),
 * decoding is greedy (temperature 0) with a fixed seed, and anything that does not parse to that shape is an
 * error, never a guessed answer.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AnprLoadError } from '../anpr/anprService';
import { sha256File, startLlamaServer } from '../llama/llamaServer';
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

export interface VlmPipelineDefinition {
  name: string;
  version: string;
  tasks: string[];
  components: Array<{ role: string; key: string; sha256: string }>;
  llamaCpp: { tag: string; commit: string; repository: string };
  generation: { temperature: number; seed: number; maxTokens: number; contextSize: number };
  prompt: { templateVersion: string; system: string; question: string; reasonMaxChars: number };
  targetClasses: string[];
}

export interface VlmAnswer {
  answer: 'yes' | 'no' | 'unclear';
  reason: string;
  promptSha256: string;
}

export interface VlmComponent {
  role: string;
  entry: ModelLockEntry;
  approval: ModelLicenseApproval | null;
  file: string;
}

export interface LoadedVlmPipeline {
  definition: VlmPipelineDefinition;
  definitionSha256: string;
  components: VlmComponent[];
  /** llama-server as it reported itself, e.g. "b1-eae11d2", and the binary's SHA-256. */
  runtime: { buildInfo: string; binarySha256: string };
  /** Asks whether `targetClass` is visible in the JPEG. Throws on any failure. */
  ask(jpeg: Buffer, targetClass: string, deadlineMs: number): Promise<VlmAnswer>;
  /** True while the llama-server child is running. */
  alive(): boolean;
  close(): Promise<void>;
}

export class VlmRuntimeError extends Error {}

export function resolveVlmPipelinePath(): string {
  return path.join(path.dirname(resolveModelLockPath()), 'pipelines', 'vlm-smolvlm2-v1.json');
}

/** The JSON schema llama-server constrains the output to. Part of the prompt hash. */
export function answerSchema(def: VlmPipelineDefinition) {
  return {
    type: 'object',
    properties: {
      answer: { type: 'string', enum: ['yes', 'no', 'unclear'] },
      reason: { type: 'string', maxLength: def.prompt.reasonMaxChars },
    },
    required: ['answer', 'reason'],
    additionalProperties: false,
  };
}

/** The exact question for a class, or throws if the class is not one the pipeline allows. */
export function buildQuestion(def: VlmPipelineDefinition, targetClass: string): string {
  if (!def.targetClasses.includes(targetClass)) throw new VlmRuntimeError(`target class '${targetClass}' is not one this pipeline checks (${def.targetClasses.join(', ')})`);
  return def.prompt.question.replace('{targetClass}', targetClass);
}

/** SHA-256 over everything that shapes the answer except the image: template, question, settings, schema. */
export function promptSha256(def: VlmPipelineDefinition, targetClass: string): string {
  const canonical = JSON.stringify({
    templateVersion: def.prompt.templateVersion,
    system: def.prompt.system,
    question: buildQuestion(def, targetClass),
    generation: def.generation,
    schema: answerSchema(def),
    llamaCppCommit: def.llamaCpp.commit,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Parses the model's constrained output; throws unless it is exactly {answer, reason}. */
export function parseAnswer(content: unknown, reasonMaxChars: number): { answer: VlmAnswer['answer']; reason: string } {
  if (typeof content !== 'string') throw new VlmRuntimeError('the model returned no text');
  let j: any;
  try {
    j = JSON.parse(content);
  } catch {
    throw new VlmRuntimeError('the model output is not JSON');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new VlmRuntimeError('the model output is not an object');
  const keys = Object.keys(j).sort();
  if (keys.length !== 2 || keys[0] !== 'answer' || keys[1] !== 'reason') throw new VlmRuntimeError(`the model output has keys ${keys.join(', ')}`);
  if (!['yes', 'no', 'unclear'].includes(j.answer)) throw new VlmRuntimeError(`the model answered '${String(j.answer).slice(0, 40)}'`);
  if (typeof j.reason !== 'string' || j.reason.length > reasonMaxChars) throw new VlmRuntimeError('the model reason is missing or too long');
  return { answer: j.answer, reason: j.reason.trim() };
}

function loadDefinition(defPath: string): { def: VlmPipelineDefinition; sha: string } {
  if (!fs.existsSync(defPath)) throw new AnprLoadError('ARTIFACT_MISSING', `pipeline definition ${defPath} not found`);
  const raw = fs.readFileSync(defPath);
  const def = JSON.parse(raw.toString('utf8')) as VlmPipelineDefinition;
  const ok =
    Array.isArray(def.components) &&
    Array.isArray(def.tasks) &&
    def.tasks.includes('vlm_verification') &&
    /^[a-f0-9]{40}$/.test(def.llamaCpp?.commit || '') &&
    def.generation?.temperature === 0 &&
    Array.isArray(def.targetClasses) &&
    def.targetClasses.length > 0 &&
    typeof def.prompt?.question === 'string' &&
    def.prompt.question.includes('{targetClass}');
  if (!ok) throw new AnprLoadError('INVALID_PIPELINE', `${defPath} is not a vlm_verification pipeline (needs a pinned llama.cpp commit, temperature 0, target classes and a question template)`);
  return { def, sha: crypto.createHash('sha256').update(raw).digest('hex') };
}

/** Verifies the pinned files (and approvals unless evaluationOnly) and returns their paths by role. */
export async function verifyVlmComponents(def: VlmPipelineDefinition, opts: { evaluationOnly?: boolean; modelsDir?: string } = {}): Promise<VlmComponent[]> {
  const lock = readModelLock();
  const modelsDir = opts.modelsDir ?? resolveModelsDir();
  const out: VlmComponent[] = [];
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
    const got = await sha256File(file);
    if (got !== entry.sha256) throw new AnprLoadError('MODEL_INTEGRITY_FAILED', `${file} has SHA-256 ${got}, expected ${entry.sha256}`);
    out.push({ role: c.role, entry, approval, file });
  }
  if (!out.some((c) => c.role === 'vlm_language_model') || !out.some((c) => c.role === 'vlm_projector')) {
    throw new AnprLoadError('INVALID_PIPELINE', 'a vlm_language_model and a vlm_projector component are required');
  }
  return out;
}

export interface VlmLoadOptions {
  definitionPath?: string;
  evaluationOnly?: boolean;
  modelsDir?: string;
  /** Path of the llama-server binary; default $VLM_LLAMA_SERVER_BIN. */
  serverBin?: string;
  threads?: number;
  startupTimeoutMs?: number;
}

export async function loadVlmPipeline(opts: VlmLoadOptions = {}): Promise<LoadedVlmPipeline> {
  const { def, sha } = loadDefinition(opts.definitionPath ?? resolveVlmPipelinePath());
  const components = await verifyVlmComponents(def, opts);
  const bin = opts.serverBin ?? process.env.VLM_LLAMA_SERVER_BIN;
  if (!bin) throw new AnprLoadError('ARTIFACT_MISSING', 'VLM_LLAMA_SERVER_BIN is not set (path of the llama-server binary built from the pinned llama.cpp commit)');
  const model = components.find((c) => c.role === 'vlm_language_model')!.file;
  const mmproj = components.find((c) => c.role === 'vlm_projector')!.file;
  const server = await startLlamaServer({
    bin,
    model,
    extraArgs: ['--mmproj', mmproj],
    contextSize: def.generation.contextSize,
    threads: opts.threads ?? (Number(process.env.VLM_THREADS) || undefined),
    commit: def.llamaCpp.commit,
    tag: def.llamaCpp.tag,
    requireVision: true,
    startupTimeoutMs: opts.startupTimeoutMs,
  });
  const { base, headers: auth } = server;
  try {
    return {
      definition: def,
      definitionSha256: sha,
      components,
      runtime: { buildInfo: server.buildInfo, binarySha256: server.binarySha256 },
      alive: () => !server.exited(),
      close: server.close,
      async ask(jpeg, targetClass, deadlineMs) {
        const gone = server.exited();
        if (gone) throw new VlmRuntimeError(gone);
        const question = buildQuestion(def, targetClass);
        const body = {
          messages: [
            { role: 'system', content: def.prompt.system },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } },
                { type: 'text', text: question },
              ],
            },
          ],
          temperature: def.generation.temperature,
          seed: def.generation.seed,
          max_tokens: def.generation.maxTokens,
          response_format: { type: 'json_schema', json_schema: { schema: answerSchema(def) } },
        };
        let json: any;
        try {
          const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(body), signal: AbortSignal.timeout(deadlineMs) });
          json = await r.json();
          if (!r.ok) throw new VlmRuntimeError(`llama-server returned HTTP ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
        } catch (e: any) {
          if (e instanceof VlmRuntimeError) throw e;
          throw new VlmRuntimeError(`llama-server request failed: ${e.message}`);
        }
        if (json?.choices?.[0]?.finish_reason === 'length') throw new VlmRuntimeError('the model ran out of tokens before finishing its answer');
        const parsed = parseAnswer(json?.choices?.[0]?.message?.content, def.prompt.reasonMaxChars);
        return { ...parsed, promptSha256: promptSha256(def, targetClass) };
      },
    };
  } catch (e) {
    await server.close();
    throw e;
  }
}
