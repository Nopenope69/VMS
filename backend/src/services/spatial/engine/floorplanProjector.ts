import { Point2D } from './geometry';

export interface SpatialProjectedEvent {
  eventId: string;
  cameraId: string;
  floorplanId: string;
  type: string;
  severity: string;
  position: Point2D;
  pulseRadiusPixels: number;
  haloColor: string;
  timestampUtc: Date;
  metadata?: any;
}

export interface ProjectEventInput {
  id: string;
  type: string;
  severity?: string;
  timestampUtc?: Date;
  metadata?: any;
}

export interface CameraPlacementReference {
  x: number;
  y: number;
  cameraId: string;
  floorplanId: string;
  headingDegrees: number;
}

/**
 * Floorplan projection engine for surveillance alarms and analytics detections.
 */
export class FloorplanProjector {
  /**
   * Projects a surveillance alarm or analytics detection onto floorplan space.
   */
  public static projectEvent(
    placement: CameraPlacementReference,
    event: ProjectEventInput
  ): SpatialProjectedEvent {
    const severity = event.severity || 'WARNING';

    let haloColor = '#F59E0B'; // Amber default
    if (severity === 'CRITICAL') haloColor = '#EF4444'; // Red
    else if (severity === 'INFO') haloColor = '#06B6D4'; // Cyan

    // Compute event epicenter (projected mid-cone if no relative coordinates provided)
    const headingRad = ((placement.headingDegrees - 90) * Math.PI) / 180;
    const offsetPixels = 40;

    const position: Point2D = {
      x: placement.x + offsetPixels * Math.cos(headingRad),
      y: placement.y + offsetPixels * Math.sin(headingRad),
    };

    return {
      eventId: event.id,
      cameraId: placement.cameraId,
      floorplanId: placement.floorplanId,
      type: event.type,
      severity,
      position,
      pulseRadiusPixels: severity === 'CRITICAL' ? 45 : 30,
      haloColor,
      timestampUtc: event.timestampUtc || new Date(),
      metadata: event.metadata,
    };
  }
}
