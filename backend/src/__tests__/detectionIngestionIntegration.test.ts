import { handleIngestDetection, requireInternalSecret } from '../routes/internal.routes';
import prisma from '../config/database';
import config from '../config/env';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    camera: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    modelManifest: {
      findUnique: jest.fn(),
    },
    detectionEvent: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

function createMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

describe('Detection Ingestion Integration & Database-Native Idempotency', () => {
  const originalEnv = { ...process.env };
  const originalSecret = config.INTERNAL_API_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    config.INTERNAL_API_SECRET = 'valid-test-internal-secret';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    config.INTERNAL_API_SECRET = originalSecret;
  });

  describe('1. Internal API Security Middleware', () => {
    it('rejects with 401 when Authorization header is missing', () => {
      const req: any = { headers: {} };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toMatch(/Internal secret required/);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects with 403 when Bearer token is invalid', () => {
      const req: any = { headers: { authorization: 'Bearer invalid-secret' } };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);
      expect(res.statusCode).toBe(403);
      expect(res.body.error).toMatch(/Invalid internal secret/);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts and passes through to next() when Bearer token matches INTERNAL_API_SECRET', () => {
      const req: any = { headers: { authorization: 'Bearer valid-test-internal-secret' } };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('2. Detection Ingestion Validation & Error Gating', () => {
    it('rejects with 400 when required fields are missing', async () => {
      const req: any = {
        body: { tenantId: 'tenant-1' }, // missing cameraId, modelManifestId, etc.
      };
      const res = createMockRes();

      await handleIngestDetection(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/Missing or invalid cameraId/);
    });

    it('returns 404 if camera does not exist or tenantId mismatches', async () => {
      (prisma.camera.findFirst as jest.Mock).mockResolvedValue(null);

      const req: any = {
        body: {
          tenantId: 'tenant-1',
          cameraId: 'cam-nonexistent',
          modelManifestId: 'manifest-01',
          inferenceId: 'inf-001',
          type: 'PERSON_DETECTED',
          confidence: 0.88,
        },
      };
      const res = createMockRes();

      await handleIngestDetection(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.body.error).toMatch(/Camera 'cam-nonexistent' not found/);
    });

    it('returns 400 if model manifest is inactive', async () => {
      (prisma.camera.findFirst as jest.Mock).mockResolvedValue({
        id: 'cam-01',
        tenantId: 'tenant-1',
      });
      (prisma.modelManifest.findUnique as jest.Mock).mockResolvedValue({
        id: 'manifest-inactive',
        isActive: false,
      });

      const req: any = {
        body: {
          tenantId: 'tenant-1',
          cameraId: 'cam-01',
          modelManifestId: 'manifest-inactive',
          inferenceId: 'inf-002',
          type: 'PERSON_DETECTED',
          confidence: 0.88,
        },
      };
      const res = createMockRes();

      await handleIngestDetection(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toMatch(/is inactive/);
    });
  });

  describe('3. Successful Ingestion & Database-Native Idempotency', () => {
    const mockCamera = { id: 'cam-01', tenantId: 'tenant-1' };
    const mockManifest = { id: 'manifest-01', name: 'vigilone-person-vehicle-detector', isActive: true };

    beforeEach(() => {
      (prisma.camera.findFirst as jest.Mock).mockResolvedValue(mockCamera);
      (prisma.modelManifest.findUnique as jest.Mock).mockResolvedValue(mockManifest);
    });

    it('ingests person and vehicle detection events with geometric bounding box', async () => {
      (prisma.detectionEvent.upsert as jest.Mock).mockResolvedValue({
        id: 'det-evt-001',
        inferenceId: 'inf-unique-001',
        type: 'PERSON_DETECTED',
        confidence: 0.89,
      });

      const req: any = {
        body: {
          tenantId: 'tenant-1',
          cameraId: 'cam-01',
          modelManifestId: 'manifest-01',
          inferenceId: 'inf-unique-001',
          type: 'PERSON_DETECTED',
          confidence: 0.89,
          boundingBox: { x: 0.15, y: 0.2, width: 0.25, height: 0.55 },
          centroid: { x: 0.275, y: 0.475 },
          timestamp: new Date().toISOString(),
        },
      };
      const res = createMockRes();

      await handleIngestDetection(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.detectionId).toBe('det-evt-001');
      expect(res.body.inferenceId).toBe('inf-unique-001');

      expect(prisma.detectionEvent.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { inferenceId: 'inf-unique-001' },
          update: {}, // Invariant: idempotent retry leaves record unmodified
          create: expect.objectContaining({
            tenantId: 'tenant-1',
            cameraId: 'cam-01',
            modelManifestId: 'manifest-01',
            inferenceId: 'inf-unique-001',
            type: 'PERSON_DETECTED',
            confidence: 0.89,
          }),
        })
      );
    });

    it('handles idempotent retries cleanly without mutating history or failing', async () => {
      const existingRecord = {
        id: 'det-evt-001',
        inferenceId: 'inf-duplicate-001',
        type: 'PERSON_DETECTED',
        confidence: 0.89,
      };

      (prisma.detectionEvent.upsert as jest.Mock).mockResolvedValue(existingRecord);

      const req: any = {
        body: {
          tenantId: 'tenant-1',
          cameraId: 'cam-01',
          modelManifestId: 'manifest-01',
          inferenceId: 'inf-duplicate-001',
          type: 'PERSON_DETECTED',
          confidence: 0.89,
        },
      };
      const res = createMockRes();

      // Submit duplicate detection with same inferenceId
      await handleIngestDetection(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.detectionId).toBe('det-evt-001');
      expect(res.body.inferenceId).toBe('inf-duplicate-001');
    });

    it('recovers gracefully from P2002 race condition on unique constraint', async () => {
      const p2002Error: any = new Error('Unique constraint failed on the constraint: `DetectionEvent_inferenceId_key`');
      p2002Error.code = 'P2002';

      (prisma.detectionEvent.upsert as jest.Mock).mockRejectedValue(p2002Error);
      (prisma.detectionEvent.findUnique as jest.Mock).mockResolvedValue({
        id: 'det-evt-race-winner',
        inferenceId: 'inf-race-001',
      });

      const req: any = {
        body: {
          tenantId: 'tenant-1',
          cameraId: 'cam-01',
          modelManifestId: 'manifest-01',
          inferenceId: 'inf-race-001',
          type: 'VEHICLE_DETECTED',
          confidence: 0.92,
        },
      };
      const res = createMockRes();

      await handleIngestDetection(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.detectionId).toBe('det-evt-race-winner');
      expect(res.body.inferenceId).toBe('inf-race-001');
    });
  });
});
