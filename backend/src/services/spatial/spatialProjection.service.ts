import { CameraSpatialPlacement } from '@prisma/client';
import {
  SpatialEngine,
  Point2D,
  FovConeGeometry,
  SpatialProjectedEvent,
  ProjectEventInput,
  CalibrationProfile,
} from './engine';

export {
  Point2D,
  FovConeGeometry,
  SpatialProjectedEvent,
  ProjectEventInput,
  CalibrationProfile,
};

/**
 * Backward-compatibility facade delegating directly to authoritative SpatialEngine facade.
 */
export class SpatialProjectionService {
  /**
   * Calculates dynamic 2D field-of-view (FOV) cone geometry for a camera on a floorplan.
   */
  public calculateFovCone(
    placement: CameraSpatialPlacement,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): FovConeGeometry {
    return SpatialEngine.calculateFovCone(
      placement,
      scalePixelsPerMeter,
      calibrationProfile
    );
  }

  /**
   * Tests whether a spatial point is contained within the camera's FOV vision cone.
   */
  public isPointInFov(
    placement: CameraSpatialPlacement,
    point: Point2D,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): boolean {
    return SpatialEngine.isPointInFov(
      placement,
      point,
      scalePixelsPerMeter,
      calibrationProfile
    );
  }

  /**
   * Projects a surveillance alarm or analytics detection onto floorplan space.
   */
  public projectEvent(
    placement: CameraSpatialPlacement,
    event: ProjectEventInput
  ): SpatialProjectedEvent {
    return SpatialEngine.projectEvent(placement, event);
  }
}

export default SpatialProjectionService;
