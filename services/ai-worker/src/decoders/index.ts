import {
  FrameGeometry,
  ModelClassMapping,
  ModelNmsConfig,
  ModelSignature,
  ModelThresholds,
  RawDetection,
} from '../types';
import { classScopedNms } from '../classScopedNms';
import { CoordinateTransformer } from '../coordinateTransformer';
import { SignatureDecoder } from '../signatureDecoder';
import { CanvasCandidate } from './common';
import { decodeYolox } from './yoloxDecoder';
import { decodeRfdetr } from './rfdetrDecoder';

export { decodeYolox, yoloxAnchorCount } from './yoloxDecoder';
export { decodeRfdetr } from './rfdetrDecoder';

export interface DecodeInputs {
  signature: ModelSignature;
  classMapping: ModelClassMapping;
  thresholds: ModelThresholds;
  nmsConfig?: ModelNmsConfig;
  geometry?: FrameGeometry;
  /** Output tensors by name. */
  outputs: Record<string, Float32Array>;
}

function requireOutput(outputs: Record<string, Float32Array>, name: string | undefined): Float32Array {
  if (!name || !outputs[name]) {
    throw new Error(`Model did not return expected output tensor '${name}' (got: ${Object.keys(outputs).join(', ')})`);
  }
  return outputs[name];
}

function finalize(cands: CanvasCandidate[], geometry: FrameGeometry | undefined): RawDetection[] {
  return cands
    .map((c) => ({
      classId: c.classId,
      label: c.label,
      confidence: Math.round(c.confidence * 10000) / 10000,
      box: geometry ? CoordinateTransformer.reverseTransformBox(c.box, geometry) : c.box,
    }))
    .filter((d) => d.box.width > 0 && d.box.height > 0);
}

/**
 * Turns raw output tensors into detections in normalized source-camera coordinates, using the
 * decoder named by the model's manifest signature. Unknown decoders fail loudly.
 */
export function decodeModelOutputs(input: DecodeInputs): RawDetection[] {
  const { signature, classMapping, thresholds, nmsConfig, geometry, outputs } = input;
  const kind = signature.decoder ?? 'generic';
  const modelWidth = signature.input.shape[3];
  const modelHeight = signature.input.shape[2];

  switch (kind) {
    case 'yolox': {
      const out = requireOutput(outputs, signature.output.name);
      const shape = signature.output.shape;
      const numClasses = signature.classCount || shape[shape.length - 1] - 5;
      const cands = decodeYolox(out, classMapping, thresholds, {
        modelWidth,
        modelHeight,
        numClasses,
        strides: signature.strides,
      });
      // NMS on the model canvas (uniform scale, so IoU equals source-space IoU), then reverse.
      const kept = classScopedNms(cands as RawDetection[], nmsConfig?.iouThreshold ?? 0.45) as CanvasCandidate[];
      return finalize(kept, geometry);
    }
    case 'rfdetr': {
      const boxes = requireOutput(outputs, signature.output.name);
      const logits = requireOutput(outputs, signature.logitsOutputName);
      const numQueries = signature.output.shape[1];
      const numClasses = logits.length / numQueries;
      if (!Number.isInteger(numClasses)) {
        throw new Error(`RF-DETR logits length ${logits.length} is not a multiple of ${numQueries} queries`);
      }
      const cands = decodeRfdetr(boxes, logits, classMapping, thresholds, {
        numQueries,
        numClasses,
        backgroundClassId: signature.backgroundClassId ?? null,
      });
      return finalize(cands, geometry);
    }
    case 'generic': {
      const out = requireOutput(outputs, signature.output.name);
      return SignatureDecoder.decode(out, signature, classMapping, thresholds, nmsConfig, geometry);
    }
    default:
      throw new Error(`UNSUPPORTED_DECODER: model signature names unknown decoder '${kind}'`);
  }
}
