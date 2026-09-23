import {
  ModelSignature,
  ModelClassMapping,
  ModelThresholds,
  ModelNmsConfig,
  RawDetection,
  FrameGeometry,
} from './types';
import { CoordinateTransformer } from './coordinateTransformer';
import { classScopedNms } from './classScopedNms';

/**
 * SignatureDecoder
 *
 * Governed Decoder for ONNX Object Detection Output Tensors.
 * Decodes bounding boxes, class confidences, and coordinates strictly according
 * to the model's verified manifest contract (modelSignatureJson).
 */
export class SignatureDecoder {
  public static decode(
    outputData: Float32Array,
    signature: ModelSignature,
    classMapping: ModelClassMapping,
    thresholds: ModelThresholds,
    nmsConfig?: ModelNmsConfig,
    geometry?: FrameGeometry
  ): RawDetection[] {
    if (!outputData || outputData.length === 0) {
      return [];
    }

    const shape = signature.output.shape;
    // Expected shape: either [1, num_boxes, features] or [1, features, num_boxes]
    if (shape.length < 3) {
      throw new Error(`Invalid output tensor shape: expected >= 3 dimensions, got [${shape.join(',')}]`);
    }

    const modelWidth = signature.input.shape[3] || 640;
    const modelHeight = signature.input.shape[2] || 640;

    let isTransposed = false;
    let numBoxes = 0;
    let numFeatures = 0;

    // Determine layout: [1, num_boxes, features] vs [1, features, num_boxes]
    if (shape[1] > shape[2]) {
      // Standard: [1, 8400, 6] or [1, 300, 6]
      numBoxes = shape[1];
      numFeatures = shape[2];
      isTransposed = false;
    } else {
      // Transposed: [1, 6, 8400]
      numFeatures = shape[1];
      numBoxes = shape[2];
      isTransposed = true;
    }

    const expectedLength = numBoxes * numFeatures;
    if (outputData.length !== expectedLength) {
      throw new Error(
        `Model output tensor length mismatch: expected ${expectedLength} elements (${shape.join('x')}), got ${outputData.length}`
      );
    }

    const candidates: RawDetection[] = [];
    const hasObjectness = signature.hasObjectness ?? false;
    const coordFormat = signature.coordinateFormat || 'cxcywh';
    const numClasses = signature.classCount || (hasObjectness ? numFeatures - 5 : numFeatures - 4);

    for (let b = 0; b < numBoxes; b++) {
      let c1: number, c2: number, c3: number, c4: number;

      if (isTransposed) {
        c1 = outputData[0 * numBoxes + b];
        c2 = outputData[1 * numBoxes + b];
        c3 = outputData[2 * numBoxes + b];
        c4 = outputData[3 * numBoxes + b];
      } else {
        const offset = b * numFeatures;
        c1 = outputData[offset + 0];
        c2 = outputData[offset + 1];
        c3 = outputData[offset + 2];
        c4 = outputData[offset + 3];
      }

      // Check if this is a direct detection tensor: [x1, y1, x2, y2, score, classId]
      let bestClassId = 0;
      let maxScore = 0;

      if (!isTransposed && numFeatures === 6 && numClasses > 2) {
        // Direct detection format: [c1, c2, c3, c4, score, classId]
        const offset = b * numFeatures;
        maxScore = outputData[offset + 4];
        bestClassId = Math.round(outputData[offset + 5]);
      } else {
        let objectness = 1.0;
        let classOffset = 4;

        if (hasObjectness) {
          objectness = isTransposed
            ? outputData[4 * numBoxes + b]
            : outputData[b * numFeatures + 4];
          classOffset = 5;
        }

        if (objectness <= 0.01) {
          continue;
        }

        // Find top class score
        for (let c = 0; c < numClasses; c++) {
          const score = isTransposed
            ? outputData[(classOffset + c) * numBoxes + b]
            : outputData[b * numFeatures + (classOffset + c)];

          const totalScore = objectness * score;
          if (totalScore > maxScore) {
            maxScore = totalScore;
            bestClassId = c;
          }
        }
      }

      if (maxScore <= 0) {
        continue;
      }

      // Class mapping from manifest
      const label = classMapping[bestClassId] || classMapping[String(bestClassId)] || `class_${bestClassId}`;

      // Threshold lookup: try direct label, suffixed Confidence, or fallback 0.45
      const threshold =
        thresholds[label] ??
        thresholds[`${label}Confidence`] ??
        thresholds[label.toLowerCase()] ??
        thresholds[`${label.toLowerCase()}Confidence`] ??
        0.45;

      if (maxScore < threshold) {
        continue;
      }

      // Convert coordinates to normalized [0..1] model box { x, y, width, height }
      let x = 0;
      let y = 0;
      let width = 0;
      let height = 0;

      // Check if coordinates are in pixel space (> 1.0)
      const isPixelSpace = Math.max(Math.abs(c1), Math.abs(c2), Math.abs(c3), Math.abs(c4)) > 1.0;
      const normScaleX = isPixelSpace ? 1 / modelWidth : 1.0;
      const normScaleY = isPixelSpace ? 1 / modelHeight : 1.0;

      if (coordFormat === 'cxcywh') {
        const cx = c1 * normScaleX;
        const cy = c2 * normScaleY;
        width = c3 * normScaleX;
        height = c4 * normScaleY;
        x = cx - width / 2;
        y = cy - height / 2;
      } else if (coordFormat === 'xyxy') {
        const x1 = c1 * normScaleX;
        const y1 = c2 * normScaleY;
        const x2 = c3 * normScaleX;
        const y2 = c4 * normScaleY;
        x = x1;
        y = y1;
        width = x2 - x1;
        height = y2 - y1;
      } else {
        // xywh
        x = c1 * normScaleX;
        y = c2 * normScaleY;
        width = c3 * normScaleX;
        height = c4 * normScaleY;
      }

      // Clamp normalized model coordinates to [0..1]
      x = Math.max(0, Math.min(1, x));
      y = Math.max(0, Math.min(1, y));
      width = Math.max(0, Math.min(1 - x, width));
      height = Math.max(0, Math.min(1 - y, height));

      if (width <= 0 || height <= 0) {
        continue;
      }

      // Reverse letterbox padding/scaling if geometry is provided
      let finalBox = { x, y, width, height };
      if (geometry) {
        finalBox = CoordinateTransformer.reverseTransformBox(finalBox, geometry);
      }

      candidates.push({
        classId: bestClassId,
        label,
        confidence: Math.round(maxScore * 10000) / 10000,
        box: finalBox,
      });
    }

    // Apply class-scoped non-maximum suppression
    const iouThreshold = nmsConfig?.iouThreshold ?? 0.45;
    return classScopedNms(candidates, iouThreshold);
  }
}
