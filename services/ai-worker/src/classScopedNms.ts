import { RawDetection } from './types';

/**
 * Computes Intersection over Union (IoU) between two bounding boxes.
 * Box coordinates are expected to be normalized [0..1] with { x, y, width, height }.
 */
export function computeIoU(
  boxA: { x: number; y: number; width: number; height: number },
  boxB: { x: number; y: number; width: number; height: number }
): number {
  const x1A = boxA.x;
  const y1A = boxA.y;
  const x2A = boxA.x + boxA.width;
  const y2A = boxA.y + boxA.height;

  const x1B = boxB.x;
  const y1B = boxB.y;
  const x2B = boxB.x + boxB.width;
  const y2B = boxB.y + boxB.height;

  const interX1 = Math.max(x1A, x1B);
  const interY1 = Math.max(y1A, y1B);
  const interX2 = Math.min(x2A, x2B);
  const interY2 = Math.min(y2A, y2B);

  const interW = Math.max(0, interX2 - interX1);
  const interH = Math.max(0, interY2 - interY1);
  const interArea = interW * interH;

  const areaA = Math.max(0, boxA.width * boxA.height);
  const areaB = Math.max(0, boxB.width * boxB.height);
  const unionArea = areaA + areaB - interArea;

  if (unionArea <= 0) {
    return 0;
  }

  return interArea / unionArea;
}

/**
 * Class-Scoped Non-Maximum Suppression (NMS).
 *
 * CRITICAL INVARIANT:
 * Candidate boxes are grouped strictly by their semantic class (label / classId)
 * before IoU suppression. Overlapping boxes from DIFFERENT classes (e.g. a person
 * standing next to or inside a vehicle) must NEVER suppress each other.
 */
export function classScopedNms(
  detections: RawDetection[],
  iouThreshold: number = 0.45
): RawDetection[] {
  if (!detections || detections.length === 0) {
    return [];
  }

  // 1. Group detections by class label (or classId fallback)
  const byClass = new Map<string, RawDetection[]>();
  for (const det of detections) {
    const key = det.label || String(det.classId);
    if (!byClass.has(key)) {
      byClass.set(key, []);
    }
    byClass.get(key)!.push(det);
  }

  const suppressedResults: RawDetection[] = [];

  // 2. Perform independent NMS for each class category
  for (const [, classDetections] of byClass) {
    // Sort descending by confidence score
    const sorted = [...classDetections].sort((a, b) => b.confidence - a.confidence);
    const retainedForClass: RawDetection[] = [];

    while (sorted.length > 0) {
      const best = sorted.shift()!;
      retainedForClass.push(best);

      // Filter out any remaining boxes that overlap significantly with 'best'
      for (let i = sorted.length - 1; i >= 0; i--) {
        const candidate = sorted[i];
        const iou = computeIoU(best.box, candidate.box);
        if (iou >= iouThreshold) {
          sorted.splice(i, 1);
        }
      }
    }

    suppressedResults.push(...retainedForClass);
  }

  return suppressedResults;
}
