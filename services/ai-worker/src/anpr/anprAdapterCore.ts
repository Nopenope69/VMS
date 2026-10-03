import { AdapterError } from '../adapter/adapterCore';
import { decodeFrame } from '../adapter/frameDecode';
import { AiProvenanceV1, DetectionV1, ModelCardV1 } from '../adapter/contract';
import { Frame } from '../sdk/core';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { LoadedAnprPipeline } from './anprService';
import { PlateRead, AnprOptions } from './anprPipeline';
import { Image3 } from './imageOps';
import { ortRuntimeLabel } from '../runtimeInfo';

/**
 * ai-adapter.v1 for task plate_recognition (contract rules: PipelineAdapterCore). Each detection carries
 * attributes { plateText, displayText, format, stateCode, lines, reading, rawText }; provenance names the
 * pipeline definition and lists both models. The camera LPR runner calls recognize() under the same limits.
 */
export class AnprAdapterCore extends PipelineAdapterCore<LoadedAnprPipeline> {
  constructor(loaded: LoadedAnprPipeline | null, opts: PipelineAdapterOptions) {
    super(loaded, opts, ['plate_recognition'], 'ANPR pipeline');
  }

  protected card(l: LoadedAnprPipeline, base: PipelineCardBase): ModelCardV1 {
    return {
      ...base,
      classes: ['license_plate'],
      runtime: 'onnxruntime',
      input: { width: l.definition.textDetection.limitSideLen, height: l.definition.textDetection.limitSideLen, colorSpace: 'BGR', letterbox: false, resizeMode: 'min_side' },
      // No accuracy on Indian site data exists yet (P4.3 is HUMAN-REQUIRED).
      evaluation: null,
    };
  }

  protected runtime() {
    return { runtime: ortRuntimeLabel() };
  }

  private async read(l: LoadedAnprPipeline, img: Image3, opts?: Partial<AnprOptions>): Promise<PlateRead[]> {
    const { plates } = await l.pipeline.read(img, { ...l.definition.recognition, ...(opts || {}) });
    this.metrics.inc('vigilone_anpr_plates_read_total', 'Plates read (valid Indian format, above threshold)', undefined, plates.length);
    return plates;
  }

  /** The camera LPR path: runs the pipeline on one RGB frame under the same concurrency limit and deadline. */
  async recognize(img: Image3, frameTimestampUtc: string, deadlineMs: number, opts?: Partial<AnprOptions>): Promise<{ plates: PlateRead[]; provenance: AiProvenanceV1; latencyMs: number }> {
    const loaded = this.loaded;
    if (!loaded) throw new AdapterError('MODEL_NOT_LOADED', this.opts.failure || `${this.label} not loaded`);
    const { value: plates, latencyMs } = await this.inSlot(deadlineMs, () => this.read(loaded, img, opts));
    return { plates, provenance: this.provenance(frameTimestampUtc), latencyMs };
  }

  protected async infer(l: LoadedAnprPipeline, f: Frame) {
    const plates = await this.read(l, await decodeFrame(f));
    const detections: DetectionV1[] = plates.map((p) => ({
      objectClass: 'license_plate',
      classId: 0,
      confidence: Math.max(0, Math.min(1, p.confidence)),
      bbox: { x: p.box[0] / f.width, y: p.box[1] / f.height, width: (p.box[2] - p.box[0]) / f.width, height: (p.box[3] - p.box[1]) / f.height },
      attributes: {
        plateText: p.plate.normalized,
        displayText: p.plate.display,
        format: p.plate.format,
        stateCode: p.plate.stateCode,
        lines: p.lines,
        reading: p.reading,
        rawText: p.rawText,
        corrections: p.plate.corrections,
      },
    }));
    return { detections };
  }
}
