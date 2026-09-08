import { DetectionZone, ZoneType } from '@prisma/client';
import DetectionZoneService, { Point2D, BoundingBox2D } from '../services/motion/detectionZone.service';

describe('DetectionZoneService - Decoupled Geometric Filtering & Snapshots', () => {
  describe('Ray-Casting Point-in-Polygon (PIP)', () => {
    // 1x1 Box: (0.1, 0.1) to (0.9, 0.9)
    const boxPolygon: Point2D[] = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
    ];

    it('should correctly identify points inside convex polygon', () => {
      expect(DetectionZoneService.isPointInPolygon({ x: 0.5, y: 0.5 }, boxPolygon)).toBe(true);
      expect(DetectionZoneService.isPointInPolygon({ x: 0.2, y: 0.2 }, boxPolygon)).toBe(true);
    });

    it('should correctly identify points outside convex polygon', () => {
      expect(DetectionZoneService.isPointInPolygon({ x: 0.05, y: 0.5 }, boxPolygon)).toBe(false);
      expect(DetectionZoneService.isPointInPolygon({ x: 0.95, y: 0.5 }, boxPolygon)).toBe(false);
    });

    it('should accurately handle concave (U-shaped) polygons', () => {
      // U-shaped polygon with a notch in the top middle
      const uShape: Point2D[] = [
        { x: 0.0, y: 0.0 },
        { x: 0.4, y: 0.0 },
        { x: 0.4, y: 0.6 }, // Notch start
        { x: 0.6, y: 0.6 },
        { x: 0.6, y: 0.0 }, // Notch end
        { x: 1.0, y: 0.0 },
        { x: 1.0, y: 1.0 },
        { x: 0.0, y: 1.0 },
      ];

      // Point in the left prong
      expect(DetectionZoneService.isPointInPolygon({ x: 0.2, y: 0.3 }, uShape)).toBe(true);
      // Point in the bottom bar
      expect(DetectionZoneService.isPointInPolygon({ x: 0.5, y: 0.8 }, uShape)).toBe(true);
      // Point inside the notch cutout (should be OUTSIDE!)
      expect(DetectionZoneService.isPointInPolygon({ x: 0.5, y: 0.3 }, uShape)).toBe(false);
    });
  });

  describe('Zone Priority & Filtering Rules (Exclusion Precedence)', () => {
    const inclusionZone: DetectionZone = {
      id: 'zone_inc_01',
      tenantId: 'tenant_01',
      cameraId: 'cam_01',
      name: 'Walkway',
      type: ZoneType.INCLUSION,
      priority: 1,
      enabled: true,
      polygonCoordinates: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ] as any,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const exclusionZone: DetectionZone = {
      id: 'zone_exc_01',
      tenantId: 'tenant_01',
      cameraId: 'cam_01',
      name: 'Swaying Tree Mask',
      type: ZoneType.EXCLUSION,
      priority: 10, // Higher priority
      enabled: true,
      polygonCoordinates: [
        { x: 0.6, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.5 },
        { x: 0.6, y: 0.5 },
      ] as any,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('should allow detection inside inclusion zone', () => {
      const point: Point2D = { x: 0.3, y: 0.3 };
      const result = DetectionZoneService.evaluateDetection(point, [inclusionZone]);

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('MATCHED_INCLUSION');
      expect(result.matchedZoneId).toBe('zone_inc_01');
    });

    it('should reject detection outside inclusion zone', () => {
      const point: Point2D = { x: 0.1, y: 0.1 };
      const result = DetectionZoneService.evaluateDetection(point, [inclusionZone]);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('OUTSIDE_INCLUSION_ZONES');
    });

    it('should BLOCK detection if it falls in EXCLUSION mask even when inside inclusion zone (Exclusion Priority Invariant)', () => {
      // Point (0.7, 0.3) is inside BOTH Walkway (Inclusion) AND Swaying Tree Mask (Exclusion)
      const point: Point2D = { x: 0.7, y: 0.3 };
      const result = DetectionZoneService.evaluateDetection(point, [inclusionZone, exclusionZone]);

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('BLOCKED_BY_EXCLUSION');
      expect(result.matchedZoneId).toBe('zone_exc_01');
    });

    it('should evaluate bounding-box detections against exclusion masks', () => {
      const bbox: BoundingBox2D = {
        x: 0.55,
        y: 0.25,
        width: 0.1,
        height: 0.1,
      }; // overlaps with exclusion zone (0.6, 0.2) to (0.8, 0.5)

      const result = DetectionZoneService.evaluateDetection(bbox, [inclusionZone, exclusionZone]);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('BLOCKED_BY_EXCLUSION');
    });
  });

  describe('Zone Configuration Snapshotting', () => {
    it('should generate an immutable snapshot for forensic evidence', () => {
      const zones: DetectionZone[] = [
        {
          id: 'zone_01',
          tenantId: 'tenant_01',
          cameraId: 'cam_01',
          name: 'Gate',
          type: ZoneType.INCLUSION,
          priority: 1,
          enabled: true,
          polygonCoordinates: [{ x: 0, y: 0 }, { x: 1, y: 1 }] as any,
          version: 2,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      const snapshot = DetectionZoneService.createZoneSnapshot(zones);

      expect(snapshot.zonesCount).toBe(1);
      expect(snapshot.zones[0].name).toBe('Gate');
      expect(snapshot.zones[0].version).toBe(2);
      expect(snapshot.snapshotTimestamp).toBeDefined();
    });
  });
});
