import { requireInternalSecret } from '../routes/internal.routes';
import { DetectionIngestionService } from '../services/ai/detectionIngestion.service';
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

  // Ingestion validation, idempotency and provenance run against the real database in
  // aiPipelineRealDb.test.ts. The one case a real database cannot produce on demand stays here.
  describe('2. Unresolvable unique-constraint conflict', () => {
    it('does NOT report success when a P2002 conflict has no row for this inferenceId', async () => {
      const p2002: any = new Error('Unique constraint failed on some other constraint');
      p2002.code = 'P2002';
      const fakePrisma: any = {
        camera: { findFirst: jest.fn().mockResolvedValue({ id: 'cam-01', tenantId: 'tenant-1' }) },
        modelManifest: { findUnique: jest.fn().mockResolvedValue({ id: 'm-1', isActive: true, sha256: 'a'.repeat(64) }) },
        detectionEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockRejectedValue(p2002) },
      };
      const svc = new DetectionIngestionService(fakePrisma, () => ({} as any), { ingestEvent: jest.fn() } as any);
      await expect(
        svc.ingest({
          tenantId: 'tenant-1', cameraId: 'cam-01', modelManifestId: 'm-1', inferenceId: 'inf-orphan-001',
          type: 'VEHICLE_DETECTED', confidence: 0.92,
          provenance: {
            adapterId: 'a', adapterVersion: '1', modelId: 'm-1', modelName: 'n', modelVersion: '1', modelSha256: 'a'.repeat(64),
            runtime: 'onnxruntime', inferenceId: 'i', frameTimestampUtc: '2026-09-27T10:00:00.000Z',
          },
        })
      ).rejects.toMatchObject({ statusCode: 409, code: 'DETECTION_CONFLICT_UNRESOLVED' });
    });
  });
});
