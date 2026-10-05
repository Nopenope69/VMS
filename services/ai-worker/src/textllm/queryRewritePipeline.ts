/**
 * Plain-language search, the model part: Qwen3-4B served by llama.cpp's llama-server (a child of the worker, started
 * with the file it has just verified; see llama/llamaServer.ts). It rewrites a search request the backend's word
 * list cannot read (Devanagari place names, unusual wording) into plain English. The backend's rules then read the
 * English and set every filter; the model never sets one.
 *
 * The prompt is a fixed, versioned template from the pipeline file; the caller gives only the request and the
 * site's place names. Thinking is switched off, decoding is greedy with a fixed seed, the output is constrained to
 * {"english": "..."}, and anything else is an error, never a guessed rewrite.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AnprLoadError } from '../anpr/anprService';
import { sha256File, startLlamaServer, LlamaServer } from '../llama/llamaServer';
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

export interface QueryRewriteDefinition {
  name: string;
  version: string;
  tasks: string[];
  components: Array<{ role: string; key: string; sha256: string }>;
  llamaCpp: { tag: string; commit: string; repository: string };
  generation: { temperature: number; seed: number; maxTokens: number; contextSize: number; thinking: boolean };
  prompt: { templateVersion: string; system: string; examples: Array<{ request: string; english: string }>; englishMaxChars: number; vocabularyMax: number };
}

export interface QueryRewriteComponent {
  role: string;
  entry: ModelLockEntry;
  approval: ModelLicenseApproval | null;
  file: string;
}

export interface LoadedQueryRewritePipeline {
  definition: QueryRewriteDefinition;
  definitionSha256: string;
  components: QueryRewriteComponent[];
  runtime: { buildInfo: string; binarySha256: string };
  rewrite(text: string, vocabulary: string[], deadlineMs: number): Promise<{ text: string; promptSha256: string }>;
  alive(): boolean;
  close(): Promise<void>;
}

export class QueryRewriteError extends Error {}

export function resolveQueryRewritePipelinePath(): string {
  return path.join(path.dirname(resolveModelLockPath()), 'pipelines', 'query-rewrite-qwen3-4b-v1.json');
}

/** The JSON schema the output is constrained to. Part of the prompt hash. */
export function rewriteSchema(def: QueryRewriteDefinition) {
  return {
    type: 'object',
    properties: { english: { type: 'string', minLength: 1, maxLength: def.prompt.englishMaxChars } },
    required: ['english'],
    additionalProperties: false,
  };
}

/** Place names as they go into the prompt: trimmed, deduplicated, sorted (so the hash does not depend on order). */
export function cleanVocabulary(def: QueryRewriteDefinition, vocabulary: string[]): string[] {
  const names = [...new Set(vocabulary.map((v) => v.replace(/[\r\n"{}]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))].sort();
  if (names.length > def.prompt.vocabularyMax) throw new QueryRewriteError(`at most ${def.prompt.vocabularyMax} place names`);
  return names;
}

export function buildMessages(def: QueryRewriteDefinition, text: string, vocabulary: string[]) {
  const system = def.prompt.system.replace('{vocabulary}', vocabulary.length ? vocabulary.join(', ') : '(none)');
  const shots = def.prompt.examples.flatMap((e) => [
    { role: 'user', content: e.request },
    { role: 'assistant', content: JSON.stringify({ english: e.english }) },
  ]);
  return [{ role: 'system', content: system }, ...shots, { role: 'user', content: text }];
}

/** SHA-256 over everything that shapes the rewrite except the request itself. */
export function promptSha256(def: QueryRewriteDefinition, vocabulary: string[]): string {
  const canonical = JSON.stringify({
    templateVersion: def.prompt.templateVersion,
    system: def.prompt.system,
    examples: def.prompt.examples,
    vocabulary,
    generation: def.generation,
    schema: rewriteSchema(def),
    llamaCppCommit: def.llamaCpp.commit,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Parses the constrained output; throws unless it is exactly {english}. */
export function parseRewrite(content: unknown, maxChars: number): string {
  if (typeof content !== 'string') throw new QueryRewriteError('the model returned no text');
  let j: any;
  try {
    j = JSON.parse(content);
  } catch {
    throw new QueryRewriteError('the model output is not JSON');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || Object.keys(j).length !== 1 || typeof j.english !== 'string') {
    throw new QueryRewriteError('the model output is not {"english": "..."}');
  }
  const english = j.english.replace(/\s+/g, ' ').trim();
  if (!english || english.length > maxChars) throw new QueryRewriteError('the rewrite is empty or too long');
  return english;
}

function loadDefinition(defPath: string): { def: QueryRewriteDefinition; sha: string } {
  if (!fs.existsSync(defPath)) throw new AnprLoadError('ARTIFACT_MISSING', `pipeline definition ${defPath} not found`);
  const raw = fs.readFileSync(defPath);
  const def = JSON.parse(raw.toString('utf8')) as QueryRewriteDefinition;
  const ok =
    Array.isArray(def.components) &&
    def.components.length === 1 &&
    Array.isArray(def.tasks) &&
    def.tasks.includes('query_rewrite') &&
    /^[a-f0-9]{40}$/.test(def.llamaCpp?.commit || '') &&
    def.generation?.temperature === 0 &&
    def.generation?.thinking === false &&
    typeof def.prompt?.system === 'string' &&
    def.prompt.system.includes('{vocabulary}') &&
    Array.isArray(def.prompt.examples);
  if (!ok) throw new AnprLoadError('INVALID_PIPELINE', `${defPath} is not a query_rewrite pipeline (needs one model, a pinned llama.cpp commit, temperature 0, thinking off and a prompt with {vocabulary})`);
  return { def, sha: crypto.createHash('sha256').update(raw).digest('hex') };
}

export interface QueryRewriteLoadOptions {
  definitionPath?: string;
  /** Skip the licence approval (evaluation only; never in the product). */
  evaluationOnly?: boolean;
  modelsDir?: string;
  /** Path of the llama-server binary; default $QUERY_LLM_LLAMA_SERVER_BIN, then $VLM_LLAMA_SERVER_BIN. */
  serverBin?: string;
  threads?: number;
  startupTimeoutMs?: number;
}

export async function loadQueryRewritePipeline(opts: QueryRewriteLoadOptions = {}): Promise<LoadedQueryRewritePipeline> {
  const { def, sha } = loadDefinition(opts.definitionPath ?? resolveQueryRewritePipelinePath());
  const lock = readModelLock();
  const modelsDir = opts.modelsDir ?? resolveModelsDir();
  const c = def.components[0];
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
  const components = [{ role: c.role, entry, approval, file }];

  const bin = opts.serverBin ?? process.env.QUERY_LLM_LLAMA_SERVER_BIN ?? process.env.VLM_LLAMA_SERVER_BIN;
  if (!bin) throw new AnprLoadError('ARTIFACT_MISSING', 'QUERY_LLM_LLAMA_SERVER_BIN is not set (path of the llama-server binary built from the pinned llama.cpp commit)');
  const server: LlamaServer = await startLlamaServer({
    bin,
    model: file,
    contextSize: def.generation.contextSize,
    threads: opts.threads ?? (Number(process.env.QUERY_LLM_THREADS) || undefined),
    commit: def.llamaCpp.commit,
    tag: def.llamaCpp.tag,
    jinja: true,
    startupTimeoutMs: opts.startupTimeoutMs,
  });

  return {
    definition: def,
    definitionSha256: sha,
    components,
    runtime: { buildInfo: server.buildInfo, binarySha256: server.binarySha256 },
    alive: () => !server.exited(),
    close: server.close,
    async rewrite(text, vocabulary, deadlineMs) {
      const gone = server.exited();
      if (gone) throw new QueryRewriteError(gone);
      const names = cleanVocabulary(def, vocabulary);
      const body = {
        messages: buildMessages(def, text, names),
        temperature: def.generation.temperature,
        seed: def.generation.seed,
        max_tokens: def.generation.maxTokens,
        response_format: { type: 'json_schema', json_schema: { schema: rewriteSchema(def) } },
        chat_template_kwargs: { enable_thinking: def.generation.thinking },
      };
      let json: any;
      try {
        const r = await fetch(`${server.base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(deadlineMs) });
        json = await r.json();
        if (!r.ok) throw new QueryRewriteError(`llama-server returned HTTP ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
      } catch (e: any) {
        if (e instanceof QueryRewriteError) throw e;
        throw new QueryRewriteError(`llama-server request failed: ${e.message}`);
      }
      if (json?.choices?.[0]?.finish_reason === 'length') throw new QueryRewriteError('the model ran out of tokens before finishing the rewrite');
      return { text: parseRewrite(json?.choices?.[0]?.message?.content, def.prompt.englishMaxChars), promptSha256: promptSha256(def, names) };
    },
  };
}
