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
import { decodeModelOutputs } from './decoders';
import { fillPlanarTensor } from './preprocess';
import { planSession, createSessionWithFallback, FallbackNote } from './executionProvider';

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
  /** Runtime facts for per-inference provenance (events.v1 AiProvenanceV1). */
  getRuntimeInfo?(): RuntimeInfo;
}

export interface RuntimeInfo {
  runtime: 'onnxruntime' | 'openvino';
  runtimeVersion: string | null;
  /** The provider that actually created the session (never the one that was merely requested). */
  executionProvider: string | null;
  /** Set when the requested provider could not start and the CPU ran instead. */
  executionProviderFallback?: FallbackNote;
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
  private ort: any = null;
  private tensorPool: TensorBufferPool;
  private poolCapacity: number;
  private inputWidth = 640;
  private inputHeight = 640;
  private runtimeVersion: string | null = null;
  private executionProvider: string | null = null;
  private executionProviderFallback: FallbackNote | undefined;

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
    this.poolCapacity = poolCapacity;
    this.tensorPool = new TensorBufferPool({ capacity: poolCapacity });
  }

  public getMode(): 'native' | 'test-stub' {
    return this.mode;
  }

  public getRuntimeInfo(): RuntimeInfo {
    return {
      runtime: this.runtimeName.toLowerCase() === 'openvino' ? 'openvino' : 'onnxruntime',
      runtimeVersion: this.runtimeVersion,
      executionProvider: this.executionProvider,
      ...(this.executionProviderFallback ? { executionProviderFallback: this.executionProviderFallback } : {}),
    };
  }

  public async load(
    artifactBuffer: Buffer,
    config: RuntimeConfig,
    manifest?: ModelManifestRecord
  ): Promise<void> {
    if (!artifactBuffer || artifactBuffer.length === 0) {
      throw new Error('Cannot load inference engine with empty model artifact buffer');
    }

    this.loaded = false;
    this.executionProviderFallback = undefined;
    this.config = config;
    this.manifest = manifest;
    this.runtimeName = config.runtime || 'onnxruntime';

    // Input size: the manifest signature is authoritative; runtime config is the fallback.
    const sigShape = manifest?.modelSignatureJson?.input?.shape;
    this.inputWidth = (sigShape && sigShape[3]) || config.inputWidth || 640;
    this.inputHeight = (sigShape && sigShape[2]) || config.inputHeight || 640;
    if (
      manifest?.modelSignatureJson &&
      (config.inputWidth !== this.inputWidth || config.inputHeight !== this.inputHeight)
    ) {
      throw new Error(
        `Manifest inconsistency: runtimeConfig ${config.inputWidth}x${config.inputHeight} does not match signature input ${this.inputWidth}x${this.inputHeight}`
      );
    }
    this.tensorPool = new TensorBufferPool({
      capacity: this.poolCapacity,
      width: this.inputWidth,
      height: this.inputHeight,
    });

    if (this.mode === 'native') {
      let ort: any;
      try {
        ort = require('onnxruntime-node');
      } catch (err: any) {
        throw new Error(
          `FATAL EXECUTION ERROR: Failed to load native onnxruntime-node execution engine: ${err.message}. Native inference requires onnxruntime-node binary bindings.`
        );
      }
      this.ort = ort;

      // Execution provider: CPU unless the manifest names another one. If that one cannot start the model
      // runs on CPU (AI_EP_FALLBACK=none to refuse instead) and the fallback is recorded, never hidden.
      const plan = planSession(normalizeExecutionProvider(config.executionProvider));
      const created = await createSessionWithFallback(ort, artifactBuffer, plan);
      this.session = created.session;
      this.executionProviderFallback = created.fallback;
      if (created.fallback) {
        console.warn(
          `[AiWorker] execution provider '${created.fallback.from}' could not start (${created.fallback.reason}); running on CPU`
        );
      }
      this.runtimeVersion = ort.env?.versions?.node ?? ort.env?.versions?.common ?? null;
      this.executionProvider = created.executionProvider;

      // Verify ONNX graph signature against manifest contract
      if (manifest?.modelSignatureJson) {
        const sig = manifest.modelSignatureJson;
        if (!this.session.inputNames.includes(sig.input.name)) {
          throw new Error(
            `ONNX graph input mismatch: graph inputs [${this.session.inputNames.join(', ')}] does not include required input '${sig.input.name}'`
          );
        }
        const requiredOutputs = [sig.output.name, sig.logitsOutputName].filter(Boolean) as string[];
        for (const name of requiredOutputs) {
          if (!this.session.outputNames.includes(name)) {
            throw new Error(
              `ONNX graph output mismatch: graph outputs [${this.session.outputNames.join(', ')}] does not include required output '${name}'`
            );
          }
        }
      }

      // One-time pre-loop warm-up inference pass at the real input size
      const warmUpTensor = this.tensorPool.acquire();
      warmUpTensor.fill(0);

      try {
        const inputName = manifest?.modelSignatureJson?.input.name || this.session.inputNames[0];
        const tensor = new ort.Tensor('float32', warmUpTensor, [1, 3, this.inputHeight, this.inputWidth]);
        await this.session.run({ [inputName]: tensor });
      } catch (err: any) {
        throw new Error(`ONNX warm-up execution failed: ${err.message}`);
      } finally {
        this.tensorPool.release(warmUpTensor);
      }
    }

    this.loaded = true;
  }

  public getInputSize(): { width: number; height: number } {
    return { width: this.inputWidth, height: this.inputHeight };
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

    let width = this.inputWidth;
    let height = this.inputHeight;
    let geometry: FrameGeometry | undefined;

    if (typeof options === 'number') {
      width = options;
      if (imageHeight) height = imageHeight;
    } else if (options) {
      if (options.imageWidth) width = options.imageWidth;
      if (options.imageHeight) height = options.imageHeight;
      geometry = options.geometry;
    }

    if (this.mode === 'native' && (width !== this.inputWidth || height !== this.inputHeight)) {
      throw new Error(
        `INVALID_FRAME: frame is ${width}x${height} but the loaded model expects ${this.inputWidth}x${this.inputHeight}`
      );
    }

    // Acquire pre-allocated planar float32 buffer
    const planarBuffer = this.tensorPool.acquire();

    try {
      if (input instanceof Float32Array) {
        if (input.length !== planarBuffer.length) {
          throw new Error(`INVALID_FRAME: tensor has ${input.length} elements, expected ${planarBuffer.length}`);
        }
        planarBuffer.set(input);
      } else {
        fillPlanarTensor(input, planarBuffer, width, height, this.config);
      }

      if (this.mode === 'native') {
        const ort = this.ort;
        const sig = this.manifest?.modelSignatureJson;
        const inputName = sig?.input.name || this.session.inputNames[0];

        const tensor = new ort.Tensor('float32', planarBuffer, [1, 3, height, width]);
        const results = await this.session.run({ [inputName]: tensor });

        const outputs: Record<string, Float32Array> = {};
        for (const name of Object.keys(results)) {
          const t = results[name];
          if (t && t.type === 'float32' && ArrayBuffer.isView(t.data)) outputs[name] = t.data as Float32Array;
        }
        const signature = this.getEffectiveSignature();
        if (!outputs[signature.output.name]) {
          throw new Error(`Execution did not return expected output tensor '${signature.output.name}'`);
        }
        return decodeModelOutputs({
          signature,
          classMapping: this.getEffectiveClassMapping(),
          thresholds: this.getEffectiveThresholds(),
          nmsConfig: this.getEffectiveNmsConfig(),
          geometry,
          outputs,
        });
      } else {
        // Deterministic test-stub engine (NODE_ENV=test only, enforced in the constructor)
        return this.generateStubDetections(geometry);
      }
    } finally {
      this.tensorPool.release(planarBuffer);
    }
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

/** Maps manifest spellings to onnxruntime-node execution provider names. CPU by default. */
export function normalizeExecutionProvider(ep?: string): string {
  const v = (ep || 'cpu').trim().toLowerCase().replace(/executionprovider$/, '');
  if (v === '' || v === 'cpu') return 'cpu';
  if (v === 'openvino') return 'openvino';
  if (v === 'cuda') return 'cuda';
  if (v === 'dml' || v === 'directml') return 'dml';
  throw new Error(`UNSUPPORTED_EXECUTION_PROVIDER: '${ep}' (supported: cpu, openvino, cuda, dml)`);
}
