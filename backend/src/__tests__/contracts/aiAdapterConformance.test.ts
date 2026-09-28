import http from 'http';
import { AddressInfo } from 'net';
import { runAiAdapterConformance } from '../../contracts/conformance/aiAdapterConformance';

/**
 * The conformance kit itself is tested against two in-test HTTP adapters (test doubles, not
 * product code): one that follows ai-adapter.v1 and one with specific violations. The kit must pass
 * the first and name each violation of the second. The real ai-worker adapter is checked by
 * `npm run conformance:ai-adapter` (CI job ai-adapter-conformance, docs/STATUS.md).
 */
type Behaviour = {
  omitProvenanceSha?: boolean;
  wrongTimestamp?: boolean;
  noCorrelationEcho?: boolean;
  successOnBadFrame?: boolean;
  requiresEgress?: boolean;
};

const MODEL = {
  modelId: 'double-model', name: 'double', version: '1', sha256: 'c'.repeat(64), task: 'object_detection',
  classes: ['person'], codeLicense: 'MIT', weightsLicense: 'MIT', weightsSource: 'test double',
  runtime: 'onnxruntime', input: { width: 64, height: 48, colorSpace: 'RGB', letterbox: true }, evaluation: null,
};

function startDouble(b: Behaviour): Promise<{ url: string; close: () => Promise<void> }> {
  let n = 0;
  const server = http.createServer((req, res) => {
    const corr = (req.headers['x-correlation-id'] as string) || 'generated';
    const send = (status: number, body: any) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...(b.noCorrelationEcho ? {} : { 'X-Correlation-Id': corr }), ...(status === 429 ? { 'Retry-After': '1' } : {}) });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/v1/descriptor') {
      return send(200, { contract: 'ai-adapter.v1', adapterId: 'double', adapterVersion: '1', tasks: ['object_detection'], models: [MODEL], requiresNetworkEgress: !!b.requiresEgress });
    }
    if (req.url === '/v1/health') {
      return send(200, { contract: 'ai-adapter.v1', adapterId: 'double', status: 'READY', loadedModelIds: ['double-model'], lastError: null, observedAtUtc: new Date().toISOString() });
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const err = (status: number, code: string, requestId = 'x') =>
        send(status, { contract: 'ai-adapter.v1', status: 'error', requestId, errorCode: code, message: code, retryable: false });
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return err(400, 'INVALID_FRAME');
      }
      if (body.task !== 'object_detection') return err(400, 'UNSUPPORTED_TASK', body.requestId);
      if (body.modelId !== 'double-model') return err(503, 'MODEL_NOT_LOADED', body.requestId);
      const f = body.frame;
      if (!b.successOnBadFrame && Buffer.from(f.data.value, 'base64').length !== f.width * f.height * 3) return err(400, 'INVALID_FRAME', body.requestId);
      if (body.deadlineMs < 5) return err(504, 'DEADLINE_EXCEEDED', body.requestId);
      n++;
      send(200, {
        contract: 'ai-adapter.v1', status: 'ok', requestId: body.requestId, latencyMs: 1,
        detections: [{ objectClass: 'person', classId: 0, confidence: 0.9, bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
        provenance: {
          adapterId: 'double', adapterVersion: '1', modelId: 'double-model', modelName: 'double', modelVersion: '1',
          modelSha256: b.omitProvenanceSha ? 'd'.repeat(64) : 'c'.repeat(64), runtime: 'onnxruntime',
          inferenceId: `inf-${n}`, frameTimestampUtc: b.wrongTimestamp ? new Date(0).toISOString() : f.timestampUtc,
        },
      });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    )
  );
}

describe('ai-adapter.v1 conformance kit', () => {
  it('passes an adapter that follows the contract', async () => {
    const d = await startDouble({});
    try {
      const checks = await runAiAdapterConformance({ baseUrl: d.url, burst: 4 });
      expect(checks.filter((c) => !c.passed)).toEqual([]);
      expect(checks.length).toBeGreaterThanOrEqual(18);
    } finally {
      await d.close();
    }
  });

  it.each<[string, Behaviour, string]>([
    ['provenance names another model hash', { omitProvenanceSha: true }, 'infer.ok.provenance_model'],
    ['provenance uses processing time instead of the frame time', { wrongTimestamp: true }, 'infer.ok.frame_timestamp'],
    ['correlation id is not echoed', { noCorrelationEcho: true }, 'http.correlation_echo'],
    ['a malformed frame is answered with success', { successOnBadFrame: true }, 'error.invalid_frame'],
    ['the adapter needs network egress (air-gapped site)', { requiresEgress: true }, 'descriptor.air_gapped'],
  ])('fails an adapter where %s', async (_why, behaviour, failingCheck) => {
    const d = await startDouble(behaviour);
    try {
      const checks = await runAiAdapterConformance({ baseUrl: d.url, burst: 2 });
      expect(checks.filter((c) => !c.passed).map((c) => c.id)).toEqual([failingCheck]);
    } finally {
      await d.close();
    }
  });
});
