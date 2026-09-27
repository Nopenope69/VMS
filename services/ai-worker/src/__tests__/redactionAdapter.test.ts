/**
 * P4.4 redaction regions adapter: licence refusal and real HTTP inference on a SYNTHETIC scene
 * with a public-domain face and a synthetic plate. Approvals here are a temporary TEST-ONLY file,
 * not a licence decision.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync } from 'child_process';
import { loadRedactionPipeline, resolveRedactionPipelinePath } from '../redaction/redactionPipeline';
import { RedactionAdapterCore } from '../redaction/redactionAdapterCore';
import { createAdapterServer } from '../adapter/httpServer';
import { artifactPathFor, findCandidateEntry } from '../modelCatalog';

const def = JSON.parse(fs.readFileSync(resolveRedactionPipelinePath(), 'utf8'));
const files = def.components.map((c: any) => artifactPathFor(findCandidateEntry(c.key)));
const present = files.every((f: string) => fs.existsSync(f));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redaction-worker-'));
const approvals = path.join(tmp, 'approvals.json');
const FIX = path.join(__dirname, 'fixtures', 'redaction');

if (!present && required) test('redaction models required', () => { throw new Error('fetch yunet-2023mar and ppocrv4-det'); });

(present ? describe : describe.skip)('redaction regions service', () => {
  afterEach(() => {
    delete process.env.VIGILONE_MODEL_EXCEPTIONS;
  });

  it('refuses to load without a human approval for each component (LICENSE_REJECTED)', async () => {
    fs.writeFileSync(approvals, JSON.stringify({ approvals: [] }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
    await expect(loadRedactionPipeline()).rejects.toThrow(/^LICENSE_REJECTED: yunet-2023mar is a candidate model pending human review/);
  });

  it('a refused adapter reports FAILED health and MODEL_NOT_LOADED', async () => {
    const core = new RedactionAdapterCore(null, { adapterId: 'r', adapterVersion: 't', failure: 'LICENSE_REJECTED: x' });
    expect(core.health()).toMatchObject({ status: 'FAILED', lastError: 'LICENSE_REJECTED: x' });
    const r = await core.handleInferRequest({});
    expect(r.status).toBe('error');
  });

  describe('over HTTP', () => {
    let server: http.Server;
    let base = '';
    const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'SYNTHETIC_redaction_manifest.json'), 'utf8'));

    beforeAll(async () => {
      fs.writeFileSync(approvals, JSON.stringify({ approvals: def.components.map((c: any) => ({ key: c.key, sha256: c.sha256, approvedBy: 'TEST-ONLY (not a licence decision)', approvedAt: '2026-09-27', reason: 'unit test' })) }));
      process.env.VIGILONE_MODEL_EXCEPTIONS = approvals;
      const core = new RedactionAdapterCore(await loadRedactionPipeline(), { adapterId: 'vigilone-redaction', adapterVersion: 'test' });
      server = createAdapterServer(core);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      base = `http://127.0.0.1:${(server.address() as any).port}`;
    }, 60000);
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    const jpeg = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(FIX, manifest.file), '-q:v', '2', '-f', 'mjpeg', '-'], { maxBuffer: 16 << 20 });
    const infer = async (task: string, modelId = 'redaction-regions@1.0.0') => {
      const body = {
        contract: 'ai-adapter.v1', requestId: 'r1', tenantId: 't', task, modelId, deadlineMs: 20000,
        frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-27T10:00:00.000Z', width: 960, height: 540, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg.toString('base64') } },
      };
      const r = await fetch(`${base}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return (await r.json()) as any;
    };
    const px = (d: any) => [d.bbox.x * 960, d.bbox.y * 540, (d.bbox.x + d.bbox.width) * 960, (d.bbox.y + d.bbox.height) * 540];

    it('returns the face inside the portrait, with provenance listing both models', async () => {
      const r = await infer('face_detection_for_redaction');
      expect(r.status).toBe('ok');
      expect(r.detections.length).toBeGreaterThanOrEqual(1);
      const [x1, y1, x2, y2] = px(r.detections[0]);
      const [px1, py1, px2, py2] = manifest.portraitBoxXYXY;
      expect(r.detections[0].objectClass).toBe('face');
      expect(x1 >= px1 && y1 >= py1 && x2 <= px2 && y2 <= py2).toBe(true);
      expect(r.provenance.components.map((c: any) => c.modelName)).toEqual(['yunet-2023mar', 'ppocrv4-det'].map((k) => findCandidateEntry(k).name));
      expect(r.provenance.modelSha256).toMatch(/^[a-f0-9]{64}$/);
    }, 30000);

    it('returns a plate region covering the plate text, without reading it', async () => {
      const r = await infer('plate_detection_for_redaction');
      expect(r.status).toBe('ok');
      const [bx1, by1, bx2, by2] = manifest.plateBoxXYXY;
      const hit = r.detections.find((d: any) => {
        const [x1, y1, x2, y2] = px(d);
        return d.objectClass === 'license_plate' && x1 < bx2 && x2 > bx1 && y1 < by2 && y2 > by1 && (x2 - x1) > 0.6 * (bx2 - bx1);
      });
      expect(hit).toBeDefined();
      expect(hit.attributes).toBeUndefined();
    }, 30000);

    it('refuses other tasks and unknown model ids', async () => {
      expect((await infer('plate_recognition')).errorCode).toBe('UNSUPPORTED_TASK');
      expect((await infer('face_detection_for_redaction', 'other@1')).errorCode).toBe('MODEL_NOT_LOADED');
    }, 30000);
  });
});
