import { CameraSpatialPlacement, PrismaClient } from '@prisma/client';
import { FloorplanService } from '../services/spatial/floorplan.service';
import { SpatialProjectionService } from '../services/spatial/spatialProjection.service';

describe('Bucket 6: Indoor Spatial Maps, Camera Geometry & Live Alarm Projection', () => {
  let prisma: any;
  let projectionService: SpatialProjectionService;
  let floorplanService: FloorplanService;

  beforeEach(() => {
    prisma = {
      floorplan: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'fl-1', ...data })),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
        delete: jest.fn().mockResolvedValue({ id: 'fl-1' }),
      },
      camera: {
        findFirst: jest.fn(),
      },
      cameraSpatialPlacement: {
        upsert: jest.fn().mockImplementation(({ create, update }) => Promise.resolve({ id: 'place-1', ...create })),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({ id: 'place-1' }),
      },
      alarm: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    projectionService = new SpatialProjectionService();
    floorplanService = new FloorplanService(prisma, projectionService);
  });

  describe('Camera FOV Cone Geometry Calculation', () => {
    it('calculates 2D FOV cone pointing East (90 degrees navigational)', () => {
      const placement: CameraSpatialPlacement = {
        id: 'place-1',
        cameraId: 'cam-east',
        floorplanId: 'fl-1',
        x: 500,
        y: 500,
        mountHeightMeters: 4.0,
        headingDegrees: 90.0, // East
        pitchDegrees: 30.0,
        fovHorizontalDegrees: 80.0,
        fovVerticalDegrees: 50.0,
        zoom: 1.0,
        updatedAt: new Date(),
      };

      const cone = projectionService.calculateFovCone(placement, 20.0);

      expect(cone.origin).toEqual({ x: 500, y: 500 });
      expect(cone.headingDegrees).toBe(90.0);
      expect(cone.effectiveFovDegrees).toBe(80.0);
      expect(cone.rangePixels).toBeGreaterThan(50);

      // In SVG canvas, heading 90° points directly rightward (x increases, y stays ~500)
      expect(cone.centerVertex.x).toBeGreaterThan(500);
      expect(Math.abs(cone.centerVertex.y - 500)).toBeLessThan(1.0);
      expect(cone.svgPolygonPath).toContain('M 500.0 500.0');
    });

    it('narrows effective FOV angle when camera zoom increases', () => {
      const standardPlacement: CameraSpatialPlacement = {
        id: 'place-1',
        cameraId: 'cam-1',
        floorplanId: 'fl-1',
        x: 100,
        y: 100,
        mountHeightMeters: 3.0,
        headingDegrees: 0.0,
        pitchDegrees: 30.0,
        fovHorizontalDegrees: 90.0,
        fovVerticalDegrees: 50.0,
        zoom: 1.0,
        updatedAt: new Date(),
      };

      const zoomedPlacement: CameraSpatialPlacement = {
        ...standardPlacement,
        zoom: 3.0, // 3x optical zoom
      };

      const standardCone = projectionService.calculateFovCone(standardPlacement);
      const zoomedCone = projectionService.calculateFovCone(zoomedPlacement);

      expect(standardCone.effectiveFovDegrees).toBe(90.0);
      // 90 / 3 = 30°
      expect(zoomedCone.effectiveFovDegrees).toBe(30.0);
    });
  });

  describe('Point-in-FOV Angular & Spatial Containment', () => {
    const placement: CameraSpatialPlacement = {
      id: 'place-1',
      cameraId: 'cam-east',
      floorplanId: 'fl-1',
      x: 500,
      y: 500,
      mountHeightMeters: 4.0,
      headingDegrees: 90.0, // Points East (positive x)
      pitchDegrees: 30.0,
      fovHorizontalDegrees: 80.0,
      fovVerticalDegrees: 50.0,
      zoom: 1.0,
      updatedAt: new Date(),
    };

    it('returns true for point directly inside camera view cone', () => {
      // Point 50px East of camera
      const pointInside = { x: 550, y: 500 };
      expect(projectionService.isPointInFov(placement, pointInside)).toBe(true);
    });

    it('returns false for point behind the camera', () => {
      // Point 50px West of camera (behind)
      const pointBehind = { x: 450, y: 500 };
      expect(projectionService.isPointInFov(placement, pointBehind)).toBe(false);
    });

    it('returns false for point beyond the maximum camera reach', () => {
      // Point 2000px away
      const pointTooFar = { x: 2500, y: 500 };
      expect(projectionService.isPointInFov(placement, pointTooFar)).toBe(false);
    });
  });

  describe('Live Alarm Spatial Projection on Floorplan', () => {
    it('projects critical alarm onto floorplan with red pulse halo', () => {
      const placement: CameraSpatialPlacement = {
        id: 'place-1',
        cameraId: 'cam-door-1',
        floorplanId: 'fl-1',
        x: 300,
        y: 400,
        mountHeightMeters: 3.0,
        headingDegrees: 90.0,
        pitchDegrees: 30.0,
        fovHorizontalDegrees: 85.0,
        fovVerticalDegrees: 50.0,
        zoom: 1.0,
        updatedAt: new Date(),
      };

      const alarm = {
        id: 'alarm-intrusion-99',
        type: 'PERIMETER_BREACH',
        severity: 'CRITICAL',
        timestampUtc: new Date(),
      };

      const projected = projectionService.projectEvent(placement, alarm);

      expect(projected.eventId).toBe('alarm-intrusion-99');
      expect(projected.cameraId).toBe('cam-door-1');
      expect(projected.floorplanId).toBe('fl-1');
      expect(projected.haloColor).toBe('#EF4444'); // Red for CRITICAL
      expect(projected.pulseRadiusPixels).toBe(45);
      expect(projected.position.x).toBeGreaterThan(300);
    });
  });
});
