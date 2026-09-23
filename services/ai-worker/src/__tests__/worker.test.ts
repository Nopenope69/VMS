import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AiWorker } from '../worker';
import { OnnxInferenceEngine } from '../inferenceEngine';
import { ModelManifestRecord, VideoFrame } from '../types';
import { CoordinateTransformer } from '../coordinateTransformer';

describe('AiWorker End-to-End', () => {
  let tmpDir: string;
  let artifactPath: string;
  let manifest: ModelManifestRecord;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AI_INFERENCE_MODE = 'test-stub';

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-test-'));
    artifactPath = path.join(tmpDir, 'model.onnx');
    const content = Buffer.from('mock-onnx-bytes-12345');
    fs.writeFileSync(artifactPath, content);

    const sha256 = crypto.createHash('sha256').update(content).digest('hex');

    manifest = {
      id: 'manifest-yolo-1',
      name: 'vigilone-person-vehicle-detector',
      version: '1.0.0',
      sha256,
      codeLicense: 'Apache-2.0',
      weightLicense: 'Apache-2.0',
      runtimeConfigJson: {
        runtime: 'onnxruntime',
        inputWidth: 640,
        inputHeight: 640,
        colorSpace: 'RGB',
        modelFormat: 'ONNX',
      },
      classesJson: {
        '0': 'person',
        '1': 'vehicle',
      },
      thresholdsJson: {
        person: 0.45,
        vehicle: 0.5,
      },
      modelSignatureJson: {
        input: { name: 'images', shape: [1, 3, 640, 640], dtype: 'float32' },
        output: { name: 'output0', shape: [1, 6, 8400], dtype: 'float32' },
        coordinateFormat: 'cxcywh',
        hasObjectness: false,
        classCount: 2,
      },
      isActive: true,
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('initializes model, transitions to HEALTHY, and processes VideoFrame with mandatory geometry', async () => {
    const worker = new AiWorker({
      backendBaseUrl: 'http://127.0.0.1:4000',
      internalSecret: 'test-secret',
    });

    // Mock apiClient.submitDetection to avoid real HTTP requests
    (worker as any).apiClient.submitDetection = jest.fn().mockResolvedValue({ success: true });

    expect(worker.getHealth().status).toBe('INITIALIZING');

    await worker.initializeModel(manifest, artifactPath);

    expect(worker.getHealth().status).toBe('HEALTHY');
    expect(worker.getHealth().loadedModel?.id).toBe(manifest.id);

    const geometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);
    const testFrame: VideoFrame = {
      cameraId: 'cam-lobby',
      tenantId: 'tenant-100',
      streamPath: 'cam_lobby_feed',
      streamSessionId: 'sess-123',
      sequenceNumber: 1,
      sampledAt: new Date(),
      receivedAt: new Date(),
      width: 640,
      height: 640,
      channels: 3,
      data: Buffer.alloc(640 * 640 * 3),
      geometry,
    };

    const events = await worker.processFrame(testFrame);
    expect(events.length).toBeGreaterThan(0);

    const types = events.map((e) => e.type);
    expect(types).toContain('PERSON_DETECTED');
    expect(types).toContain('VEHICLE_DETECTED');

    for (const evt of events) {
      expect(evt.tenantId).toBe('tenant-100');
      expect(evt.cameraId).toBe('cam-lobby');
      expect(evt.modelManifestId).toBe(manifest.id);
      expect(evt.boundingBox.x).toBeGreaterThanOrEqual(0);
      expect(evt.boundingBox.y).toBeGreaterThanOrEqual(0);
      expect(evt.boundingBox.width).toBeGreaterThan(0);
      expect(evt.boundingBox.height).toBeGreaterThan(0);
    }

    const telemetry = worker.getSchedulerTelemetry();
    expect(telemetry.inferenceCount).toBe(1);
    expect(telemetry.successCount).toBe(1);
  });

  it('rejects frame without guessing if mandatory FrameGeometry is missing', async () => {
    const worker = new AiWorker({
      backendBaseUrl: 'http://127.0.0.1:4000',
      internalSecret: 'test-secret',
    });
    await worker.initializeModel(manifest, artifactPath);

    // Call with raw buffer without geometry in context
    const rawBuffer = Buffer.alloc(640 * 640 * 3);

    await expect(
      worker.processFrame(rawBuffer, {
        cameraId: 'cam-1',
        tenantId: 't-1',
      })
    ).rejects.toThrow('Worker cannot process frame: Mandatory FrameGeometry is missing or inconsistent.');
  });

  it('transitions to ERROR status when model initialization fails', async () => {
    const worker = new AiWorker({
      backendBaseUrl: 'http://127.0.0.1:4000',
      internalSecret: 'test-secret',
    });

    const badManifest = { ...manifest, sha256: 'corrupted-sha256' };

    await expect(worker.initializeModel(badManifest, artifactPath)).rejects.toThrow();

    const health = worker.getHealth();
    expect(health.status).toBe('ERROR');
    expect(health.lastError).toBeDefined();
  });
});
