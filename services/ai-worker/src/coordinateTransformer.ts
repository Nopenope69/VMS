import { FrameGeometry } from './types';

/**
 * Coordinate Transformer for Letterboxed and Rescaled Video Feeds.
 *
 * INVARIANT:
 * Guarantees that bounding boxes generated in model-space (e.g. 640x640 letterboxed)
 * are accurately reversed (unpadded and unscaled) to map onto the native unpadded
 * camera aspect ratio and dimensions (e.g. 1920x1080) in the evidence plane.
 */
export class CoordinateTransformer {
  /**
   * Computes authoritative FrameGeometry from source and model dimensions.
   */
  public static computeGeometry(
    sourceWidth: number,
    sourceHeight: number,
    modelWidth: number,
    modelHeight: number,
    letterbox: boolean = true
  ): FrameGeometry {
    if (!sourceWidth || sourceWidth <= 0 || !sourceHeight || sourceHeight <= 0) {
      throw new Error(`Invalid source dimensions: ${sourceWidth}x${sourceHeight}`);
    }
    if (!modelWidth || modelWidth <= 0 || !modelHeight || modelHeight <= 0) {
      throw new Error(`Invalid model dimensions: ${modelWidth}x${modelHeight}`);
    }

    if (!letterbox) {
      return {
        sourceWidth,
        sourceHeight,
        modelWidth,
        modelHeight,
        scale: 1.0,
        padX: 0,
        padY: 0,
      };
    }

    const scale = Math.min(modelWidth / sourceWidth, modelHeight / sourceHeight);
    const scaledW = Math.round(sourceWidth * scale);
    const scaledH = Math.round(sourceHeight * scale);
    const padX = (modelWidth - scaledW) / 2;
    const padY = (modelHeight - scaledH) / 2;

    return {
      sourceWidth,
      sourceHeight,
      modelWidth,
      modelHeight,
      scale,
      padX,
      padY,
    };
  }

  /**
   * Reverses letterbox padding and scaling, projecting normalized model-space coordinates
   * back to normalized source-space coordinates [0..1].
   */
  public static reverseTransformBox(
    modelBox: { x: number; y: number; width: number; height: number },
    geometry: FrameGeometry
  ): { x: number; y: number; width: number; height: number } {
    if (!geometry || !geometry.sourceWidth || !geometry.modelWidth || !geometry.scale) {
      throw new Error('Mandatory FrameGeometry is missing or inconsistent. Cannot reverse coordinates.');
    }

    // 1. Convert normalized model coordinates to absolute model canvas pixels
    const mX = modelBox.x * geometry.modelWidth;
    const mY = modelBox.y * geometry.modelHeight;
    const mW = modelBox.width * geometry.modelWidth;
    const mH = modelBox.height * geometry.modelHeight;

    // 2. Undo padding offset
    const activeCanvasW = geometry.modelWidth - geometry.padX * 2;
    const activeCanvasH = geometry.modelHeight - geometry.padY * 2;

    const unpadX = Math.max(0, Math.min(activeCanvasW, mX - geometry.padX));
    const unpadY = Math.max(0, Math.min(activeCanvasH, mY - geometry.padY));
    const unpadW = Math.max(0, Math.min(activeCanvasW - unpadX, mW));
    const unpadH = Math.max(0, Math.min(activeCanvasH - unpadY, mH));

    // 3. Undo scale factor to recover source camera pixels
    const srcX = unpadX / geometry.scale;
    const srcY = unpadY / geometry.scale;
    const srcW = unpadW / geometry.scale;
    const srcH = unpadH / geometry.scale;

    // 4. Normalize to native camera frame [0.0..1.0]
    const normX = Math.max(0, Math.min(1, srcX / geometry.sourceWidth));
    const normY = Math.max(0, Math.min(1, srcY / geometry.sourceHeight));
    const normW = Math.max(0, Math.min(1 - normX, srcW / geometry.sourceWidth));
    const normH = Math.max(0, Math.min(1 - normY, srcH / geometry.sourceHeight));

    return {
      x: Math.round(normX * 10000) / 10000,
      y: Math.round(normY * 10000) / 10000,
      width: Math.round(normW * 10000) / 10000,
      height: Math.round(normH * 10000) / 10000,
    };
  }
}
