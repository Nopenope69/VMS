import { DetectionZone, ZoneType } from '@prisma/client';
import { Point2D, BoundingBox2D, SpatialGeometry } from './geometry';

export interface ZoneEvaluationResult {
  allowed: boolean;
  reason:
    | 'DEFAULT_ALLOW'
    | 'MATCHED_INCLUSION'
    | 'BLOCKED_BY_EXCLUSION'
    | 'OUTSIDE_INCLUSION_ZONES';
  matchedZoneId?: string;
  matchedZoneName?: string;
}

export interface ZoneConfigSnapshot {
  snapshotTimestamp: string;
  zonesCount: number;
  zones: Array<{
    id: string;
    name: string;
    type: ZoneType;
    priority: number;
    polygonCoordinates: Point2D[];
    version: number;
  }>;
}

/**
 * Pure geometric zone evaluation engine enforcing exclusion precedence
 * and full topological intersection semantics.
 */
export class ZoneEvaluator {
  /**
   * Evaluates a motion detection (point or bounding box) against a camera's configured zones.
   * Priority Rules:
   * 1. EXCLUSION takes precedence (if detection intersects any exclusion zone -> rejected).
   * 2. If INCLUSION zones exist -> detection MUST intersect at least one inclusion zone.
   * 3. If no INCLUSION zones exist and not excluded -> allowed by default (DEFAULT_ALLOW).
   */
  public static evaluateDetection(
    detection: Point2D | BoundingBox2D,
    zones: DetectionZone[]
  ): ZoneEvaluationResult {
    const enabledZones = zones.filter((z) => z.enabled);

    if (enabledZones.length === 0) {
      return { allowed: true, reason: 'DEFAULT_ALLOW' };
    }

    // Sort by priority descending (higher priority evaluated first)
    const sortedZones = [...enabledZones].sort((a, b) => b.priority - a.priority);

    const isInside = (polyCoords: any) => {
      const coords = Array.isArray(polyCoords) ? (polyCoords as Point2D[]) : [];
      if ('width' in detection && 'height' in detection) {
        return SpatialGeometry.intersectsPolygonBBox(coords, detection);
      }
      return SpatialGeometry.isPointInPolygon(detection as Point2D, coords);
    };

    // 1. Check EXCLUSION zones first
    const exclusionZones = sortedZones.filter((z) => z.type === ZoneType.EXCLUSION);
    for (const zone of exclusionZones) {
      if (isInside(zone.polygonCoordinates)) {
        return {
          allowed: false,
          reason: 'BLOCKED_BY_EXCLUSION',
          matchedZoneId: zone.id,
          matchedZoneName: zone.name,
        };
      }
    }

    // 2. Check INCLUSION zones
    const inclusionZones = sortedZones.filter((z) => z.type === ZoneType.INCLUSION);
    if (inclusionZones.length > 0) {
      for (const zone of inclusionZones) {
        if (isInside(zone.polygonCoordinates)) {
          return {
            allowed: true,
            reason: 'MATCHED_INCLUSION',
            matchedZoneId: zone.id,
            matchedZoneName: zone.name,
          };
        }
      }

      // Inside none of the active inclusion zones
      return {
        allowed: false,
        reason: 'OUTSIDE_INCLUSION_ZONES',
      };
    }

    // No inclusion zones configured, and not blocked by any exclusion zone
    return { allowed: true, reason: 'DEFAULT_ALLOW' };
  }

  /**
   * Produces an immutable zone configuration snapshot for forensic evidence integrity.
   */
  public static createZoneSnapshot(zones: DetectionZone[]): ZoneConfigSnapshot {
    return {
      snapshotTimestamp: new Date().toISOString(),
      zonesCount: zones.length,
      zones: zones.map((z) => ({
        id: z.id,
        name: z.name,
        type: z.type,
        priority: z.priority,
        polygonCoordinates: z.polygonCoordinates as unknown as Point2D[],
        version: z.version,
      })),
    };
  }
}
