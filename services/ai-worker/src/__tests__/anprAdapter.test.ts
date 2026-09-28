/**
 * P4.1 ANPR service: licence governance at load (candidate models need a human approval for their
 * exact SHA-256), integrity checks, and the plate_recognition adapter over real HTTP on a
 * SYNTHETIC scene. Approvals here are a temporary TEST-ONLY file, not a licence decision.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { loadAnprPipeline, resolvePipelinePath } from '../anpr/anprService';
import { AnprAdapterCore } from '../anpr/anprAdapterCore';
import { createAdapterServer } from '../adapter/httpServer';
import { artifactPathFor, findCandidateEntry, resolveModelsDir } from '../modelCatalog';

const def = JSON.parse(fs.readFileSync(resolvePipelinePath(), 'utf8'));
const entries = def.components.map((c: any) => findCandidateEntry(c.key));
const files = [...entries.map((e: any) => artifactPathFor(e)), ...entries.flatMap((e: any) => (e.extraFiles || []).map((x: any) => path.join(resolveModelsDir(), x.fileName)))];
const present = files.every((f: string) => fs.existsSync(f));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anpr-worker-'));
const approvals = path.join(tmp, 'approvals.json');

if (!present && required) test('ANPR models required', () => { throw new Error('fetch ppocrv4-det and fast-plate-ocr-cct-s-v2'); });

(present ? describe : describe.skip)('ANPR service', () => {
  afterEach(() => {
    delete process.env.VIGILONE_MODEL_EXCEPTIONS;
  });

  it('refuses to load candidate models without a human approval (LICENSE_REJECTED)', async () => {
    fs.writeFileSync(approvals, JSON.stringify({ approvals: [] }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
    await expect(loadAnprPipeline()).rejects.toThrow(/^LICENSE_REJECTED: ppocrv4-det is a candidate model pending human review/);
  });

  it('refuses an approval for another hash, and a model file whose bytes changed', async () => {
    fs.writeFileSync(approvals, JSON.stringify({ approvals: def.components.map((c: any) => ({ key: c.key, sha256: '0'.repeat(64), approvedBy: 'TEST-ONLY', approvedAt: '2026-09-27', reason: 't' })) }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
    await expect(loadAnprPipeline()).rejects.toThrow(/LICENSE_REJECTED/);

    const dir = fs.mkdtempSync(path.join(tmp, 'models-'));
    for (const f of files) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    const det = path.join(dir, path.basename(files[0]));
    const b = fs.readFileSync(det);
    b[b.length - 1] ^= 0xff;
    fs.writeFileSync(det, b);
    await expect(loadAnprPipeline({ modelsDir: dir, evaluationOnly: true })).rejects.toThrow(/^MODEL_INTEGRITY_FAILED/);
  });

  describe('plate_recognition adapter over HTTP', () => {
    let server: http.Server;
    let base = '';
    let core: AnprAdapterCore;

    beforeAll(async () => {
      fs.writeFileSync(approvals, JSON.stringify({ approvals: def.components.map((c: any) => ({ key: c.key, sha256: c.sha256, approvedBy: 'TEST-ONLY (not a licence decision)', approvedAt: '2026-09-27', reason: 'unit test' })) }));
      process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
      const loaded = await loadAnprPipeline();
      expect(loaded.components.every((c) => c.approval?.approvedBy.startsWith('TEST-ONLY'))).toBe(true);
      core = new AnprAdapterCore(loaded, { adapterId: 'vigilone-anpr', adapterVersion: 'test', modelId: 'anpr-india@1.0.0' });
      server = createAdapterServer(core);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    }, 60000);
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const frame = (file: string) => {
      const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 16 << 20 });
      return { width: 960, height: 540, format: 'rgb24', data: { kind: 'inline_base64', value: buf.toString('base64') } };
    };
    const infer = async (body: any) => {
      const r = await fetch(`${base}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as any };
    };
    const req = (over: any = {}, file = 'SYNTHETIC_two_line_two_wheeler.png') => ({
      contract: 'ai-adapter.v1', requestId: 'r1', tenantId: 't', task: 'plate_recognition', modelId: 'anpr-india@1.0.0', deadlineMs: 20000,
      frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-27T10:00:00.000Z', ...frame(path.join(__dirname, 'fixtures', 'anpr', file)) },
      ...over,
    });

    it('describes one plate_recognition pipeline with both components and no invented accuracy', async () => {
      const d: any = await (await fetch(`${base}/v1/descriptor`)).json();
      expect(d.tasks).toEqual(['plate_recognition']);
      expect(d.models[0]).toMatchObject({ task: 'plate_recognition', weightsLicense: 'Apache-2.0 AND MIT', evaluation: null, input: { resizeMode: 'min_side' } });
      expect(d.models[0].components.map((c: any) => c.sha256)).toEqual(def.components.map((c: any) => c.sha256));
      const h: any = await (await fetch(`${base}/v1/health`)).json();
      expect(h.status).toBe('READY');
    });

    it('reads a two-line plate with provenance naming the pipeline and both models', async () => {
      const r = await infer(req());
      expect(r.status).toBe(200);
      expect(r.json.status).toBe('ok');
      expect(r.json.detections).toHaveLength(1);
      expect(r.json.detections[0]).toMatchObject({ objectClass: 'license_plate', attributes: { plateText: 'TN09BK3301', displayText: 'TN 09 BK 3301', format: 'STANDARD', lines: 2 } });
      const b = r.json.detections[0].bbox;
      expect(b.x).toBeGreaterThan(0.3);
      expect(b.x + b.width).toBeLessThan(0.7);
      expect(r.json.provenance.components).toHaveLength(2);
      expect(r.json.provenance.modelSha256).toMatch(/^[a-f0-9]{64}$/);
    }, 30000);

    it('fails with contract error codes, never an empty success', async () => {
      expect((await infer(req({ task: 'object_detection' }))).json.errorCode).toBe('UNSUPPORTED_TASK');
      expect((await infer(req({ modelId: 'other' }))).json.errorCode).toBe('MODEL_NOT_LOADED');
      const bad = req();
      bad.frame.width = 100;
      expect((await infer(bad)).json.errorCode).toBe('INVALID_FRAME');
      expect((await infer(req({ deadlineMs: 1 }))).json.errorCode).toBe('DEADLINE_EXCEEDED');
    }, 30000);
  });

  it('an adapter whose pipeline was refused reports FAILED with the reason', async () => {
    const core = new AnprAdapterCore(null, { adapterId: 'a', adapterVersion: 'v', failure: 'LICENSE_REJECTED: pending review' });
    expect(core.health()).toMatchObject({ status: 'FAILED', lastError: 'LICENSE_REJECTED: pending review', loadedModelIds: [] });
    expect((await core.handleInferRequest({})).status).toBe('error');
  });
});
