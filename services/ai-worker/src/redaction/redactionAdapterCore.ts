import { decodeRequestFrame } from '../adapter/frameDecode';
import { DetectionV1, InferenceRequestV1, ModelCardV1 } from '../adapter/contract';
import { PipelineAdapterCore, PipelineAdapterOptions, PipelineCardBase } from '../adapter/pipelineAdapterCore';
import { ortRuntimeLabel } from '../runtimeInfo';
import { LoadedRedactionPipeline } from './redactionPipeline';

/**
 * ai-adapter.v1 for redaction regions (P4.4; contract rules: PipelineAdapterCore): task
 * face_detection_for_redaction returns class 'face', task plate_detection_for_redaction returns class
 * 'license_plate' (text regions, no OCR: the adapter never reads plate text). Only boxes leave the adapter;
 * no crops or embeddings are produced or stored.
 */
export class RedactionAdapterCore extends PipelineAdapterCore<LoadedRedactionPipeline> {
  constructor(loaded: LoadedRedactionPipeline | null, opts: PipelineAdapterOptions) {
    super(loaded, opts, ['face_detection_for_redaction', 'plate_detection_for_redaction'], 'redaction pipeline');
  }

  protected card(_l: LoadedRedactionPipeline, base: PipelineCardBase): ModelCardV1 {
    return {
      ...base,
      classes: ['face', 'license_plate'],
      runtime: 'onnxruntime',
      input: { width: 640, height: 640, colorSpace: 'BGR', letterbox: true },
      // Recall on site footage has not been measured (needs labelled site data).
      evaluation: null,
    };
  }

  protected runtime() {
    return { runtime: ortRuntimeLabel() };
  }

  protected async run(req: InferenceRequestV1) {
    const f = req.frame;
    const faces = req.task === 'face_detection_for_redaction';
    const loaded = this.loaded!;
    const { value: regions, latencyMs } = await this.inSlot(req.deadlineMs, async () => {
      const img = await decodeRequestFrame(f as any);
      return faces ? loaded.faces(img) : loaded.plates(img);
    });
    this.metrics.inc('vigilone_redaction_regions_total', 'Regions returned for redaction', { kind: faces ? 'face' : 'license_plate' }, regions.length);
    const detections: DetectionV1[] = regions.map((r) => ({
      objectClass: r.kind,
      classId: r.kind === 'face' ? 0 : 1,
      confidence: Math.max(0, Math.min(1, r.score)),
      bbox: { x: r.box[0] / f.width, y: r.box[1] / f.height, width: (r.box[2] - r.box[0]) / f.width, height: (r.box[3] - r.box[1]) / f.height },
    }));
    return this.ok(req.requestId, f.timestampUtc, latencyMs, { detections });
  }
}
