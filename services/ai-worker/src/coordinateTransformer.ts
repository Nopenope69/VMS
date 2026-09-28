import { FrameGeometry, PadPosition } from './types';

/**
 * Coordinate Transformer for Letterboxed and Rescaled Video Feeds.
 *
 * INVARIANT:
 * Guarantees that bounding boxes generated in model-space (e.g. 640x640 letterboxed)
 * are accurately reversed (unpadded and unscaled) to map onto the native unpadded
 * camera aspect ratio and dimensions (e.g. 1920x1080) in the evidence plane.
 *
 * Geometry is integer-exact: the scaled image size and pad offsets computed here are passed to
 * ffmpeg verbatim (see FrameExtractor.buildVideoFilter), so the reverse transform never relies on
 * ffmpeg's own rounding.
 */
export class CoordinateTransformer {
  /**
   * Computes authoritative FrameGeometry from source and model dimensions.
   *
   * letterbox=true: aspect-preserving scale plus padding (YOLO-family models).
   * letterbox=false: stretch to the model size (DETR-family models); per-axis scale, no padding.
   * padPosition: 'center' (default) or 'top-left' (the layout the official YOLOX preprocessing uses).
   */
  public static computeGeometry(
    sourceWidth: number,
    sourceHeight: number,
    modelWidth: number,
    modelHeight: number,
    letterbox: boolean = true,
    padPosition: PadPosition = 'center'
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
        scaledWidth: modelWidth,
        scaledHeight: modelHeight,
        letterbox: false,
        padPosition,
      };
    }

    const scale = Math.min(modelWidth / sourceWidth, modelHeight / sourceHeight);
    const scaledWidth = Math.max(1, Math.min(modelWidth, Math.round(sourceWidth * scale)));
    const scaledHeight = Math.max(1, Math.min(modelHeight, Math.round(sourceHeight * scale)));
    const padX = padPosition === 'top-left' ? 0 : Math.floor((modelWidth - scaledWidth) / 2);
    const padY = padPosition === 'top-left' ? 0 : Math.floor((modelHeight - scaledHeight) / 2);

    return {
      sourceWidth,
      sourceHeight,
      modelWidth,
      modelHeight,
      scale,
      padX,
      padY,
      scaledWidth,
      scaledHeight,
      letterbox: true,
      padPosition,
    };
  }

  /**
   * Reverses letterbox padding and scaling, projecting normalized model-space coordinates
   * back to normalized source-space coordinates [0..1]. Boxes are clipped to the active
   * (non-padding) image area before scaling back.
   */
  public static reverseTransformBox(
    modelBox: { x: number; y: number; width: number; height: number },
    geometry: FrameGeometry
  ): { x: number; y: number; width: number; height: number } {
    if (!geometry || !geometry.sourceWidth || !geometry.modelWidth || !geometry.scale) {
      throw new Error('Mandatory FrameGeometry is missing or inconsistent. Cannot reverse coordinates.');
    }

    // Size of the real image inside the model canvas. Older geometry objects (without the
    // explicit fields) were always centred letterboxes, so derive it from the padding.
    const activeW = geometry.scaledWidth ?? geometry.modelWidth - geometry.padX * 2;
    const activeH = geometry.scaledHeight ?? geometry.modelHeight - geometry.padY * 2;
    if (activeW <= 0 || activeH <= 0) {
      throw new Error('Mandatory FrameGeometry is missing or inconsistent. Cannot reverse coordinates.');
    }

    // 1. Model-canvas pixels, then remove the pad offset and clip to the active image.
    const x1 = clamp(modelBox.x * geometry.modelWidth - geometry.padX, 0, activeW);
    const y1 = clamp(modelBox.y * geometry.modelHeight - geometry.padY, 0, activeH);
    const x2 = clamp((modelBox.x + modelBox.width) * geometry.modelWidth - geometry.padX, 0, activeW);
    const y2 = clamp((modelBox.y + modelBox.height) * geometry.modelHeight - geometry.padY, 0, activeH);

    // 2. Active-image pixels to normalized source coordinates (per axis, so stretch works too).
    const normX = x1 / activeW;
    const normY = y1 / activeH;
    const normW = Math.max(0, Math.min(1 - normX, (x2 - x1) / activeW));
    const normH = Math.max(0, Math.min(1 - normY, (y2 - y1) / activeH));

    return {
      x: Math.round(normX * 10000) / 10000,
      y: Math.round(normY * 10000) / 10000,
      width: Math.round(normW * 10000) / 10000,
      height: Math.round(normH * 10000) / 10000,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
