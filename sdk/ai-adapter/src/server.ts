/**
 * An ai-adapter.v1 HTTP server that enforces the contract, so an adapter author only writes the model call.
 *
 *   GET  /v1/descriptor   the adapter and its model cards (validated at start-up)
 *   GET  /v1/health       READY once every model loaded; LOADING before; FAILED with the error
 *   POST /v1/infer        InferenceRequestV1 -> InferenceResultV1
 *   POST /v1/embed-text   TextEmbeddingRequestV1 (only when a model has embedText)
 *
 * What the server guarantees, whatever the model code does:
 *   - every response is validated against the contract before it is sent; a model that returns something
 *     invalid (unknown class, box outside the frame, NaN) produces RUNTIME_ERROR, never a bad success;
 *   - provenance (model hash, adapter, a fresh inference id, the frame's own timestamp) is filled in by the
 *     server from the model card, so a success always carries it;
 *   - frames are checked (rgb24/bgr24 byte length, JPEG signature); shared-memory frames are refused;
 *   - the request deadline is enforced (DEADLINE_EXCEEDED, 504) and the model receives an AbortSignal;
 *   - bounded concurrency: beyond maxInFlight running and maxQueued waiting, OVERLOADED (429 + Retry-After);
 *   - X-Correlation-Id is echoed.
 */
import crypto from 'crypto';
import http from 'http';
import { z } from 'zod';
import {
  AI_ADAPTER_CONTRACT,
  AI_ADAPTER_ERROR_CODES,
  AdapterDescriptorV1,
  AdapterHealthV1,
  DetectionV1,
  InferenceRequestV1,
  InferenceResultV1,
  ModelCardV1,
  TextEmbeddingRequestV1,
} from './contract/aiAdapter.v1';

export type ModelCard = z.infer<typeof ModelCardV1>;
export type Detection = z.infer<typeof DetectionV1>;
export type AdapterErrorCode = (typeof AI_ADAPTER_ERROR_CODES)[number];

const HTTP_STATUS: Record<AdapterErrorCode, number> = {
  MODEL_NOT_LOADED: 503,
  MODEL_INTEGRITY_FAILED: 503,
  LICENSE_REJECTED: 503,
  UNSUPPORTED_TASK: 400,
  INVALID_FRAME: 400,
  DEADLINE_EXCEEDED: 504,
  RUNTIME_ERROR: 500,
  OVERLOADED: 429,
};
const RETRYABLE: Record<AdapterErrorCode, boolean> = {
  MODEL_NOT_LOADED: true,
  MODEL_INTEGRITY_FAILED: false,
  LICENSE_REJECTED: false,
  UNSUPPORTED_TASK: false,
  INVALID_FRAME: false,
  DEADLINE_EXCEEDED: true,
  RUNTIME_ERROR: true,
  OVERLOADED: true,
};

/** Throw this from model code to answer with a specific contract error. */
export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface Frame {
  cameraId: string;
  timestampUtc: string;
  width: number;
  height: number;
  format: 'rgb24' | 'bgr24' | 'jpeg';
  /** Raw pixels (rgb24 / bgr24, width * height * 3 bytes) or the JPEG file. */
  data: Buffer;
}

export interface InferContext {
  requestId: string;
  tenantId: string;
  /** Aborted when the deadline passes; stop work when it fires. */
  signal: AbortSignal;
}

export interface ModelOutput {
  /** Normalised boxes (0..1 of the frame); classes must be in the model card. */
  detections?: Detection[];
  /** For the embedding task: the vector (it is sent as little-endian float32, base64). */
  embedding?: Float32Array;
}

export interface AdapterModel {
  card: ModelCard;
  /** Load weights, check their SHA-256 (see verifyFileSha256). Health is LOADING until every load resolves. */
  load?(): Promise<void>;
  infer(frame: Frame, ctx: InferContext): Promise<ModelOutput>;
  embedText?(text: string, ctx: InferContext): Promise<Float32Array>;
  /** Reported in provenance (default: the card's runtime). */
  runtime?: string;
  executionProvider?: string;
}

export interface AdapterOptions {
  adapterId: string;
  adapterVersion: string;
  models: AdapterModel[];
  /** Air-gapped sites refuse adapters that need the internet. Default false. */
  requiresNetworkEgress?: boolean;
  /** Requests running at once (default 1) and waiting for a slot (default 4). */
  maxInFlight?: number;
  maxQueued?: number;
  /** Largest request body accepted (default 32 MiB). */
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

export interface Adapter {
  descriptor: z.infer<typeof AdapterDescriptorV1>;
  /** Loads every model (call once; listen() calls it for you). */
  load(): Promise<void>;
  /** The request handler, for mounting in your own server. */
  handler: http.RequestListener;
  listen(port: number, host?: string): Promise<http.Server>;
}

export function createAdapter(o: AdapterOptions): Adapter {
  const tasks = Array.from(new Set(o.models.map((m) => m.card.task)));
  const descriptor = AdapterDescriptorV1.parse({
    contract: AI_ADAPTER_CONTRACT,
    adapterId: o.adapterId,
    adapterVersion: o.adapterVersion,
    tasks,
    models: o.models.map((m) => m.card),
    requiresNetworkEgress: o.requiresNetworkEgress ?? false,
  });
  const byId = new Map(o.models.map((m) => [m.card.modelId, m]));
  if (byId.size !== o.models.length) throw new Error('model ids must be unique');
  const maxInFlight = o.maxInFlight ?? 1;
  const maxQueued = o.maxQueued ?? 4;
  const maxBody = o.maxBodyBytes ?? 32 * 1024 * 1024;

  let state: 'LOADING' | 'READY' | 'FAILED' = 'LOADING';
  let lastError: string | null = null;
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= (async () => {
      try {
        for (const m of o.models) await m.load?.();
        state = 'READY';
      } catch (e: any) {
        state = 'FAILED';
        lastError = String(e?.message ?? e);
        o.log?.(`[adapter] model load failed: ${lastError}`);
      }
    })());

  // Bounded concurrency with a small FIFO queue.
  let inFlight = 0;
  const waiters: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (inFlight < maxInFlight) {
      inFlight++;
      return Promise.resolve();
    }
    if (waiters.length >= maxQueued) return Promise.reject(new AdapterError('OVERLOADED', `adapter busy: ${inFlight} running, ${waiters.length} waiting`));
    return new Promise((resolve) => waiters.push(() => (inFlight++, resolve())));
  };
  const release = () => {
    inFlight--;
    waiters.shift()?.();
  };

  const health = () =>
    AdapterHealthV1.parse({
      contract: AI_ADAPTER_CONTRACT,
      adapterId: o.adapterId,
      status: state,
      loadedModelIds: state === 'READY' ? o.models.map((m) => m.card.modelId) : [],
      lastError: state === 'FAILED' ? lastError : null,
      observedAtUtc: new Date().toISOString(),
    });

  const errorResult = (requestId: string, code: AdapterErrorCode, message: string) => ({
    contract: AI_ADAPTER_CONTRACT,
    status: 'error' as const,
    requestId,
    errorCode: code,
    message: message || code,
    retryable: RETRYABLE[code],
  });

  function decodeFrame(f: z.infer<typeof InferenceRequestV1>['frame']): Frame {
    if (f.data.kind !== 'inline_base64') throw new AdapterError('INVALID_FRAME', 'shared-memory frames are not supported by this adapter');
    const data = Buffer.from(f.data.value, 'base64');
    if (f.format === 'jpeg') {
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new AdapterError('INVALID_FRAME', 'not a JPEG file');
    } else if (data.length !== f.width * f.height * 3) {
      throw new AdapterError('INVALID_FRAME', `frame has ${data.length} bytes, expected ${f.width * f.height * 3} for ${f.width}x${f.height} ${f.format}`);
    }
    return { cameraId: f.cameraId, timestampUtc: f.timestampUtc, width: f.width, height: f.height, format: f.format, data };
  }

  function encodeEmbedding(v: Float32Array) {
    if (v.length === 0 || v.length > 4096) throw new AdapterError('RUNTIME_ERROR', `embedding has ${v.length} values`);
    let norm = 0;
    for (const x of v) {
      if (!Number.isFinite(x)) throw new AdapterError('RUNTIME_ERROR', 'embedding contains NaN or infinity');
      norm += x * x;
    }
    if (norm === 0) throw new AdapterError('RUNTIME_ERROR', 'embedding is a zero vector');
    const le = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => le.writeFloatLE(x, i * 4));
    return { dim: v.length, encoding: 'float32_base64' as const, vector: le.toString('base64'), normalized: Math.abs(Math.sqrt(norm) - 1) < 1e-3 };
  }

  /**
   * Runs fn under the concurrency limit and the deadline. The slot is held until fn itself settles, even after
   * the deadline answered the caller, so a model that ignores its AbortSignal cannot exceed maxInFlight.
   */
  async function guarded<T>(deadlineMs: number, requestId: string, tenantId: string, fn: (ctx: InferContext) => Promise<T>): Promise<T> {
    const t0 = Date.now();
    await acquire();
    let released = false;
    const rel = () => {
      if (!released) {
        released = true;
        release();
      }
    };
    const remaining = deadlineMs - (Date.now() - t0);
    if (remaining <= 0) {
      rel();
      throw new AdapterError('DEADLINE_EXCEEDED', `deadline of ${deadlineMs} ms passed while waiting for a slot`);
    }
    const ctl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort();
        reject(new AdapterError('DEADLINE_EXCEEDED', `deadline of ${deadlineMs} ms exceeded`));
      }, remaining);
    });
    let work: Promise<T>;
    try {
      work = fn({ requestId, tenantId, signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      rel();
      throw e;
    }
    work.then(rel, rel);
    let value: T;
    try {
      value = await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
    // A runtime that computes synchronously (onnxruntime-node on the main thread) can finish before the timer
    // gets a chance to fire; a result later than its deadline is still refused.
    if (Date.now() - t0 > deadlineMs) throw new AdapterError('DEADLINE_EXCEEDED', `deadline of ${deadlineMs} ms exceeded (answer took ${Date.now() - t0} ms)`);
    return value;
  }

  function provenance(m: AdapterModel, frameTimestampUtc: string) {
    return {
      adapterId: o.adapterId,
      adapterVersion: o.adapterVersion,
      modelId: m.card.modelId,
      modelName: m.card.name,
      modelVersion: m.card.version,
      modelSha256: m.card.sha256,
      runtime: m.runtime ?? m.card.runtime,
      ...(m.executionProvider ? { executionProvider: m.executionProvider } : {}),
      inferenceId: crypto.randomUUID(),
      frameTimestampUtc,
    };
  }

  function modelFor(task: string | null, modelId: string): AdapterModel {
    if (task !== null && !tasks.includes(task as any)) throw new AdapterError('UNSUPPORTED_TASK', `this adapter does not serve ${task}`);
    const m = byId.get(modelId);
    if (!m || (task !== null && m.card.task !== task)) throw new AdapterError('MODEL_NOT_LOADED', `model ${modelId} is not loaded for this task`);
    if (state !== 'READY') throw new AdapterError('MODEL_NOT_LOADED', state === 'FAILED' ? `models failed to load: ${lastError}` : 'models are still loading');
    return m;
  }

  async function handleInfer(body: unknown) {
    const reqId = typeof (body as any)?.requestId === 'string' && (body as any).requestId ? (body as any).requestId : `invalid-${crypto.randomUUID()}`;
    const p = InferenceRequestV1.safeParse(body);
    if (!p.success) return errorResult(reqId, 'INVALID_FRAME', `invalid request: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`.slice(0, 1000));
    const r = p.data;
    const m = modelFor(r.task, r.modelId);
    const frame = decodeFrame(r.frame);
    const t0 = process.hrtime.bigint();
    const out = await guarded(r.deadlineMs, r.requestId, r.tenantId, (ctx) => m.infer(frame, ctx));
    const classes = new Set(m.card.classes);
    const stray = (out.detections ?? []).filter((d) => !classes.has(d.objectClass)).map((d) => d.objectClass);
    if (stray.length) throw new AdapterError('RUNTIME_ERROR', `the model returned classes not in its card: ${[...new Set(stray)].join(', ')}`);
    if (m.card.task === 'embedding' && !out.embedding) throw new AdapterError('RUNTIME_ERROR', 'the embedding model returned no embedding');
    return {
      contract: AI_ADAPTER_CONTRACT,
      status: 'ok' as const,
      requestId: r.requestId,
      detections: out.detections ?? [],
      ...(out.embedding ? { embedding: encodeEmbedding(out.embedding) } : {}),
      provenance: provenance(m, frame.timestampUtc),
      latencyMs: Number(process.hrtime.bigint() - t0) / 1e6,
    };
  }

  async function handleEmbedText(body: unknown) {
    const reqId = typeof (body as any)?.requestId === 'string' && (body as any).requestId ? (body as any).requestId : `invalid-${crypto.randomUUID()}`;
    const p = TextEmbeddingRequestV1.safeParse(body);
    if (!p.success) return errorResult(reqId, 'INVALID_FRAME', `invalid request: ${p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`.slice(0, 1000));
    const r = p.data;
    const m = modelFor(null, r.modelId);
    if (!m.embedText) throw new AdapterError('UNSUPPORTED_TASK', `model ${r.modelId} has no text tower`);
    const t0 = process.hrtime.bigint();
    const v = await guarded(r.deadlineMs, r.requestId, r.tenantId, (ctx) => m.embedText!(r.text, ctx));
    return {
      contract: AI_ADAPTER_CONTRACT,
      status: 'ok' as const,
      requestId: r.requestId,
      detections: [],
      embedding: encodeEmbedding(v),
      provenance: provenance(m, new Date().toISOString()),
      latencyMs: Number(process.hrtime.bigint() - t0) / 1e6,
    };
  }

  const send = (res: http.ServerResponse, status: number, body: unknown, corr?: string) => {
    const s = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(s),
      ...(corr ? { 'x-correlation-id': corr } : {}),
      ...(status === 429 ? { 'retry-after': '1' } : {}),
    });
    res.end(s);
  };

  const handler: http.RequestListener = (req, res) => {
    const corrHeader = req.headers['x-correlation-id'];
    const corr = typeof corrHeader === 'string' && /^[\x21-\x7e]{1,128}$/.test(corrHeader) ? corrHeader : undefined;
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && url === '/v1/descriptor') return send(res, 200, descriptor, corr);
    if (req.method === 'GET' && url === '/v1/health') {
      const h = health();
      return send(res, h.status === 'READY' ? 200 : 503, h, corr);
    }
    const route = req.method === 'POST' && url === '/v1/infer' ? handleInfer : req.method === 'POST' && url === '/v1/embed-text' && o.models.some((m) => m.embedText) ? handleEmbedText : null;
    if (!route) return send(res, 404, { error: 'not found' }, corr);

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', async () => {
      let body: unknown;
      if (tooBig) return send(res, 400, errorResult(`invalid-${crypto.randomUUID()}`, 'INVALID_FRAME', `request larger than ${maxBody} bytes`), corr);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, errorResult(`invalid-${crypto.randomUUID()}`, 'INVALID_FRAME', 'request body is not JSON'), corr);
      }
      const reqId = typeof (body as any)?.requestId === 'string' && (body as any).requestId ? (body as any).requestId : `invalid-${crypto.randomUUID()}`;
      let result: any;
      try {
        result = await route(body);
      } catch (e: any) {
        const code: AdapterErrorCode = e instanceof AdapterError ? e.code : 'RUNTIME_ERROR';
        result = errorResult(reqId, code, String(e?.message ?? e).slice(0, 1000));
      }
      // Never send anything the contract does not allow.
      const checked = InferenceResultV1.safeParse(result);
      if (!checked.success) {
        o.log?.(`[adapter] refused an invalid result: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        result = errorResult(reqId, 'RUNTIME_ERROR', `the model produced a result that breaks the contract: ${checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`.slice(0, 1000));
      }
      const status = result.status === 'ok' ? 200 : HTTP_STATUS[result.errorCode as AdapterErrorCode];
      send(res, status, result, corr);
    });
  };

  return {
    descriptor,
    load,
    handler,
    async listen(port: number, host = '127.0.0.1') {
      const server = http.createServer(handler);
      await new Promise<void>((resolve) => server.listen(port, host, () => resolve()));
      void load();
      return server;
    },
  };
}

/** Reads a file and checks its SHA-256; throws MODEL_INTEGRITY_FAILED when it differs. Returns the bytes. */
export async function verifyFileSha256(file: string, sha256: string): Promise<Buffer> {
  const buf = await (await import('fs')).promises.readFile(file);
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== sha256) throw new AdapterError('MODEL_INTEGRITY_FAILED', `${file}: SHA-256 ${got}, expected ${sha256}`);
  return buf;
}
