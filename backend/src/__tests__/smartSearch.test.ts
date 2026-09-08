import { EventType, VehicleCategory } from '@prisma/client';
import { SmartSearchService } from '../services/search/smartSearch.service';

describe('SmartSearchService - Spatial Motion & Plate Forensics', () => {
  let service: SmartSearchService;
  let mockPrisma: any;
  let detectionEventsStore: any[] = [];
  let vehicleObservationsStore: any[] = [];

  beforeEach(() => {
    detectionEventsStore = [];
    vehicleObservationsStore = [];

    mockPrisma = {
      detectionEvent: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            detectionEventsStore.filter(
              (d) =>
                d.tenantId === where.tenantId &&
                d.cameraId === where.cameraId &&
                d.timestamp >= where.timestamp.gte &&
                d.timestamp <= where.timestamp.lte
            )
          );
        }),
      },
      vehicleObservation: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            vehicleObservationsStore.filter((v) => {
              if (v.tenantId !== where.tenantId) return false;
              if (where.stateCode && v.stateCode !== where.stateCode) return false;
              if (where.normalizedPlate?.contains && !v.normalizedPlate.includes(where.normalizedPlate.contains)) return false;
              return true;
            })
          );
        }),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    service = new SmartSearchService(mockPrisma);
  });

  describe('Geometric AABB & Centroid Logic', () => {
    it('detects intersecting and non-intersecting bounding boxes', () => {
      const box1 = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
      const box2 = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }; // Intersects
      const box3 = { x: 0.6, y: 0.6, width: 0.2, height: 0.2 }; // Disjoint

      expect(SmartSearchService.doesIntersect(box1, box2)).toBe(true);
      expect(SmartSearchService.doesIntersect(box1, box3)).toBe(false);
    });

    it('detects point inclusion within bounding box', () => {
      const box = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
      expect(SmartSearchService.isInside({ x: 0.3, y: 0.4 }, box)).toBe(true);
      expect(SmartSearchService.isInside({ x: 0.8, y: 0.9 }, box)).toBe(false);
    });
  });

  describe('Spatial Motion Forensics Query', () => {
    it('queries spatial ROI and returns clustered temporal intervals', async () => {
      const now = new Date();
      const t1 = new Date(now.getTime() - 60000);
      const t2 = new Date(now.getTime() - 45000);
      const t3 = new Date(now.getTime() - 10000);

      // Event 1: Inside ROI
      detectionEventsStore.push({
        id: 'evt_1',
        tenantId: 'tenant_01',
        cameraId: 'cam_01',
        timestamp: t1,
        confidence: 0.91,
        type: EventType.PERSON_DETECTED,
        boundingBox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
      });

      // Event 2: Inside ROI (close to event 1)
      detectionEventsStore.push({
        id: 'evt_2',
        tenantId: 'tenant_01',
        cameraId: 'cam_01',
        timestamp: t2,
        confidence: 0.95,
        type: EventType.PERSON_DETECTED,
        boundingBox: { x: 0.22, y: 0.22, width: 0.1, height: 0.1 },
      });

      // Event 3: Outside ROI
      detectionEventsStore.push({
        id: 'evt_3',
        tenantId: 'tenant_01',
        cameraId: 'cam_01',
        timestamp: t3,
        confidence: 0.88,
        type: EventType.PERSON_DETECTED,
        boundingBox: { x: 0.8, y: 0.8, width: 0.1, height: 0.1 },
      });

      const res = await service.searchSpatialMotion({
        tenantId: 'tenant_01',
        cameraId: 'cam_01',
        startTime: new Date(now.getTime() - 120000),
        endTime: now,
        boundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
      });

      expect(res.totalDetections).toBe(2); // Only evt_1 and evt_2 matched ROI
      expect(res.clusters).toHaveLength(1);
      expect(res.clusters[0].detectionCount).toBe(2);
      expect(res.clusters[0].peakConfidence).toBe(0.95);
    });
  });

  describe('Plate Forensic Search', () => {
    it('supports wildcard search and state code filtering', async () => {
      vehicleObservationsStore.push({
        id: 'obs_01',
        tenantId: 'tenant_01',
        plateNumber: 'DL01AB1234',
        normalizedPlate: 'DL01AB1234',
        stateCode: 'DL',
        vehicleCategory: VehicleCategory.FOUR_WHEELER,
        lastSeenAt: new Date(),
      });

      const res = await service.searchPlates({
        tenantId: 'tenant_01',
        plateQuery: 'DL*1234',
        stateCode: 'DL',
      });

      expect(res.observations).toHaveLength(1);
      expect(res.observations[0].normalizedPlate).toBe('DL01AB1234');
    });
  });
});
