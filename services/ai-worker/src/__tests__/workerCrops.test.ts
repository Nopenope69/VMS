/**
 * AI_ATTACH_CROPS on the real AiWorker (test-stub engine): off by default, attaches a JPEG only to
 * CONFIRMED detections when on, and a crop failure never stops the detection from being submitted.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AiWorker } from '../worker';
import { ModelManifestRecord, VideoFrame } from '../types';
import { CoordinateTransformer } from '../coordinateTransformer';
import * as extractor from '../cropExtractor';

const originalEnv = { ...process.env };
let tmpDir = '';
let artifactPath = '';
let manifest: ModelManifestRecord;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  process.env.AI_INFERENCE_MODE = 'test-stub';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-crops-'));
  artifactPath = path.join(tmpDir, 'model.onnx');
  const content = Buffer.from('mock-onnx-bytes-crops');
  fs.writeFileSync(artifactPath, content);
  manifest = {
    id: 'manifest-crops-1',
    name: 'vigilone-person-vehicle-detector',
    version: '1.0.0',
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    codeLicense: 'Apache-2.0',
    weightLicense: 'Apache-2.0',
    runtimeConfigJson: { runtime: 'onnxruntime', inputWidth: 640, inputHeight: 640, colorSpace: 'RGB', modelFormat: 'ONNX' },
    classesJson: { '0': 'person', '1': 'car' },
    thresholdsJson: { person: 0.45, car: 0.5 },
    modelSignatureJson: { input: { name: 'images', shape: [1, 3, 640, 640], dtype: 'float32' }, output: { name: 'output0', shape: [1, 6, 8400], dtype: 'float32' }, coordinateFormat: 'cxcywh', hasObjectness: false, classCount: 2 },
    isActive: true,
  };
});
afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const frame = (seq: number): VideoFrame => ({
  cameraId: 'cam-crops',
  tenantId: 'tenant-1',
  streamPath: 'cam_crops',
  streamSessionId: 's',
  sequenceNumber: seq,
  sampledAt: new Date(`2026-09-29T10:00:0${seq}Z`),
  receivedAt: new Date(`2026-09-29T10:00:0${seq}Z`),
  width: 640,
  height: 640,
  channels: 3,
  data: Buffer.alloc(640 * 640 * 3, 90),
  geometry: CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true),
});

async function run(attachCrops: boolean | undefined) {
  const worker = new AiWorker({ backendBaseUrl: 'http://127.0.0.1:4000', internalSecret: 's', trackerConfig: { minHitsToConfirm: 2 }, attachCrops });
  const submitted: any[] = [];
  (worker as any).apiClient.submitDetection = jest.fn(async (e: any) => {
    submitted.push({ ...e });
    return { success: true };
  });
  await worker.initializeModel(manifest, artifactPath);
  await worker.processFrame(frame(1)); // tentative: nothing is sent
  const events = await worker.processFrame(frame(2));
  return { submitted, events };
}

describe('P5.1 AI_ATTACH_CROPS', () => {
  it('is off by default: detections are sent without a crop', async () => {
    const { submitted } = await run(undefined);
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted.every((e) => e.cropJpegBase64 === undefined)).toBe(true);
  });

  it('when on, every CONFIRMED detection carries a real JPEG crop and the returned events stay small', async () => {
    const { submitted, events } = await run(true);
    expect(submitted.length).toBeGreaterThan(0);
    for (const e of submitted) {
      const jpeg = Buffer.from(e.cropJpegBase64, 'base64');
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    }
    expect(events.every((e) => e.cropJpegBase64 === undefined)).toBe(true);
  });

  it('a crop failure is counted and logged, and the detection is still submitted (without a crop)', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(extractor, 'cropToJpeg').mockRejectedValue(new Error('ffmpeg exploded'));
    const { submitted } = await run(true);
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted.every((e) => e.cropJpegBase64 === undefined)).toBe(true);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('ffmpeg exploded'));
  });
});
