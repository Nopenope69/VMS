export interface Point2D {
  x: number;
  y: number;
}

export interface BoundingBox2D {
  x: number; // Top-left x [0..1] or pixel coordinates
  y: number; // Top-left y [0..1] or pixel coordinates
  width: number;
  height: number;
}

export type Polygon2D = Point2D[];

export type LineSide = 'SIDE_A' | 'SIDE_B' | 'ON_LINE';

export interface CalibrationProfile {
  cameraModel?: string;
  calibratedFovDegrees?: number;
  zoomMap?: Record<number, number>; // Maps zoom level -> effective FOV degrees
}

export interface FovConeGeometry {
  origin: Point2D;
  centerVertex: Point2D;
  leftVertex: Point2D;
  rightVertex: Point2D;
  arcPoints: Point2D[];
  rangePixels: number;
  headingDegrees: number;
  effectiveFovDegrees: number;
  svgPolygonPath: string;
}

export interface CameraPlacementParams {
  x: number;
  y: number;
  mountHeightMeters: number;
  headingDegrees: number;
  pitchDegrees: number;
  fovHorizontalDegrees: number;
  fovVerticalDegrees?: number;
  zoom?: number | null;
}

/**
 * Pure 2D Computational Geometry primitives for SpatialEngine.
 */
export class SpatialGeometry {
  /**
   * Ray-Casting algorithm for point-in-polygon (PIP).
   * Robust against convex, concave, and self-intersecting polygons.
   */
  public static isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    if (!polygon || polygon.length < 3) return false;

    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x;
      const yi = polygon[i].y;
      const xj = polygon[j].x;
      const yj = polygon[j].y;

      const intersect =
        yi > point.y !== yj > point.y &&
        point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;

      if (intersect) inside = !inside;
    }

    return inside;
  }

  /**
   * Tests if the center point of a bounding box is inside a polygon.
   */
  public static isBBoxCenterInPolygon(bbox: BoundingBox2D, polygon: Point2D[]): boolean {
    const center: Point2D = {
      x: bbox.x + bbox.width / 2,
      y: bbox.y + bbox.height / 2,
    };
    return this.isPointInPolygon(center, polygon);
  }

  /**
   * Tests if a bounding box is entirely contained within a polygon (all 4 corners inside).
   */
  public static isBBoxContainedInPolygon(bbox: BoundingBox2D, polygon: Point2D[]): boolean {
    const corners: Point2D[] = [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
      { x: bbox.x, y: bbox.y + bbox.height },
    ];
    return corners.every((c) => this.isPointInPolygon(c, polygon));
  }

  /**
   * Tests if two line segments (p1-p2 and q1-q2) intersect.
   */
  public static segmentsIntersect(p1: Point2D, p2: Point2D, q1: Point2D, q2: Point2D): boolean {
    // Helper to compute 2D orientation cross-product
    const ccw = (a: Point2D, b: Point2D, c: Point2D): number => {
      return (c.y - a.y) * (b.x - a.x) - (c.x - a.x) * (b.y - a.y);
    };

    // Helper to check if point c lies on segment a-b when collinear
    const onSegment = (a: Point2D, b: Point2D, c: Point2D): boolean => {
      return (
        c.x >= Math.min(a.x, b.x) &&
        c.x <= Math.max(a.x, b.x) &&
        c.y >= Math.min(a.y, b.y) &&
        c.y <= Math.max(a.y, b.y)
      );
    };

    const d1 = ccw(p1, p2, q1);
    const d2 = ccw(p1, p2, q2);
    const d3 = ccw(q1, q2, p1);
    const d4 = ccw(q1, q2, p2);

    // General case: segments straddle each other
    if (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    ) {
      return true;
    }

    // Special collinear cases
    const eps = 1e-9;
    if (Math.abs(d1) < eps && onSegment(p1, p2, q1)) return true;
    if (Math.abs(d2) < eps && onSegment(p1, p2, q2)) return true;
    if (Math.abs(d3) < eps && onSegment(q1, q2, p1)) return true;
    if (Math.abs(d4) < eps && onSegment(q1, q2, p2)) return true;

    return false;
  }

  /**
   * Complete topological polygon vs. bounding box intersection (ADR 0003 & Mandatory Correction 2).
   * Returns true if:
   * 1. Any bbox corner is inside the polygon, OR
   * 2. Any polygon vertex is inside the bbox, OR
   * 3. Any polygon edge intersects any bbox edge.
   */
  public static intersectsPolygonBBox(polygon: Point2D[], bbox: BoundingBox2D): boolean {
    if (!polygon || polygon.length < 3) return false;

    const bboxCorners: Point2D[] = [
      { x: bbox.x, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y },
      { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
      { x: bbox.x, y: bbox.y + bbox.height },
    ];

    // 1. Check if any bbox corner is inside polygon
    for (const corner of bboxCorners) {
      if (this.isPointInPolygon(corner, polygon)) {
        return true;
      }
    }

    // 2. Check if any polygon vertex is inside the bbox AABB
    for (const vertex of polygon) {
      if (this.isPointInAABB(vertex, bbox)) {
        return true;
      }
    }

    // 3. Check if any polygon edge intersects any bbox edge
    const bboxEdges: [Point2D, Point2D][] = [
      [bboxCorners[0], bboxCorners[1]], // Top edge
      [bboxCorners[1], bboxCorners[2]], // Right edge
      [bboxCorners[2], bboxCorners[3]], // Bottom edge
      [bboxCorners[3], bboxCorners[0]], // Left edge
    ];

    const n = polygon.length;
    for (let i = 0; i < n; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];

      for (const [b1, b2] of bboxEdges) {
        if (this.segmentsIntersect(p1, p2, b1, b2)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Determines which side of a directed line segment (pointA -> pointB) a point lies on.
   * Employs 3-state hysteresis with an epsilon buffer [-epsilon, +epsilon] (Correction 3).
   * Cross product: (Bx - Ax)(Py - Ay) - (By - Ay)(Px - Ax)
   */
  public static computeLineSide(
    pointA: Point2D,
    pointB: Point2D,
    point: Point2D,
    epsilon: number = 0.005
  ): LineSide {
    const crossProduct =
      (pointB.x - pointA.x) * (point.y - pointA.y) -
      (pointB.y - pointA.y) * (point.x - pointA.x);

    if (crossProduct > epsilon) return 'SIDE_A';
    if (crossProduct < -epsilon) return 'SIDE_B';
    return 'ON_LINE';
  }

  /**
   * Axis-Aligned Bounding Box (AABB) intersection.
   */
  public static doesAABBIntersect(a: BoundingBox2D, b: BoundingBox2D): boolean {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  /**
   * Evaluates if a point is inside an Axis-Aligned Bounding Box (AABB).
   */
  public static isPointInAABB(point: Point2D, box: BoundingBox2D): boolean {
    return (
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    );
  }

  /**
   * Calculates dynamic 2D field-of-view (FOV) cone geometry for a camera on a floorplan.
   * Supports calibrated PTZ FOV lookup with optical zoom fallback (Correction 5).
   */
  public static calculateFovCone(
    placement: CameraPlacementParams,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): FovConeGeometry {
    const zoom = Math.max(0.1, placement.zoom || 1.0);

    // Calibrated PTZ profile lookup with fallback
    let effectiveFovDegrees: number;
    if (
      calibrationProfile?.zoomMap &&
      calibrationProfile.zoomMap[zoom] !== undefined
    ) {
      effectiveFovDegrees = calibrationProfile.zoomMap[zoom];
    } else if (calibrationProfile?.calibratedFovDegrees !== undefined) {
      effectiveFovDegrees = Math.min(
        180,
        Math.max(10, calibrationProfile.calibratedFovDegrees / zoom)
      );
    } else {
      effectiveFovDegrees = Math.min(
        180,
        Math.max(10, placement.fovHorizontalDegrees / zoom)
      );
    }

    const halfFovRad = (effectiveFovDegrees / 2) * (Math.PI / 180);

    // Ground projection range based on mount height and pitch angle
    const pitchRad =
      (Math.max(10, Math.min(85, placement.pitchDegrees)) * Math.PI) / 180;
    const groundDistanceMeters = Math.min(
      50,
      Math.max(5, placement.mountHeightMeters / Math.tan(pitchRad))
    );
    const rangePixels =
      groundDistanceMeters *
      scalePixelsPerMeter *
      Math.min(2.5, Math.max(0.8, zoom));

    // Convert heading from standard navigational (0° = North, 90° = East) to mathematical polar coordinates
    const headingRad = ((placement.headingDegrees - 90) * Math.PI) / 180;

    const origin: Point2D = { x: placement.x, y: placement.y };

    const leftAngle = headingRad - halfFovRad;
    const rightAngle = headingRad + halfFovRad;

    const leftVertex: Point2D = {
      x: origin.x + rangePixels * Math.cos(leftAngle),
      y: origin.y + rangePixels * Math.sin(leftAngle),
    };

    const rightVertex: Point2D = {
      x: origin.x + rangePixels * Math.cos(rightAngle),
      y: origin.y + rangePixels * Math.sin(rightAngle),
    };

    const centerVertex: Point2D = {
      x: origin.x + rangePixels * Math.cos(headingRad),
      y: origin.y + rangePixels * Math.sin(headingRad),
    };

    // Interpolate arc points for smooth polygon drawing
    const arcPoints: Point2D[] = [];
    const segments = 8;
    for (let i = 0; i <= segments; i++) {
      const stepAngle = leftAngle + (rightAngle - leftAngle) * (i / segments);
      arcPoints.push({
        x: origin.x + rangePixels * Math.cos(stepAngle),
        y: origin.y + rangePixels * Math.sin(stepAngle),
      });
    }

    // Build SVG path string: M origin L firstArcPoint A arc ... Z
    const pathParts = [`M ${origin.x.toFixed(1)} ${origin.y.toFixed(1)}`];
    for (const pt of arcPoints) {
      pathParts.push(`L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`);
    }
    pathParts.push('Z');
    const svgPolygonPath = pathParts.join(' ');

    return {
      origin,
      centerVertex,
      leftVertex,
      rightVertex,
      arcPoints,
      rangePixels,
      headingDegrees: placement.headingDegrees,
      effectiveFovDegrees,
      svgPolygonPath,
    };
  }

  /**
   * Tests whether a spatial point is contained within the camera's FOV vision cone.
   */
  public static isPointInFov(
    placement: CameraPlacementParams,
    point: Point2D,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): boolean {
    const dx = point.x - placement.x;
    const dy = point.y - placement.y;
    const distance = Math.hypot(dx, dy);

    const fovGeometry = this.calculateFovCone(
      placement,
      scalePixelsPerMeter,
      calibrationProfile
    );
    if (distance > fovGeometry.rangePixels || distance < 1) {
      return false;
    }

    // Angle from camera origin to point
    const pointAngleRad = Math.atan2(dy, dx);
    const headingRad = ((placement.headingDegrees - 90) * Math.PI) / 180;

    // Angular difference normalized to [-PI, PI]
    let diff = pointAngleRad - headingRad;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    while (diff > Math.PI) diff -= 2 * Math.PI;

    const halfFovRad = (fovGeometry.effectiveFovDegrees / 2) * (Math.PI / 180);
    return Math.abs(diff) <= halfFovRad;
  }
}
