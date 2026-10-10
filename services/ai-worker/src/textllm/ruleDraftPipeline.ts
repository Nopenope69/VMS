/**
 * Describe-what-to-watch rules, the model part: Qwen3-4B served by llama.cpp's llama-server.
 *
 * Extracts physical security operator instructions into a typed RuleIntentIR JSON structure.
 * A deterministic backend compiler then resolves physical cameras and zones, dwell thresholds,
 * and time windows before operator confirmation.
 *
 * Implements a strict SingleFlightQueue to cap concurrency to 1, ensuring zero CPU starvation
 * of primary VMS streaming, recording, and real-time alarm execution.
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
import { RuleIntentIR, parseRuleIntentIR, RuleIntentIRSchema } from './ruleIntentTypes';

export interface RuleDraftDefinition {
  name: string;
  version: string;
  tasks: string[];
  components: Array<{ role: string; key: string; sha256: string }>;
  llamaCpp: { tag: string; commit: string; repository: string };
  generation: { temperature: number; seed: number; maxTokens: number; contextSize: number; thinking: boolean };
  prompt: {
    templateVersion: string;
    system: string;
    examples: Array<{ instruction: string; ir: RuleIntentIR }>;
    maxInstructionChars: number;
    maxLocations: number;
  };
}

export interface RuleDraftComponent {
  role: string;
  entry: ModelLockEntry;
  approval: ModelLicenseApproval | null;
  file: string;
}

export interface LoadedRuleDraftPipeline {
  definition: RuleDraftDefinition;
  definitionSha256: string;
  components: RuleDraftComponent[];
  runtime: { buildInfo: string; binarySha256: string };
  extractIntent(instruction: string, locations: string[], deadlineMs: number): Promise<{ ir: RuleIntentIR; promptSha256: string }>;
  alive(): boolean;
  close(): Promise<void>;
}

export class RuleDraftError extends Error {
  constructor(message: string, public readonly code: string = 'RULE_DRAFT_ERROR') {
    super(message);
    this.name = 'RuleDraftError';
  }
}

export function resolveRuleDraftPipelinePath(): string {
  return path.join(path.dirname(resolveModelLockPath()), 'pipelines', 'rule-draft-qwen3-4b-v1.json');
}

/** Known site locations: trimmed, deduplicated, sorted (deterministic prompt hash). */
export function cleanLocations(def: RuleDraftDefinition, locations: string[]): string[] {
  const names = [...new Set(locations.map((v) => v.replace(/[\r\n"{}]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))].sort();
  if (names.length > def.prompt.maxLocations) throw new RuleDraftError(`at most ${def.prompt.maxLocations} site locations allowed`);
  return names;
}

export function buildMessages(def: RuleDraftDefinition, instruction: string, locations: string[]) {
  const system = def.prompt.system.replace('{locations}', locations.length ? locations.join(', ') : '(none)');
  const shots = def.prompt.examples.flatMap((e) => [
    { role: 'user', content: e.instruction },
    { role: 'assistant', content: JSON.stringify(e.ir) },
  ]);
  return [{ role: 'system', content: system }, ...shots, { role: 'user', content: instruction }];
}

/** SHA-256 over everything that shapes the prompt except the user prompt itself. */
export function promptSha256(def: RuleDraftDefinition, locations: string[]): string {
  const canonical = JSON.stringify({
    templateVersion: def.prompt.templateVersion,
    system: def.prompt.system,
    examples: def.prompt.examples,
    locations,
    generation: def.generation,
    llamaCppCommit: def.llamaCpp.commit,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Parses the model output into a validated RuleIntentIR. */
export function parseRuleIntent(content: unknown): RuleIntentIR {
  if (typeof content !== 'string') throw new RuleDraftError('the model returned no text');
  let rawJson = content.trim();
  // Strip markdown code fences if model enclosed them
  if (rawJson.startsWith('```')) {
    rawJson = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  let parsedObj: any;
  try {
    parsedObj = JSON.parse(rawJson);
  } catch {
    throw new RuleDraftError('the model output is not valid JSON');
  }
  try {
    return parseRuleIntentIR(parsedObj);
  } catch (err: any) {
    throw new RuleDraftError(`model output failed RuleIntentIR schema: ${err.message}`);
  }
}

export function loadDefinition(defPath: string): { def: RuleDraftDefinition; sha: string } {
  if (!fs.existsSync(defPath)) throw new AnprLoadError('ARTIFACT_MISSING', `pipeline definition ${defPath} not found`);
  const raw = fs.readFileSync(defPath);
  const def = JSON.parse(raw.toString('utf8')) as RuleDraftDefinition;
  const ok =
    Array.isArray(def.components) &&
    def.components.length === 1 &&
    Array.isArray(def.tasks) &&
    def.tasks.includes('rule_draft') &&
    /^[a-f0-9]{40}$/.test(def.llamaCpp?.commit || '') &&
    def.generation?.temperature === 0 &&
    def.generation?.thinking === false &&
    typeof def.prompt?.system === 'string' &&
    def.prompt.system.includes('{locations}') &&
    Array.isArray(def.prompt.examples);
  if (!ok) throw new AnprLoadError('INVALID_PIPELINE', `${defPath} is not a valid rule_draft pipeline`);
  return { def, sha: crypto.createHash('sha256').update(raw).digest('hex') };
}

export interface RuleDraftLoadOptions {
  definitionPath?: string;
  evaluationOnly?: boolean;
  modelsDir?: string;
  serverBin?: string;
  threads?: number;
  startupTimeoutMs?: number;
}

/**
 * Single-flight concurrency limiter: ensures only 1 inference runs at a time on edge CPU.
 * Queues up to maxQueue depth before rejecting with RULE_DRAFT_BUSY.
 */
export class SingleFlightLimiter {
  private inFlight = false;
  private queue: Array<() => void> = [];

  constructor(private readonly maxQueue = 3) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight) {
      if (this.queue.length >= this.maxQueue) {
        throw new RuleDraftError('Inference worker busy, please try again', 'RULE_DRAFT_BUSY');
      }
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight = true;
    try {
      return await fn();
    } finally {
      this.inFlight = false;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export async function loadRuleDraftPipeline(opts: RuleDraftLoadOptions = {}): Promise<LoadedRuleDraftPipeline> {
  const { def, sha } = loadDefinition(opts.definitionPath ?? resolveRuleDraftPipelinePath());
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
  if (!bin) throw new AnprLoadError('ARTIFACT_MISSING', 'QUERY_LLM_LLAMA_SERVER_BIN is not set');
  const server: LlamaServer = await startLlamaServer({
    bin,
    model: file,
    contextSize: def.generation.contextSize,
    threads: opts.threads ?? (Number(process.env.QUERY_LLM_THREADS) || 2),
    commit: def.llamaCpp.commit,
    tag: def.llamaCpp.tag,
    jinja: true,
    startupTimeoutMs: opts.startupTimeoutMs,
  });

  const limiter = new SingleFlightLimiter(3);

  return {
    definition: def,
    definitionSha256: sha,
    components,
    runtime: { buildInfo: server.buildInfo, binarySha256: server.binarySha256 },
    async extractIntent(instruction: string, locations: string[], deadlineMs: number) {
      return limiter.run(async () => {
        const gone = server.exited();
        if (gone) throw new RuleDraftError(gone);
        const cleaned = cleanLocations(def, locations);
        const pSha = promptSha256(def, cleaned);
        const messages = buildMessages(def, instruction, cleaned);
        const body = {
          messages,
          temperature: def.generation.temperature,
          seed: def.generation.seed,
          max_tokens: def.generation.maxTokens,
          chat_template_kwargs: { enable_thinking: def.generation.thinking },
        };
        let json: any;
        try {
          const r = await fetch(`${server.base}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...server.headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(deadlineMs),
          });
          json = await r.json();
          if (!r.ok) throw new RuleDraftError(`llama-server returned HTTP ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
        } catch (e: any) {
          if (e instanceof RuleDraftError) throw e;
          throw new RuleDraftError(`llama-server request failed: ${e.message}`);
        }
        if (json?.choices?.[0]?.finish_reason === 'length') {
          throw new RuleDraftError('the model ran out of tokens before finishing rule intent extraction');
        }
        const rawContent = json?.choices?.[0]?.message?.content || '';
        const ir = parseRuleIntent(rawContent);
        return { ir, promptSha256: pSha };
      });
    },
    alive: () => !server.exited(),
    close: server.close,
  };
}
