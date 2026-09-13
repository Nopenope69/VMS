import { Request, Response } from 'express';
import { JobStatus } from '@prisma/client';
import config from '../config/env';

// Mock prisma before importing internal.routes
const mockPrisma = {
  camera: {
    findFirst: jest.fn(),
  },
  segmentJob: {
    upsert: jest.fn(),
  },
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { requireInternalSecret, handleSegmentComplete } from '../routes/internal.routes';

function createMockResponse() {
  const res: any = {};
  res.statusCode = 200;
  res.status = jest.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn().mockImplementation((data: any) => {
    res.body = data;
    return res;
  });
  return res;
}

describe('Task 2.1: MediaMTX Webhook Ingestion & Timing-Safe Auth (C-005)', () => {
  const originalSecret = config.INTERNAL_API_SECRET;
  const testSecret = 'vigilone_super_secret_internal_key_test_123';

  beforeAll(() => {
    (config as any).INTERNAL_API_SECRET = testSecret;
  });

  afterAll(() => {
    (config as any).INTERNAL_API_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Timing-Safe Authentication Middleware', () => {
    it('should reject request missing Authorization header with 401 Unauthorized', () => {
      const req: any = { headers: {} };
      const res = createMockResponse();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.body.error).toContain('Internal secret required');
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject malformed Bearer authorization header with 401 Unauthorized', () => {
      const testCases = [
        'Basic 12345',
        'Bearer',
        'Bearer ',
        'Bearer a b c',
      ];

      for (const authHeader of testCases) {
        const req: any = { headers: { authorization: authHeader } };
        const res = createMockResponse();
        const next = jest.fn();

        requireInternalSecret(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
      }
    });

    it('should reject invalid secret with different byte length with 403 Forbidden', () => {
      const req: any = { headers: { authorization: 'Bearer wrong_secret_short' } };
      const res = createMockResponse();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body.error).toContain('Invalid internal secret');
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject invalid secret with same byte length with 403 Forbidden', () => {
      const sameLengthBadSecret = testSecret.slice(0, -1) + 'x';
      expect(sameLengthBadSecret.length).toBe(testSecret.length);

      const req: any = { headers: { authorization: `Bearer ${sameLengthBadSecret}` } };
      const res = createMockResponse();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body.error).toContain('Invalid internal secret');
      expect(next).not.toHaveBeenCalled();
    });

    it('should invoke next() when secret matches exactly', () => {
      const req: any = { headers: { authorization: `Bearer ${testSecret}` } };
      const res = createMockResponse();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('Webhook Payload Handling & Idempotency', () => {
    it('should return 400 Bad Request when path or file is missing in payload', async () => {
      const req1: any = { body: { file: '/recordings/gate1/seg1.mp4' } };
      const res1 = createMockResponse();
      await handleSegmentComplete(req1, res1);
      expect(res1.status).toHaveBeenCalledWith(400);
      expect(res1.body.error).toContain('Missing path or file');

      const req2: any = { body: { path: 'gate1' } };
      const res2 = createMockResponse();
      await handleSegmentComplete(req2, res2);
      expect(res2.status).toHaveBeenCalledWith(400);
      expect(res2.body.error).toContain('Missing path or file');
    });

    it('should return 404 Not Found when camera is unmapped', async () => {
      mockPrisma.camera.findFirst.mockResolvedValue(null);

      const req: any = { body: { path: 'unknown_cam', file: '/recordings/unknown/seg1.mp4' } };
      const res = createMockResponse();
      await handleSegmentComplete(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.body.error).toContain("Camera for streamPath 'unknown_cam' not found");
    });

    it('should accept valid webhook and idempotently upsert SegmentJob with JobStatus.PENDING', async () => {
      mockPrisma.camera.findFirst.mockResolvedValue({
        id: 'cam_123',
        tenantId: 'tenant_abc',
      });

      mockPrisma.segmentJob.upsert.mockResolvedValue({
        id: 'job_xyz_789',
        tenantId: 'tenant_abc',
        cameraId: 'cam_123',
        streamPath: 'gate1',
        segmentPath: '/recordings/gate1/2026-09-12_12-00-00-000000.mp4',
        status: JobStatus.PENDING,
      });

      const req: any = {
        body: {
          path: 'gate1',
          file: '/recordings/gate1/2026-09-12_12-00-00-000000.mp4',
        },
      };
      const res = createMockResponse();

      await handleSegmentComplete(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual({ queued: true, jobId: 'job_xyz_789' });

      expect(mockPrisma.segmentJob.upsert).toHaveBeenCalledWith({
        where: {
          tenantId_segmentPath: {
            tenantId: 'tenant_abc',
            segmentPath: '/recordings/gate1/2026-09-12_12-00-00-000000.mp4',
          },
        },
        update: {},
        create: {
          tenantId: 'tenant_abc',
          cameraId: 'cam_123',
          streamPath: 'gate1',
          segmentPath: '/recordings/gate1/2026-09-12_12-00-00-000000.mp4',
          status: JobStatus.PENDING,
        },
      });
    });
  });
});
