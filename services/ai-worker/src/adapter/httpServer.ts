import http from 'http';
import crypto from 'crypto';
import { AiAdapterCore } from './adapterCore';
import { AI_ADAPTER_CONTRACT, ERROR_HTTP_STATUS } from './contract';

export interface AdapterHttpOptions {
  /** Largest request body accepted (default 32 MiB: a 4K RGB frame base64-encoded is ~33 MB). */
  maxBodyBytes?: number;
  /** Extra text appended to /metrics (e.g. stream pipeline telemetry). */
  extraMetrics?: () => string;
}

const CORRELATION_HEADER = 'x-correlation-id';

function send(res: http.ServerResponse, status: number, body: unknown, correlationId: string, extra: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; version=0.0.4' : 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-Correlation-Id': correlationId,
    'X-Contract': AI_ADAPTER_CONTRACT,
    ...extra,
  });
  res.end(payload);
}

/**
 * ai-adapter.v1 over HTTP:
 *   GET  /v1/descriptor  -> AdapterDescriptorV1
 *   GET  /v1/health      -> AdapterHealthV1 (HTTP 200 when READY/DEGRADED, 503 otherwise)
 *   POST /v1/infer       -> InferenceResultV1 (HTTP status mirrors the error code; 429 carries Retry-After)
 *   POST /v1/embed-text  -> InferenceResultV1 (v1.1, only adapters with a text tower; otherwise 404)
 *   GET  /metrics        -> Prometheus text
 * Every response echoes X-Correlation-Id (generated when the caller sends none).
 */
/** What the HTTP layer needs from an adapter core (object detection or ANPR). */
export interface AdapterCoreLike {
  metrics: AiAdapterCore['metrics'];
  describe(): ReturnType<AiAdapterCore['describe']>;
  health(): ReturnType<AiAdapterCore['health']>;
  handleInferRequest(body: unknown): ReturnType<AiAdapterCore['handleInferRequest']>;
  /** v1.1, optional: only an adapter with a text tower serves POST /v1/embed-text. */
  handleTextEmbedRequest?(body: unknown): ReturnType<AiAdapterCore['handleInferRequest']>;
}

export function createAdapterServer(core: AdapterCoreLike, opts: AdapterHttpOptions = {}): http.Server {
  const maxBody = opts.maxBodyBytes ?? 32 * 1024 * 1024;

  return http.createServer((req, res) => {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      typeof incoming === 'string' && /^[\w.:-]{1,128}$/.test(incoming) ? incoming : crypto.randomUUID();
    const url = (req.url || '/').split('?')[0];
    core.metrics.inc('vigilone_ai_adapter_http_requests_total', 'Adapter HTTP requests', { path: url === '/v1/descriptor' || url === '/v1/health' || url === '/v1/infer' || url === '/v1/embed-text' || url === '/metrics' ? url : 'other', method: req.method || '' });

    if (req.method === 'GET' && url === '/v1/descriptor') return send(res, 200, core.describe(), correlationId);
    if (req.method === 'GET' && url === '/v1/health') {
      const h = core.health();
      return send(res, h.status === 'READY' || h.status === 'DEGRADED' ? 200 : 503, h, correlationId);
    }
    if (req.method === 'GET' && url === '/metrics') {
      return send(res, 200, core.metrics.render() + (opts.extraMetrics ? opts.extraMetrics() : ''), correlationId);
    }
    const textEmbed = req.method === 'POST' && url === '/v1/embed-text' && core.handleTextEmbedRequest ? core.handleTextEmbedRequest.bind(core) : null;
    if (req.method === 'POST' && (url === '/v1/infer' || textEmbed)) {
      const handle = textEmbed ?? core.handleInferRequest.bind(core);
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody && !aborted) {
          aborted = true;
          chunks.length = 0; // stop buffering; the rest of the body is read and discarded
          send(res, 413, {
            contract: AI_ADAPTER_CONTRACT, status: 'error', requestId: 'unidentified-request',
            errorCode: 'INVALID_FRAME', message: `request body exceeds ${maxBody} bytes`, retryable: false,
          }, correlationId, { Connection: 'close' });
        } else if (!aborted) {
          chunks.push(c);
        }
      });
      req.on('end', async () => {
        if (aborted) return;
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, {
            contract: AI_ADAPTER_CONTRACT, status: 'error', requestId: 'unidentified-request',
            errorCode: 'INVALID_FRAME', message: 'request body is not valid JSON', retryable: false,
          }, correlationId);
        }
        const result = await handle(body);
        if (result.status === 'ok') return send(res, 200, result, correlationId);
        const status = ERROR_HTTP_STATUS[result.errorCode] ?? 500;
        return send(res, status, result, correlationId, result.errorCode === 'OVERLOADED' ? { 'Retry-After': '1' } : {});
      });
      return;
    }
    send(res, 404, { error: 'not found', contract: AI_ADAPTER_CONTRACT }, correlationId);
  });
}
