import crypto from 'crypto';
import { RawDetection, NormalizedDetectionEvent } from './types';

export class DetectionNormalizer {
  /**
   * Maps model detection label to authoritative VigilOne EventType.
   */
  public static mapLabelToEventType(label: string): string {
    const lower = label.toLowerCase();
    if (lower.includes('person') || lower.includes('human') || lower.includes('pedestrian')) {
      return 'PERSON_DETECTED';
    }
    if (lower.includes('car') || lower.includes('vehicle') || lower.includes('truck') || lower.includes('bus')) {
      return 'VEHICLE_DETECTED';
    }
    return 'MOTION';
  }

  /**
   * Normalizes raw model detection outputs into authoritative VigilOne DetectionEvent payloads.
   * Generates a unique, immutable worker inference ID for database-level idempotency.
   */
  public static normalize(
    detection: RawDetection,
    context: {
      tenantId: string;
      cameraId: string;
      modelManifestId: string;
      frameTimestamp?: Date;
      customInferenceId?: string;
    }
  ): NormalizedDetectionEvent {
    // Clamp bounding box strictly to [0..1] range
    const x = Math.max(0, Math.min(1.0, detection.box.x));
    const y = Math.max(0, Math.min(1.0, detection.box.y));
    const width = Math.max(0.001, Math.min(1.0 - x, detection.box.width));
    const height = Math.max(0.001, Math.min(1.0 - y, detection.box.height));

    const centroid = {
      x: +(x + width / 2).toFixed(4),
      y: +(y + height / 2).toFixed(4),
    };

    const type = DetectionNormalizer.mapLabelToEventType(detection.label);
    const inferenceId = context.customInferenceId || crypto.randomUUID();
    const timestamp = (context.frameTimestamp || new Date()).toISOString();

    return {
      tenantId: context.tenantId,
      cameraId: context.cameraId,
      modelManifestId: context.modelManifestId,
      inferenceId,
      type,
      confidence: +detection.confidence.toFixed(4),
      boundingBox: {
        x: +x.toFixed(4),
        y: +y.toFixed(4),
        width: +width.toFixed(4),
        height: +height.toFixed(4),
      },
      centroid,
      attributesJson: {
        rawClassId: detection.classId,
        rawLabel: detection.label,
      },
      timestamp,
    };
  }
}
