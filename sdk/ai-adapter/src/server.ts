/**
 * An ai-adapter.v1 HTTP server that enforces the contract, so an adapter author only writes the model call.
 *
 *   GET  /v1/descriptor   the adapter and its model cards (validated at start-up)
 *   GET  /v1/health       READY once every model loaded (200; DEGRADED while every slot is busy or a model is
 *                         down, also 200); LOADING before and FAILED with the error (503)
 *   POST /v1/infer        InferenceRequestV1 -> InferenceResultV1
 *   POST /v1/embed-text   TextEmbeddingRequestV1 (only when a model has embedText)
 *   POST /v1/rewrite-text TextRewriteRequestV1 (v1.2, only when a model has rewriteText)
 *
 * The contract rules themselves (validation, deadlines, bounded concurrency, provenance, result checks) are in
 * core.ts, which an adapter with its own HTTP layer can use directly. This file adds the transport: body size
 * limit, JSON parsing, HTTP status per error code (429 carries Retry-After) and X-Correlation-Id.
 */
import crypto from 'crypto';
import http from 'http';
import { AdapterCoreOptions, AdapterError, Descriptor, HTTP_STATUS, createAdapterCore } from './core';

export * from './core';

export interface AdapterOptions extends AdapterCoreOptions {
  /** Largest request body accepted (default 32 MiB). */
  maxBodyBytes?: number;
}

export interface Adapter {
  descriptor: Descriptor;
  /** Loads every model (call once; listen() calls it for you). */
  load(): Promise<void>;
  /** The request handler, for mounting in your own server. */
  handler: http.RequestListener;
  listen(port: number, host?: string): Promise<http.Server>;
}

const errorBody = (message: string) => ({
  contract: 'ai-adapter.v1',
  status: 'error',
  requestId: `invalid-${crypto.randomUUID()}`,
  errorCode: 'INVALID_FRAME',
  message,
  retryable: false,
});

export function createAdapter(o: AdapterOptions): Adapter {
  const core = createAdapterCore(o);
  const maxBody = o.maxBodyBytes ?? 32 * 1024 * 1024;
  const { descriptor, load } = core;

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
      const h = core.health();
      return send(res, h.status === 'READY' || h.status === 'DEGRADED' ? 200 : 503, h, corr);
    }
    const route =
      req.method !== 'POST'
        ? null
        : url === '/v1/infer'
          ? core.infer
          : url === '/v1/embed-text' && core.servesTextEmbedding
            ? core.embedText
            : url === '/v1/rewrite-text' && core.servesTextRewrite
              ? core.rewriteText
              : null;
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
      if (tooBig) return send(res, 400, errorBody(`request larger than ${maxBody} bytes`), corr);
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, errorBody('request body is not JSON'), corr);
      }
      const result = await route(body);
      send(res, result.status === 'ok' ? 200 : HTTP_STATUS[result.errorCode], result, corr);
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
