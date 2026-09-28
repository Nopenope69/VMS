import { ModelClassMapping, ModelThresholds } from '../types';

/** A candidate box in normalized model-canvas coordinates, before letterbox reversal. */
export interface CanvasCandidate {
  classId: number;
  label: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export function labelFor(classMapping: ModelClassMapping, classId: number): string {
  return classMapping[classId] ?? classMapping[String(classId)] ?? `class_${classId}`;
}

/**
 * Per-class confidence threshold from the manifest. Accepts `person`, `personConfidence`
 * (legacy spelling) and a `default` entry; 0.45 when nothing is configured.
 */
export function thresholdFor(thresholds: ModelThresholds, label: string): number {
  const lower = label.toLowerCase();
  return (
    thresholds[label] ??
    thresholds[`${label}Confidence`] ??
    thresholds[lower] ??
    thresholds[`${lower}Confidence`] ??
    thresholds.default ??
    0.45
  );
}

/** Lowest threshold across all classes, used as a cheap pre-filter before per-class checks. */
export function minThreshold(thresholds: ModelThresholds): number {
  const values = Object.values(thresholds).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const fallback = thresholds.default ?? 0.45;
  return values.length === 0 ? fallback : Math.min(fallback, ...values);
}

/** Converts pixel xyxy on the model canvas into a clipped normalized {x,y,width,height}; null if empty. */
export function canvasBoxFromXyxy(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  modelWidth: number,
  modelHeight: number
): { x: number; y: number; width: number; height: number } | null {
  const cx1 = Math.max(0, Math.min(modelWidth, x1));
  const cy1 = Math.max(0, Math.min(modelHeight, y1));
  const cx2 = Math.max(0, Math.min(modelWidth, x2));
  const cy2 = Math.max(0, Math.min(modelHeight, y2));
  if (cx2 - cx1 <= 0 || cy2 - cy1 <= 0) return null;
  return {
    x: cx1 / modelWidth,
    y: cy1 / modelHeight,
    width: (cx2 - cx1) / modelWidth,
    height: (cy2 - cy1) / modelHeight,
  };
}
