import http from 'http';
import { AddressInfo } from 'net';
import { AiAdapterCore } from '../adapter/adapterCore';
import { createAdapterServer } from '../adapter/httpServer';
import { IInferenceEngine } from '../inferenceEngine';
import { ModelManifestRecord, RawDetection } from '../types';

/** A controllable in-test engine: fixed detections, optional delay. */
class FakeEngine implements IInferenceEngine {
  public calls = 0;
  constructor(private delayMs = 0, private dets: RawDetection[] = []) {}
  async load() {}
  isLoaded() { return true; }
  getRuntimeName() { return 'onnxruntime'; }
  getMode() { return 'native' as const; }
  getRuntimeInfo() { return { runtime: 'onnxruntime' as const, runtimeVersion: '1.30.0', executionProvider: 'cpu' }; }
  async infer(): Promise<RawDetection[]> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.dets;
  }
}

const manifest: ModelManifestRecord = {
  id: 'm-1', name: 'yolox-tiny-coco', version: '0.1.1rc0', sha256: 'a'.repeat(64),
  codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', isActive: true, weightsSource: 'test',
  runtimeConfigJson: { runtime: 'onnxruntime', inputWidth: 32, inputHeight: 32, colorSpace: 'BGR', letterbox: true, padPosition: 'top-left', padValue: 114, modelFormat: 'ONNX' },
};

function request(port: number, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(raw); } catch { json = raw; }
        resolve({ status: res.statusCode!, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function inferBody(over: Record<string, any> = {}) {
  return {
    contract: 'ai-adapter.v1', requestId: `r-${Math.random()}`, tenantId: 't', task: 'object_detection', modelId: 'm-1', deadlineMs: 5000,
    frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-27T10:00:00.000Z', width: 40, height: 20, format: 'rgb24',
      data: { kind: 'inline_base64', value: Buffer.alloc(40 * 20 * 3, 50).toString('base64') } },
    ...over,
  };
}

async function withServer(core: AiAdapterCore, fn: (port: number) => Promise<void>, opts: any = {}) {
  const server = createAdapterServer(core, opts);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('ai-adapter.v1 HTTP server', () => {
  it('reports LOADING/503 before a model is loaded, then READY/200', async () => {
    const core = new AiAdapterCore(new FakeEngine(), { adapterId: 'a', adapterVersion: '1' });
    await withServer(core, async (port) => {
      let h = await request(port, 'GET', '/v1/health');
      expect(h.status).toBe(503);
      expect(h.json.status).toBe('LOADING');
      const r = await request(port, 'POST', '/v1/infer', inferBody());
      expect(r.status).toBe(503);
      expect(r.json).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED', retryable: true });
      core.setModel({ manifest });
      h = await request(port, 'GET', '/v1/health');
      expect(h.status).toBe(200);
      expect(h.json).toMatchObject({ status: 'READY', loadedModelIds: ['m-1'] });
    });
  });

  it('returns only v1 classes, with provenance built from the manifest and runtime', async () => {
    const dets: RawDetection[] = [
      { classId: 0, label: 'person', confidence: 0.9, box: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } },
      { classId: 60, label: 'dining table', confidence: 0.8, box: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    const core = new AiAdapterCore(new FakeEngine(0, dets), { adapterId: 'adapter-x', adapterVersion: '9' });
    core.setModel({ manifest });
    await withServer(core, async (port) => {
      const r = await request(port, 'POST', '/v1/infer', inferBody(), { 'x-correlation-id': 'corr-123' });
      expect(r.status).toBe(200);
      expect(r.headers['x-correlation-id']).toBe('corr-123');
      expect(r.json.detections.map((d: any) => d.objectClass)).toEqual(['person']);
      expect(r.json.provenance).toMatchObject({
        adapterId: 'adapter-x', adapterVersion: '9', modelId: 'm-1', modelSha256: 'a'.repeat(64),
        runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', frameTimestampUtc: '2026-09-27T10:00:00.000Z',
      });
      const m = await request(port, 'GET', '/metrics');
      expect(String(m.json)).toMatch(/vigilone_ai_detections_dropped_total\{reason="class_not_in_v1"\} 1/);
    });
  });

  it('answers OVERLOADED (429 + Retry-After) beyond maxInFlight + maxQueued', async () => {
    const core = new AiAdapterCore(new FakeEngine(150), { adapterId: 'a', adapterVersion: '1', maxInFlight: 1, maxQueued: 1 });
    core.setModel({ manifest });
    await withServer(core, async (port) => {
      const rs = await Promise.all([0, 1, 2, 3].map(() => request(port, 'POST', '/v1/infer', inferBody())));
      const statuses = rs.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 200, 429, 429]);
      for (const r of rs.filter((x) => x.status === 429)) {
        expect(r.headers['retry-after']).toBe('1');
        expect(r.json).toMatchObject({ status: 'error', errorCode: 'OVERLOADED', retryable: true });
      }
    });
  });

  it('a request whose deadline passes while queued never runs and returns DEADLINE_EXCEEDED (504)', async () => {
    const engine = new FakeEngine(200);
    const core = new AiAdapterCore(engine, { adapterId: 'a', adapterVersion: '1', maxInFlight: 1, maxQueued: 4 });
    core.setModel({ manifest });
    await withServer(core, async (port) => {
      const slow = request(port, 'POST', '/v1/infer', inferBody());
      await new Promise((r) => setTimeout(r, 20));
      const late = await request(port, 'POST', '/v1/infer', inferBody({ deadlineMs: 50 }));
      expect(late.status).toBe(504);
      expect(late.json.errorCode).toBe('DEADLINE_EXCEEDED');
      expect((await slow).status).toBe(200);
      await new Promise((r) => setTimeout(r, 250));
      expect(engine.calls).toBe(1); // the expired request never reached the engine
    });
  });

  it('rejects oversized bodies (413), malformed JSON (400) and unknown paths (404)', async () => {
    const core = new AiAdapterCore(new FakeEngine(), { adapterId: 'a', adapterVersion: '1' });
    core.setModel({ manifest });
    await withServer(core, async (port) => {
      const big = await request(port, 'POST', '/v1/infer', JSON.stringify({ pad: 'x'.repeat(4096) }));
      expect(big.status).toBe(413);
      const bad = await request(port, 'POST', '/v1/infer', '{nope');
      expect(bad.status).toBe(400);
      expect(bad.json.errorCode).toBe('INVALID_FRAME');
      expect((await request(port, 'GET', '/nope')).status).toBe(404);
    }, { maxBodyBytes: 1024 });
  });

  it('refuses shared_memory frames honestly (this adapter only supports inline frames)', async () => {
    const core = new AiAdapterCore(new FakeEngine(), { adapterId: 'a', adapterVersion: '1' });
    core.setModel({ manifest });
    const body = inferBody();
    body.frame.data = { kind: 'shared_memory', key: 'k', byteLength: 10 } as any;
    const r = await core.handleInferRequest(body);
    expect(r).toMatchObject({ status: 'error', errorCode: 'INVALID_FRAME' });
  });
});
