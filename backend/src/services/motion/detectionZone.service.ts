import { DetectionZone } from '@prisma/client';
import {
  SpatialEngine,
  Point2D,
  BoundingBox2D,
  ZoneEvaluationResult,
  ZoneConfigSnapshot,
} from '../spatial/engine';

export {
  Point2D,
  BoundingBox2D,
  ZoneEvaluationResult,
  ZoneConfigSnapshot,
};

/**
 * Backward compatibility facade delegating exclusively to authoritative SpatialEngine facade.
 */
export class DetectionZoneService {
  public static isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    return SpatialEngine.isPointInPolygon(point, polygon);
  }

  public static isBBoxInPolygon(bbox: BoundingBox2D, polygon: Point2D[]): boolean {
    return SpatialEngine.isBBoxInPolygon(bbox, polygon);
  }

  public static evaluateDetection(
    detection: Point2D | BoundingBox2D,
    zones: DetectionZone[]
  ): ZoneEvaluationResult {
    return SpatialEngine.evaluateDetection(detection, zones);
  }

  public static createZoneSnapshot(zones: DetectionZone[]): ZoneConfigSnapshot {
    return SpatialEngine.createZoneSnapshot(zones);
  }
}

export default DetectionZoneService;
