import { OnnxInferenceEngine } from '../inferenceEngine';
import { ModelManifestRecord, FrameGeometry } from '../types';
import { CoordinateTransformer } from '../coordinateTransformer';

describe('OnnxInferenceEngine', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('1. Production Hard Guard', () => {
    it('throws FATAL CONFIGURATION ERROR if AI_INFERENCE_MODE=test-stub in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.AI_INFERENCE_MODE = 'test-stub';

      expect(() => new OnnxInferenceEngine()).toThrow(
        /FATAL CONFIGURATION ERROR: AI_INFERENCE_MODE=test-stub is strictly forbidden in production/
      );
    });

    it('throws FATAL CONFIGURATION ERROR if AI_ENV=production and AI_INFERENCE_MODE=test-stub', () => {
      process.env.NODE_ENV = 'development';
      process.env.AI_ENV = 'production';
      process.env.AI_INFERENCE_MODE = 'test-stub';

      expect(() => new OnnxInferenceEngine()).toThrow(
        /FATAL CONFIGURATION ERROR: AI_INFERENCE_MODE=test-stub is strictly forbidden in production/
      );
    });

    it('throws if AI_INFERENCE_MODE=test-stub outside NODE_ENV=test (e.g. development)', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.AI_ENV;
      process.env.AI_INFERENCE_MODE = 'test-stub';
      expect(() => new OnnxInferenceEngine()).toThrow(/only permitted when NODE_ENV=test/);
    });

    it('allows test-stub only under NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.AI_ENV;
      process.env.AI_INFERENCE_MODE = 'test-stub';
      expect(new OnnxInferenceEngine().getMode()).toBe('test-stub');
    });
  });

  describe('2. Native Mode Fail-Fast', () => {
    it('fails fast with fatal error when native bindings cannot be loaded', async () => {
      delete process.env.NODE_ENV;
      delete process.env.AI_ENV;
      process.env.AI_INFERENCE_MODE = 'native';

      const engine = new OnnxInferenceEngine();
      expect(engine.getMode()).toBe('native');

      const dummyBuffer = Buffer.from('fake-onnx-bytes');
      const runtimeConfig = {
        runtime: 'onnxruntime',
        inputWidth: 640,
        inputHeight: 640,
        colorSpace: 'RGB',
        modelFormat: 'ONNX',
      };

      // In this test environment, onnxruntime-node is not installed
      await expect(engine.load(dummyBuffer, runtimeConfig)).rejects.toThrow(
        /FATAL EXECUTION ERROR: Failed to load native onnxruntime-node execution engine/
      );
      expect(engine.isLoaded()).toBe(false);
    });
  });

  describe('3. Governed Test-Stub Mode', () => {
    const manifest: ModelManifestRecord = {
      id: 'manifest-001',
      name: 'vigilone-person-vehicle-detector',
      version: '1.0.0',
      sha256: 'a1b2c3d4e5f6',
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

    beforeEach(() => {
      process.env.NODE_ENV = 'test';
      process.env.AI_INFERENCE_MODE = 'test-stub';
    });

    it('loads model artifact and initializes in test-stub mode', async () => {
      const engine = new OnnxInferenceEngine();
      expect(engine.getMode()).toBe('test-stub');

      const artifact = Buffer.from('mock-artifact');
      await engine.load(artifact, manifest.runtimeConfigJson, manifest);

      expect(engine.isLoaded()).toBe(true);
      expect(engine.getRuntimeName()).toBe('onnxruntime');
    });

    it('executes inference, applies class thresholds and FrameGeometry coordinate reversal', async () => {
      const engine = new OnnxInferenceEngine();
      await engine.load(Buffer.from('mock'), manifest.runtimeConfigJson, manifest);

      // Create a dummy RGB frame buffer (640 * 640 * 3)
      const frameBuffer = Buffer.alloc(640 * 640 * 3);
      const geometry: FrameGeometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);

      const detections = await engine.infer(frameBuffer, {
        imageWidth: 640,
        imageHeight: 640,
        geometry,
      });

      expect(detections.length).toBeGreaterThan(0);
      const labels = detections.map((d) => d.label);
      expect(labels).toContain('person');
      expect(labels).toContain('vehicle');

      // Verify all detections satisfy manifest thresholds
      for (const det of detections) {
        if (det.label === 'person') {
          expect(det.confidence).toBeGreaterThanOrEqual(0.45);
        } else if (det.label === 'vehicle') {
          expect(det.confidence).toBeGreaterThanOrEqual(0.5);
        }
        // Coordinates must be in [0..1] source camera range
        expect(det.box.x).toBeGreaterThanOrEqual(0);
        expect(det.box.y).toBeGreaterThanOrEqual(0);
        expect(det.box.width).toBeGreaterThan(0);
        expect(det.box.height).toBeGreaterThan(0);
      }

      // Check TensorBufferPool acquired and released buffer cleanly
      const poolStats = engine.getTensorPoolStats();
      expect(poolStats.inUse).toBe(0);
      expect(poolStats.poolAvailable).toBe(poolStats.capacity);
    });
  });
});
