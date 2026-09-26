import {
  RawDetection,
  RuntimeConfig,
  ModelManifestRecord,
  ModelSignature,
  ModelClassMapping,
  ModelThresholds,
  ModelNmsConfig,
  FrameGeometry,
} from './types';
import { TensorBufferPool } from './tensorPool';
import { SignatureDecoder } from './signatureDecoder';

export interface InferenceOptions {
  imageWidth?: number;
  imageHeight?: number;
  geometry?: FrameGeometry;
}

export interface IInferenceEngine {
  load(artifactBuffer: Buffer, config: RuntimeConfig, manifest?: ModelManifestRecord): Promise<void>;
  infer(
    input: Buffer | Float32Array,
    options?: InferenceOptions | number,
    imageHeight?: number
  ): Promise<RawDetection[]>;
  isLoaded(): boolean;
  getRuntimeName(): string;
  getMode(): 'native' | 'test-stub';
}

/**
 * Governed ONNX Runtime Inference Engine.
 *
 * STRICT INVARIANTS:
 * 1. Hard Production Guard: Production environments strictly require 'native' mode.
 *    Any attempt to initialize 'test-stub' in production throws a FATAL CONFIGURATION ERROR.
 * 2. Fail-Fast in Native Mode: If native onnxruntime-node bindings are missing or fail to load,
 *    fails fast loudly without falling back to fake detections.
 * 3. Pre-Loop Warm-Up: Session initialization includes a one-time dummy inference pass before RUNNING.
 * 4. Manifest-Driven Governance: Output decoding and NMS use manifest signatures, class mappings,
 *    and threshold limits dynamically.
 * 5. Bounded Tensor Allocation: Uses TensorBufferPool for planar input tensors.
 */
export class OnnxInferenceEngine implements IInferenceEngine {
  private loaded: boolean = false;
  private config?: RuntimeConfig;
  private manifest?: ModelManifestRecord;
  private runtimeName: string = 'onnxruntime';
  private mode: 'native' | 'test-stub';
  private session: any = null;
  private tensorPool: TensorBufferPool;

  constructor(poolCapacity: number = 4) {
    const isProduction =
      process.env.NODE_ENV === 'production' || process.env.AI_ENV === 'production';
    const envMode = (process.env.AI_INFERENCE_MODE || 'native').toLowerCase();

    if (isProduction && envMode === 'test-stub') {
      throw new Error(
        'FATAL CONFIGURATION ERROR: AI_INFERENCE_MODE=test-stub is strictly forbidden in production. Production appliances must use native inference.'
      );
    }
    // Stub detections are a test fixture, not a runtime fallback: allowed only under NODE_ENV=test.
    if (envMode === 'test-stub' && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'FATAL CONFIGURATION ERROR: AI_INFERENCE_MODE=test-stub is only permitted when NODE_ENV=test. Stub detections must never reach a running appliance.'
      );
    }

    this.mode = envMode === 'test-stub' ? 'test-stub' : 'native';
    this.tensorPool = new TensorBufferPool({ capacity: poolCapacity });
  }

  public getMode(): 'native' | 'test-stub' {
    return this.mode;
  }

  public async load(
    artifactBuffer: Buffer,
    config: RuntimeConfig,
    manifest?: ModelManifestRecord
  ): Promise<void> {
    if (!artifactBuffer || artifactBuffer.length === 0) {
      throw new Error('Cannot load inference engine with empty model artifact buffer');
    }

    this.config = config;
    this.manifest = manifest;
    this.runtimeName = config.runtime || 'onnxruntime';

    if (this.mode === 'native') {
      let ort: any;
      try {
        ort = require('onnxruntime-node');
      } catch (err: any) {
        throw new Error(
          `FATAL EXECUTION ERROR: Failed to load native onnxruntime-node execution engine: ${err.message}. Native inference requires onnxruntime-node binary bindings.`
        );
      }

      // Create session with execution provider options
      const sessionOptions: any = {};
      if (config.executionProvider) {
        sessionOptions.executionProviders = [config.executionProvider];
      }

      try {
        this.session = await ort.InferenceSession.create(artifactBuffer, sessionOptions);
      } catch (err: any) {
        throw new Error(`Failed to create native ONNX session: ${err.message}`);
      }

      // Verify ONNX graph signature against manifest contract
      if (manifest?.modelSignatureJson) {
        const sig = manifest.modelSignatureJson;
        if (!this.session.inputNames.includes(sig.input.name)) {
          throw new Error(
            `ONNX graph input mismatch: graph inputs [${this.session.inputNames.join(', ')}] does not include required input '${sig.input.name}'`
          );
        }
        if (!this.session.outputNames.includes(sig.output.name)) {
          throw new Error(
            `ONNX graph output mismatch: graph outputs [${this.session.outputNames.join(', ')}] does not include required output '${sig.output.name}'`
          );
        }
      }

      // One-time pre-loop warm-up inference pass
      const modelWidth = config.inputWidth || 640;
      const modelHeight = config.inputHeight || 640;
      const warmUpTensor = this.tensorPool.acquire();
      warmUpTensor.fill(0);

      try {
        const inputName = manifest?.modelSignatureJson?.input.name || this.session.inputNames[0];
        const tensor = new ort.Tensor('float32', warmUpTensor, [1, 3, modelHeight, modelWidth]);
        await this.session.run({ [inputName]: tensor });
      } catch (err: any) {
        throw new Error(`ONNX warm-up execution failed: ${err.message}`);
      } finally {
        this.tensorPool.release(warmUpTensor);
      }
    }

    this.loaded = true;
  }

  public async infer(
    input: Buffer | Float32Array,
    options?: InferenceOptions | number,
    imageHeight?: number
  ): Promise<RawDetection[]> {
    if (!this.loaded || !this.config) {
      throw new Error('Inference engine must be loaded prior to running inference');
    }

    if (!input || input.length === 0) {
      throw new Error('Input frame buffer is empty');
    }

    let width = this.config.inputWidth || 640;
    let height = this.config.inputHeight || 640;
    let geometry: FrameGeometry | undefined;

    if (typeof options === 'number') {
      width = options;
      if (imageHeight) height = imageHeight;
    } else if (options) {
      if (options.imageWidth) width = options.imageWidth;
      if (options.imageHeight) height = options.imageHeight;
      geometry = options.geometry;
    }

    // Acquire pre-allocated planar float32 buffer
    const planarBuffer = this.tensorPool.acquire();

    try {
      // Preprocessing: Convert interleaved RGB24 buffer to normalized planar Float32Array
      if (input instanceof Float32Array) {
        planarBuffer.set(input);
      } else {
        const pixelCount = width * height;
        const normDiv = this.config.normalization?.value
          ? (Array.isArray(this.config.normalization.value)
              ? this.config.normalization.value[0]
              : this.config.normalization.value)
          : 255.0;

        for (let i = 0; i < pixelCount; i++) {
          planarBuffer[0 * pixelCount + i] = input[i * 3 + 0] / normDiv;
          planarBuffer[1 * pixelCount + i] = input[i * 3 + 1] / normDiv;
          planarBuffer[2 * pixelCount + i] = input[i * 3 + 2] / normDiv;
        }
      }

      // Execute inference
      if (this.mode === 'native') {
        const ort = require('onnxruntime-node');
        const inputName = this.manifest?.modelSignatureJson?.input.name || this.session.inputNames[0];
        const outputName = this.manifest?.modelSignatureJson?.output.name || this.session.outputNames[0];

        const tensor = new ort.Tensor('float32', planarBuffer, [1, 3, height, width]);
        const results = await this.session.run({ [inputName]: tensor });
        const outputTensor = results[outputName];

        if (!outputTensor || !outputTensor.data) {
          throw new Error(`Execution did not return expected output tensor '${outputName}'`);
        }

        const outputData = outputTensor.data as Float32Array;
        return this.decodeDetections(outputData, geometry);
      } else {
        // Deterministic test-stub engine (CI/development only)
        return this.generateStubDetections(geometry);
      }
    } finally {
      this.tensorPool.release(planarBuffer);
    }
  }

  /**
   * Decodes output tensor according to manifest signature and governance rules.
   */
  private decodeDetections(
    outputData: Float32Array,
    geometry?: FrameGeometry
  ): RawDetection[] {
    const signature = this.getEffectiveSignature();
    const classMapping = this.getEffectiveClassMapping();
    const thresholds = this.getEffectiveThresholds();
    const nmsConfig = this.getEffectiveNmsConfig();

    return SignatureDecoder.decode(
      outputData,
      signature,
      classMapping,
      thresholds,
      nmsConfig,
      geometry
    );
  }

  /**
   * Deterministic test-stub generation that runs through the actual SignatureDecoder pipeline.
   */
  private generateStubDetections(geometry?: FrameGeometry): RawDetection[] {
    const signature = this.getEffectiveSignature();
    const classMapping = this.getEffectiveClassMapping();
    const thresholds = this.getEffectiveThresholds();
    const nmsConfig = this.getEffectiveNmsConfig();

    const shape = signature.output.shape;
    let isTransposed = false;
    let numBoxes = 10;
    let numFeatures = 6;

    if (shape.length >= 3) {
      if (shape[1] > shape[2]) {
        numBoxes = shape[1];
        numFeatures = shape[2];
        isTransposed = false;
      } else {
        numFeatures = shape[1];
        numBoxes = shape[2];
        isTransposed = true;
      }
    }

    const syntheticData = new Float32Array(numBoxes * numFeatures);

    // Box 0: High-confidence Person (0.89)
    if (isTransposed) {
      syntheticData[0 * numBoxes + 0] = 200; // cx
      syntheticData[1 * numBoxes + 0] = 250; // cy
      syntheticData[2 * numBoxes + 0] = 100; // w
      syntheticData[3 * numBoxes + 0] = 200; // h
      syntheticData[4 * numBoxes + 0] = 0.89; // person score
      syntheticData[5 * numBoxes + 0] = 0.05; // vehicle score
    } else {
      syntheticData[0] = 200;
      syntheticData[1] = 250;
      syntheticData[2] = 100;
      syntheticData[3] = 200;
      syntheticData[4] = 0.89;
      syntheticData[5] = 0.05;
    }

    // Box 1: High-confidence Vehicle (0.91)
    if (isTransposed) {
      syntheticData[0 * numBoxes + 1] = 450; // cx
      syntheticData[1 * numBoxes + 1] = 380; // cy
      syntheticData[2 * numBoxes + 1] = 220; // w
      syntheticData[3 * numBoxes + 1] = 160; // h
      syntheticData[4 * numBoxes + 1] = 0.05; // person score
      syntheticData[5 * numBoxes + 1] = 0.91; // vehicle score
    } else {
      const off = 1 * numFeatures;
      syntheticData[off + 0] = 450;
      syntheticData[off + 1] = 380;
      syntheticData[off + 2] = 220;
      syntheticData[off + 3] = 160;
      syntheticData[off + 4] = 0.05;
      syntheticData[off + 5] = 0.91;
    }

    // Box 2: Low-confidence person (0.32 < 0.45 threshold -> filtered out)
    if (isTransposed) {
      syntheticData[0 * numBoxes + 2] = 100;
      syntheticData[1 * numBoxes + 2] = 100;
      syntheticData[2 * numBoxes + 2] = 50;
      syntheticData[3 * numBoxes + 2] = 50;
      syntheticData[4 * numBoxes + 2] = 0.32;
      syntheticData[5 * numBoxes + 2] = 0.01;
    } else {
      const off = 2 * numFeatures;
      syntheticData[off + 0] = 100;
      syntheticData[off + 1] = 100;
      syntheticData[off + 2] = 50;
      syntheticData[off + 3] = 50;
      syntheticData[off + 4] = 0.32;
      syntheticData[off + 5] = 0.01;
    }

    return SignatureDecoder.decode(
      syntheticData,
      signature,
      classMapping,
      thresholds,
      nmsConfig,
      geometry
    );
  }

  private getEffectiveSignature(): ModelSignature {
    return (
      this.manifest?.modelSignatureJson || {
        input: {
          name: 'images',
          shape: [1, 3, 640, 640],
          dtype: 'float32',
        },
        output: {
          name: 'output0',
          shape: [1, 6, 8400],
          dtype: 'float32',
        },
        coordinateFormat: 'cxcywh',
        hasObjectness: false,
        classCount: 2,
      }
    );
  }

  private getEffectiveClassMapping(): ModelClassMapping {
    return (
      this.manifest?.classesJson || {
        '0': 'person',
        '1': 'vehicle',
      }
    );
  }

  private getEffectiveThresholds(): ModelThresholds {
    return (
      this.manifest?.thresholdsJson || {
        person: 0.45,
        vehicle: 0.5,
      }
    );
  }

  private getEffectiveNmsConfig(): ModelNmsConfig {
    return (
      this.manifest?.nmsConfigJson || {
        iouThreshold: 0.45,
      }
    );
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public getRuntimeName(): string {
    return this.runtimeName;
  }

  public getTensorPoolStats() {
    return this.tensorPool.getStats();
  }
}
