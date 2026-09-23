import { Request, Response } from 'express';
import { handleGetInternalCameras, requireInternalSecret } from '../routes/internal.routes';
import prisma from '../config/database';
import config from '../config/env';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    camera: {
      findMany: jest.fn(),
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

describe('Internal Camera Discovery & Privacy Redaction Boundary', () => {
  const originalSecret = config.INTERNAL_API_SECRET;

  beforeAll(() => {
    (config as any).INTERNAL_API_SECRET = 'test-internal-secret-xyz-123';
  });

  afterAll(() => {
    (config as any).INTERNAL_API_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Security: requireInternalSecret Authorization Guard', () => {
    it('returns 401 if Authorization header is missing', () => {
      const req: any = { headers: {} };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 if Authorization header does not start with Bearer', () => {
      const req: any = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(res.statusCode).toBe(401);
      expect(res.body.error).toContain('Unauthorized');
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 if Bearer token does not match INTERNAL_API_SECRET', () => {
      const req: any = { headers: { authorization: 'Bearer wrong-secret' } };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toContain('Forbidden');
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when valid Bearer secret is supplied', () => {
      const req: any = { headers: { authorization: 'Bearer test-internal-secret-xyz-123' } };
      const res = createMockRes();
      const next = jest.fn();

      requireInternalSecret(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('2. Privacy & Data Minimization Invariant (Zero Credential Leakage)', () => {
    it('returns only safe camera metadata and never leaks IPs, credentials, or external RTSP URIs', async () => {
      const mockCamerasInDb = [
        {
          id: 'cam-uuid-1',
          tenantId: 'tenant-alpha',
          name: 'Gate 1 North Entrance',
          streamPath: 'cam_gate1_north',
          isOnline: true,
          // DB fields that MUST NOT be selected or returned
          ipAddress: '192.168.1.100',
          encryptedAuth: 'aes256gcm_encrypted_creds_here',
          mainRtspUri: 'rtsp://admin:secret123@192.168.1.100:554/h264',
          subRtspUri: 'rtsp://admin:secret123@192.168.1.100:554/sub',
          onvifPort: 80,
          rtspPort: 554,
        },
      ];

      (prisma.camera.findMany as jest.Mock).mockImplementation((args: any) => {
        // Enforce that Prisma was called with specific safe field projections
        expect(args.select).toEqual({
          id: true,
          tenantId: true,
          name: true,
          streamPath: true,
          isOnline: true,
        });

        // Return only the projected fields as Prisma would
        return Promise.resolve([
          {
            id: mockCamerasInDb[0].id,
            tenantId: mockCamerasInDb[0].tenantId,
            name: mockCamerasInDb[0].name,
            streamPath: mockCamerasInDb[0].streamPath,
            isOnline: mockCamerasInDb[0].isOnline,
          },
        ]);
      });

      const req: any = { query: {} };
      const res = createMockRes();

      await handleGetInternalCameras(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.cameras).toHaveLength(1);
      const returnedCam = res.body.cameras[0];

      // Safe fields present
      expect(returnedCam.id).toBe('cam-uuid-1');
      expect(returnedCam.tenantId).toBe('tenant-alpha');
      expect(returnedCam.name).toBe('Gate 1 North Entrance');
      expect(returnedCam.streamPath).toBe('cam_gate1_north');
      expect(returnedCam.isOnline).toBe(true);

      // SENSITIVE FIELDS STRICTLY FORBIDDEN
      expect((returnedCam as any).ipAddress).toBeUndefined();
      expect((returnedCam as any).encryptedAuth).toBeUndefined();
      expect((returnedCam as any).mainRtspUri).toBeUndefined();
      expect((returnedCam as any).subRtspUri).toBeUndefined();
      expect((returnedCam as any).password).toBeUndefined();
      expect((returnedCam as any).username).toBeUndefined();
    });

    it('filters cameras by tenantId and isOnline query parameters', async () => {
      (prisma.camera.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'cam-uuid-2',
          tenantId: 'tenant-beta',
          name: 'Perimeter West',
          streamPath: 'cam_perim_west',
          isOnline: true,
        },
      ]);

      const req: any = {
        query: {
          tenantId: 'tenant-beta',
          isOnline: 'true',
        },
      };
      const res = createMockRes();

      await handleGetInternalCameras(req, res);

      expect(res.statusCode).toBe(200);
      expect(prisma.camera.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-beta',
          isOnline: true,
        },
        select: {
          id: true,
          tenantId: true,
          name: true,
          streamPath: true,
          isOnline: true,
        },
        orderBy: { name: 'asc' },
      });
      expect(res.body.cameras).toHaveLength(1);
    });

    it('handles database errors gracefully and returns 500', async () => {
      (prisma.camera.findMany as jest.Mock).mockRejectedValue(new Error('DB connection failed'));

      const req: any = { query: {} };
      const res = createMockRes();

      await handleGetInternalCameras(req, res);

      expect(res.statusCode).toBe(500);
      expect(res.body.error).toContain('Failed to retrieve internal cameras');
    });
  });
});
