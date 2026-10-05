/**
 * Client for the query-rewrite adapter (ai-adapter.v1.2, task `query_rewrite`, POST /v1/rewrite-text).
 *
 * The contract checks (health READY, task served, model registered as an ACTIVE query_rewrite model with the same
 * name, version and SHA-256, the answer validated and naming that model) are AiAdapterClient's. The rewrite is only
 * ever read by the search rules (services/search/queryParser.ts); it never sets a filter itself. Any failure throws
 * a QueryRewriteError, and the caller falls back to the rules' own reading.
 */
import { PrismaClient } from '@prisma/client';
import { AiAdapterClient } from '../ai/aiAdapterClient';

export const QUERY_REWRITE_TASK = 'query_rewrite';

export type QueryRewriteErrorCode = 'QUERY_REWRITE_UNAVAILABLE' | 'QUERY_REWRITE_INVALID' | 'QUERY_REWRITE_NOT_REGISTERED';

export class QueryRewriteError extends Error {
  constructor(public readonly code: QueryRewriteErrorCode, message: string) {
    super(message);
    this.name = 'QueryRewriteError';
  }
}

export interface QueryRewriteModel {
  name: string;
  version: string;
  sha256: string;
}

export interface QueryRewriteResult {
  english: string;
  promptSha256: string;
  model: QueryRewriteModel;
  inferenceId: string;
  latencyMs: number;
}

const CODES = { unavailable: 'QUERY_REWRITE_UNAVAILABLE', invalid: 'QUERY_REWRITE_INVALID', unregistered: 'QUERY_REWRITE_NOT_REGISTERED' } as const;

export interface QueryRewriter {
  rewrite(tenantId: string, text: string, vocabulary: string[]): Promise<QueryRewriteResult>;
}

export class QueryRewriteClient implements QueryRewriter {
  private modelId: string | null = null;
  private model: QueryRewriteModel | null = null;
  private readonly adapter: AiAdapterClient;

  constructor(private readonly prisma: PrismaClient, baseUrl: string, private readonly timeoutMs = 20000) {
    this.adapter = new AiAdapterClient(baseUrl, { name: 'query rewrite adapter', timeoutMs, probeTimeoutMs: 5000, fail: (kind, m) => new QueryRewriteError(CODES[kind], m) });
  }

  /** Checks health, descriptor and the model registry. Called on first use and again after a failure. */
  async connect(): Promise<QueryRewriteModel> {
    const desc = await this.adapter.probe([QUERY_REWRITE_TASK]);
    const card = await this.adapter.registeredCard(this.prisma, desc, QUERY_REWRITE_TASK);
    this.modelId = card.modelId;
    this.model = { name: card.name, version: card.version, sha256: card.sha256 };
    return this.model;
  }

  async rewrite(tenantId: string, text: string, vocabulary: string[]): Promise<QueryRewriteResult> {
    try {
      if (!this.modelId || !this.model) await this.connect();
      const res = await this.adapter.call('/v1/rewrite-text', { tenantId, modelId: this.modelId, text, vocabulary: vocabulary.slice(0, 64), deadlineMs: this.timeoutMs }, this.model!);
      if (!res.rewrite) throw new QueryRewriteError('QUERY_REWRITE_INVALID', 'an ok result carries no rewrite');
      return { english: res.rewrite.text, promptSha256: res.rewrite.promptSha256, model: this.model!, inferenceId: res.provenance.inferenceId, latencyMs: Math.round(res.latencyMs) };
    } catch (e) {
      // Re-verify the adapter and its registration on the next call.
      this.modelId = null;
      this.model = null;
      throw e;
    }
  }
}

/** QUERY_LLM_ADAPTER_URL as an http(s) URL, or null when unset (plain-language search then runs on rules only). */
export function queryRewriteAdapterUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.QUERY_LLM_ADAPTER_URL?.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`QUERY_LLM_ADAPTER_URL is not a URL: "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`QUERY_LLM_ADAPTER_URL must be http or https, got "${u.protocol}"`);
  return raw.replace(/\/+$/, '');
}

let shared: { url: string; client: QueryRewriteClient } | null = null;
let override: QueryRewriter | null | undefined;

/** Test hook: replace (or with null, remove) the rewriter. undefined restores the default. */
export function setQueryRewriterForTests(r: QueryRewriter | null | undefined) {
  override = r;
}

/** The adapter-backed rewriter, or null when QUERY_LLM_ADAPTER_URL is not set. */
export function queryRewriter(): QueryRewriter | null {
  if (override !== undefined) return override;
  const url = queryRewriteAdapterUrl();
  if (!url) return null;
  if (!shared || shared.url !== url) {
    const prisma = require('../../config/database').default as PrismaClient;
    shared = { url, client: new QueryRewriteClient(prisma, url) };
  }
  return shared.client;
}
