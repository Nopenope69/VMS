/**
 * The SDK example with the REAL YOLOX-tiny model (Apache-2.0): its detections over HTTP match the official
 * YOLOX Python post-processing on the repository's golden images (tools/reference/yolox_reference.py, stored in
 * services/ai-worker/src/__tests__/fixtures/golden), and it passes the ai-adapter.v1 conformance kit.
 *
 * Needs the model (scripts/models/fetch-model.sh yolox-tiny) and ffmpeg. Skipped without the model unless
 * VIGILONE_REQUIRE_MODEL_TESTS=1.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { createAdapter, runAiAdapterConformance } from '../index';
import { yoloxTinyModel } from '../examples/yoloxTiny';

const repo = path.resolve(__dirname, '../../../..');
const modelPath = path.join(process.env.VIGILONE_MODELS_DIR || path.join(repo, '.cache/models'), 'yolox_tiny.onnx');
const golden = path.join(repo, 'services/ai-worker/src/__tests__/fixtures/golden');
const present = fs.existsSync(modelPath);
jest.setTimeout(120000);

if (!present && process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1') {
  test('yolox-tiny model required (VIGILONE_REQUIRE_MODEL_TESTS=1)', () => {
    throw new Error(`${modelPath} missing; run scripts/models/fetch-model.sh yolox-tiny`);
  });
}

(present ? describe : describe.skip)('SDK example: YOLOX-tiny adapter', () => {
  let server: http.Server;
  let url = '';
  const reference = JSON.parse(fs.readFileSync(path.join(golden, 'yolox-tiny.reference.json'), 'utf8'));
  // The golden PNGs are already letterboxed to 416x416 (image top-left, padding after); the reference boxes are
  // relative to the original image. The adapter is given the 416x416 PNG as its frame, so convert.
  const geometry = JSON.parse(fs.readFileSync(path.join(golden, 'inputs', 'geometry.json'), 'utf8'));
  const toFrame = (name: string, b: any) => {
    const g = geometry[name].geometry;
    const sx = g.scaledWidth / g.modelWidth;
    const sy = g.scaledHeight / g.modelHeight;
    return { x: g.padX / g.modelWidth + b.x * sx, y: g.padY / g.modelHeight + b.y * sy, width: b.width * sx, height: b.height * sy };
  };

  beforeAll(async () => {
    const adapter = createAdapter({
      adapterId: 'example-yolox-tiny',
      adapterVersion: '0.1.0',
      models: [yoloxTinyModel(modelPath, { scoreThreshold: reference.scoreThreshold, nmsThreshold: reference.nmsThreshold })],
      maxInFlight: 1,
      maxQueued: 4,
    });
    server = await adapter.listen(0);
    await adapter.load();
    url = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => server?.close());

  const iou = (a: any, b: any) => {
    const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const inter = ix * iy;
    return inter / (a.width * a.height + b.width * b.height - inter);
  };

  for (const name of Object.keys(JSON.parse(fs.readFileSync(path.join(golden, 'yolox-tiny.reference.json'), 'utf8')).detections)) {
    it(`${name}: same classes, boxes (IoU >= 0.98) and confidences (|d| <= 0.002) as the official YOLOX code`, async () => {
      const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(golden, 'inputs', name), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
      const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(golden, 'inputs', name)]).toString().trim().split(',').map(Number);
      const r = await fetch(`${url}/v1/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contract: 'ai-adapter.v1', requestId: `g-${name}`, tenantId: 't', task: 'object_detection', modelId: 'yolox-tiny-coco', deadlineMs: 30000,
          frame: { cameraId: 'golden', streamSessionId: 's', sequenceNumber: 1, timestampUtc: new Date().toISOString(), width: probe[0], height: probe[1], format: 'rgb24', data: { kind: 'inline_base64', value: rgb.toString('base64') } },
        }),
      });
      const body = (await r.json()) as any;
      expect(body.status).toBe('ok');
      const want: { classId: number; confidence: number; box: any }[] = reference.detections[name];
      const got: any[] = body.detections;
      expect(got.length).toBe(want.length);
      for (const w of want) {
        const match = got.find((d) => d.classId === w.classId && iou(d.bbox, toFrame(name, w.box)) >= 0.98 && Math.abs(d.confidence - w.confidence) <= 0.002);
        expect({ reference: w, matched: Boolean(match), got: match ? undefined : got }).toEqual({ reference: w, matched: true, got: undefined });
      }
    });
  }

  it('passes the ai-adapter.v1 conformance kit', async () => {
    const checks = await runAiAdapterConformance({ baseUrl: url, burst: 8 });
    expect(checks.filter((c) => !c.passed)).toEqual([]);
  });
});
