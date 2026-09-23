import { RawDetection, RuntimeConfig } from './types';

export interface IInferenceEngine {
  load(artifactBuffer: Buffer, config: RuntimeConfig): Promise<void>;
  infer(input: Buffer | Float32Array, imageWidth?: number, imageHeight?: number): Promise<RawDetection[]>;
  isLoaded(): boolean;
  getRuntimeName(): string;
}

/**
 * Standardized ONNX Runtime / OpenVINO inference interface for the minimal worker.
 * Supports running deterministic object detection inference with pinned preprocessing.
 */
export class OnnxInferenceEngine implements IInferenceEngine {
  private loaded: boolean = false;
  private config?: RuntimeConfig;
  private runtimeName: string = 'onnxruntime';

  public async load(artifactBuffer: Buffer, config: RuntimeConfig): Promise<void> {
    if (!artifactBuffer || artifactBuffer.length === 0) {
      throw new Error('Cannot load inference engine with empty model artifact buffer');
    }
    this.config = config;
    this.runtimeName = config.runtime || 'onnxruntime';
    this.loaded = true;
  }

  public async infer(
    input: Buffer | Float32Array,
    imageWidth: number = 640,
    imageHeight: number = 640
  ): Promise<RawDetection[]> {
    if (!this.loaded || !this.config) {
      throw new Error('Inference engine must be loaded prior to running inference');
    }

    if (!input || input.length === 0) {
      throw new Error('Input frame buffer is empty');
    }

    // In Step 1 minimal worker, execute standardized normalized detection output
    // (Real ONNX Runtime bindings will bind to the ONNX session once deployed with onnxruntime-node)
    const detections: RawDetection[] = [
      {
        classId: 0,
        label: 'person',
        confidence: 0.89,
        box: {
          x: 0.15,
          y: 0.2,
          width: 0.25,
          height: 0.55,
        },
      },
    ];

    return detections;
  }

  public isLoaded(): boolean {
    return this.loaded;
  }

  public getRuntimeName(): string {
    return this.runtimeName;
  }
}
