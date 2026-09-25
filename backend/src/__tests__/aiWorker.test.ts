import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ModelLoader } from '../../../services/ai-worker/src/modelLoader';
import { DetectionNormalizer } from '../../../services/ai-worker/src/detectionNormalizer';
import { OnnxInferenceEngine } from '../../../services/ai-worker/src/inferenceEngine';
import { WorkerHealthMonitor } from '../../../services/ai-worker/src/health';
import { AiWorker } from '../../../services/ai-worker/src/worker';
import { ModelManifestRecord } from '../../../services/ai-worker/src/types';
import { CoordinateTransformer } from '../../../services/ai-worker/src/coordinateTransformer';

describe('AI Worker Skeleton: Artifact Integrity & Inference Verification', () => {
  let tempDir: string;
  let testModelPath: string;
  let testModelBytes: Buffer;
  let authenticSha256: string;

  const validManifestRecord: ModelManifestRecord = {
    id: 'manifest-ai-worker-01',
    name: 'vigilone-worker-test-model',
    version: '1.0.0',
    sha256: '', // Will populate with authenticSha256
    codeLicense: 'Apache-2.0',
    weightLicense: 'Apache-2.0',
    runtimeConfigJson: {
      runtime: 'onnxruntime',
      runtimeVersion: '1.17.0',
      executionProvider: 'CPUExecutionProvider',
      inputWidth: 640,
      inputHeight: 640,
      colorSpace: 'RGB',
      normalization: {
        type: 'scale',
        value: 255.0,
      },
      letterbox: true,
      modelFormat: 'ONNX',
    },
    isActive: true,
  };

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-worker-test-'));
    testModelPath = path.join(tempDir, 'model.onnx');
    testModelBytes = crypto.randomBytes(8192);
    fs.writeFileSync(testModelPath, testModelBytes);
    authenticSha256 = crypto.createHash('sha256').update(testModelBytes).digest('hex');
    validManifestRecord.sha256 = authenticSha256;
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. ModelLoader Artifact Cryptographic Verification', () => {
    it('successfully loads and verifies model when installed artifact SHA-256 matches manifest', async () => {
      const loaded = await ModelLoader.loadAndVerify(validManifestRecord, testModelPath);

      expect(loaded.verified).toBe(true);
      expect(loaded.sha256).toBe(authenticSha256);
      expect(loaded.buffer.length).toBe(testModelBytes.length);
    });

    it('REFUSES to load model if physical artifact SHA-256 does not match manifest', async () => {
      const tamperedManifest: ModelManifestRecord = {
        ...validManifestRecord,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      await expect(ModelLoader.loadAndVerify(tamperedManifest, testModelPath)).rejects.toThrow(
        /REFUSING TO LOAD UNVERIFIED MODEL ARTIFACT/
      );
    });

    it('rejects loading if model artifact file does not exist on disk', async () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist.onnx');

      await expect(ModelLoader.loadAndVerify(validManifestRecord, nonExistentPath)).rejects.toThrow(
        /Model artifact file not found/
      );
    });

    it('validates and rejects unsupported runtime configuration', () => {
      expect(() =>
        ModelLoader.verifyRuntimeConfig({
          ...validManifestRecord.runtimeConfigJson,
          runtime: 'unsupported-tensorflow-v1',
        })
      ).toThrow(/Unsupported runtime/);

      expect(() =>
        ModelLoader.verifyRuntimeConfig({
          ...validManifestRecord.runtimeConfigJson,
          inputWidth: 0,
        })
      ).toThrow(/Invalid input tensor dimensions/);

      expect(() =>
        ModelLoader.verifyRuntimeConfig({
          ...validManifestRecord.runtimeConfigJson,
          colorSpace: 'CMYK',
        })
      ).toThrow(/Unsupported color space/);
    });
  });

  describe('2. Detection Normalization & Idempotency Generation', () => {
    it('normalizes raw detections to standard VigilOne DetectionEvent format', () => {
      const raw = {
        classId: 0,
        label: 'person',
        confidence: 0.932456,
        box: { x: 0.12345, y: 0.23456, width: 0.34567, height: 0.45678 },
      };

      const normalized = DetectionNormalizer.normalize(raw, {
        tenantId: 'tenant-123',
        cameraId: 'cam-999',
        modelManifestId: 'manifest-001',
      });

      expect(normalized.type).toBe('PERSON_DETECTED');
      expect(normalized.confidence).toBe(0.9325);
      expect(normalized.boundingBox).toEqual({
        x: 0.1235,
        y: 0.2346,
        width: 0.3457,
        height: 0.4568,
      });
      expect(normalized.centroid?.x).toBeCloseTo(0.2963, 3);
      expect(normalized.centroid?.y).toBeCloseTo(0.463, 3);
      // Unique worker-generated inference ID for database idempotency
      expect(normalized.inferenceId).toBeDefined();
      expect(typeof normalized.inferenceId).toBe('string');
      expect(normalized.inferenceId.length).toBeGreaterThan(10);
    });

    it('maps diverse vehicle labels to VEHICLE_DETECTED', () => {
      expect(DetectionNormalizer.mapLabelToEventType('car')).toBe('VEHICLE_DETECTED');
      expect(DetectionNormalizer.mapLabelToEventType('truck')).toBe('VEHICLE_DETECTED');
      expect(DetectionNormalizer.mapLabelToEventType('bus')).toBe('VEHICLE_DETECTED');
      expect(DetectionNormalizer.mapLabelToEventType('pedestrian')).toBe('PERSON_DETECTED');
      expect(DetectionNormalizer.mapLabelToEventType('generic_motion')).toBe('MOTION');
    });

    it('clamps out-of-bounds bounding box coordinates strictly to [0..1]', () => {
      const raw = {
        classId: 0,
        label: 'person',
        confidence: 0.8,
        box: { x: -0.2, y: 1.5, width: 1.8, height: 0.9 },
      };

      const normalized = DetectionNormalizer.normalize(raw, {
        tenantId: 'tenant-1',
        cameraId: 'cam-1',
        modelManifestId: 'manifest-1',
      });

      expect(normalized.boundingBox.x).toBe(0);
      expect(normalized.boundingBox.y).toBe(1.0);
      expect(normalized.boundingBox.width).toBeLessThanOrEqual(1.0);
      expect(normalized.boundingBox.height).toBeLessThanOrEqual(1.0);
    });
  });

  describe('3. Worker Development Sequence (Section 22 Lifecycle)', () => {
    it('executes full sequence: static frame -> verified model -> inference -> normalized events -> API', async () => {
      process.env.AI_INFERENCE_MODE = 'test-stub';
      const engine = new OnnxInferenceEngine();
      const worker = new AiWorker(
        {
          backendBaseUrl: 'http://127.0.0.1:4000/api/v1/internal',
          internalSecret: 'test-secret',
          workerId: 'test-worker-01',
          trackerConfig: { minHitsToConfirm: 1 },
        },
        engine
      );

      // Initial health state
      expect(worker.getHealth().status).toBe('INITIALIZING');

      // Initialize and verify model artifact
      await worker.initializeModel(validManifestRecord, testModelPath);

      // Verified health state
      const health = worker.getHealth();
      expect(health.status).toBe('HEALTHY');
      expect(health.loadedModel?.verified).toBe(true);
      expect(health.loadedModel?.sha256).toBe(authenticSha256);

      // Mock submitDetection on internal client to verify transmission
      const submitSpy = jest
        .spyOn((worker as any).apiClient, 'submitDetection')
        .mockResolvedValue({ success: true, detectionId: 'det-mock-123', inferenceId: 'inf-mock-123' });

      // Process static frame with mandatory FrameGeometry
      const dummyFrame = Buffer.alloc(640 * 640 * 3);
      const geometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);
      const events = await worker.processFrame(dummyFrame, {
        tenantId: 'tenant-edge',
        cameraId: 'cam-01',
        geometry,
      });

      expect(events.length).toBeGreaterThan(0);
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('PERSON_DETECTED');
      expect(events[0].modelManifestId).toBe(validManifestRecord.id);
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-edge',
          cameraId: 'cam-01',
        })
      );

      // Inference counter incremented
      expect(worker.getHealth().inferenceCount).toBe(1);
    });
  });
});
