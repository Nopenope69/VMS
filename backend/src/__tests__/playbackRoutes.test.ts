import http from 'http';
import fs from 'fs';
import path from 'path';
import express, { Express } from 'express';
import jwt from 'jsonwebtoken';
import axios, { AxiosInstance } from 'axios';
import config from '../config/env';

// Mock database before importing routes
const mockPrisma = {
  user: {
    findUnique: jest.fn(),
  },
  camera: {
    findFirst: jest.fn(),
  },
  recordingSegment: {
    findUnique: jest.fn(),
  },
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: mockPrisma,
}));

// Mock RecordingCatalog methods called by playback router
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
const mockFindSegments = jest.spyOn(RecordingCatalog.prototype, 'findSegments');
const mockGetCoverage = jest.spyOn(RecordingCatalog.prototype, 'getCoverage');

import playbackRoutes from '../routes/playback.routes';

describe('Phase 5: Playback Routes & Cross-Tenant Security Verification', () => {
  let app: Express;
  let server: http.Server;
  let client: AxiosInstance;
  let baseUrl: string;

  const testSegmentDir = path.join('/tmp', 'vigilone_test_playback');
  const testSegmentFileA = path.join(testSegmentDir, 'seg_tenant_a.mp4');
  const testSegmentFileB = path.join(testSegmentDir, 'seg_tenant_b.mp4');

  // Generate 1024 bytes of dummy media content
  const dummyMediaBytes = Buffer.alloc(1024);
  for (let i = 0; i < dummyMediaBytes.length; i++) {
    dummyMediaBytes[i] = i % 256;
  }

  const tokenTenantA = jwt.sign(
    { id: 'user-a-1', email: 'user-a@tenant-a.com', role: 'OPERATOR', type: 'ACCESS' },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenTenantB = jwt.sign(
    { id: 'user-b-1', email: 'user-b@tenant-b.com', role: 'OPERATOR', type: 'ACCESS' },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

  beforeAll((done) => {
    if (!fs.existsSync(testSegmentDir)) {
      fs.mkdirSync(testSegmentDir, { recursive: true });
    }
    fs.writeFileSync(testSegmentFileA, dummyMediaBytes);
    fs.writeFileSync(testSegmentFileB, dummyMediaBytes);

    app = express();
    app.use(express.json());
    app.use('/api/v1/playback', playbackRoutes);

    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}/api/v1/playback`;
      client = axios.create({ baseURL: baseUrl, validateStatus: () => true });
      done();
    });
  });

  afterAll((done) => {
    if (fs.existsSync(testSegmentFileA)) fs.unlinkSync(testSegmentFileA);
    if (fs.existsSync(testSegmentFileB)) fs.unlinkSync(testSegmentFileB);
    if (fs.existsSync(testSegmentDir)) fs.rmdirSync(testSegmentDir);
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Default user lookup mock
    mockPrisma.user.findUnique.mockImplementation(({ where }) => {
      if (where.id === 'user-a-1') {
        return Promise.resolve({
          id: 'user-a-1',
          email: 'user-a@tenant-a.com',
          role: 'OPERATOR',
          tenantId: 'tenant-a',
          active: true,
        });
      }
      if (where.id === 'user-b-1') {
        return Promise.resolve({
          id: 'user-b-1',
          email: 'user-b@tenant-b.com',
          role: 'OPERATOR',
          tenantId: 'tenant-b',
          active: true,
        });
      }
      return Promise.resolve(null);
    });
  });

  describe('GET /:cameraId/segments & GET /:cameraId/coverage', () => {
    it('returns segments with serialized BigInts and gap analysis for authorized tenant', async () => {
      mockPrisma.camera.findFirst.mockImplementation(({ where }) => {
        if (where.id === 'cam-a-1' && where.tenantId === 'tenant-a') {
          return Promise.resolve({ id: 'cam-a-1', tenantId: 'tenant-a', name: 'Front Entrance' });
        }
        return Promise.resolve(null);
      });

      mockFindSegments.mockResolvedValueOnce([
        {
          id: 'seg-1',
          cameraId: 'cam-a-1',
          filePath: '/data/seg1.mp4',
          startTime: new Date('2026-09-13T10:00:00Z'),
          endTime: new Date('2026-09-13T10:05:00Z'),
          durationMs: 300000,
          sizeBytes: BigInt(2048000),
          startPts: BigInt(0),
          endPts: BigInt(27000000),
          sha256Hash: 'hash-seg-1',
        } as any,
      ]);

      mockGetCoverage.mockResolvedValueOnce({
        blocks: [{ start: new Date('2026-09-13T10:00:00Z'), end: new Date('2026-09-13T10:05:00Z'), segmentCount: 1 }],
        gaps: [{ start: new Date('2026-09-13T10:05:00Z'), end: new Date('2026-09-13T10:10:00Z'), durationMs: 300000 }],
        totalRecordedMs: 300000,
      } as any);

      const res = await client.get('/cam-a-1/segments?start=2026-09-13T10:00:00Z&end=2026-09-13T10:15:00Z', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
      });

      expect(res.status).toBe(200);
      expect(res.data.segments).toHaveLength(1);
      expect(res.data.segments[0].sizeBytes).toBe('2048000');
      expect(res.data.segments[0].startPts).toBe('0');
      expect(res.data.segments[0].endPts).toBe('27000000');
      expect(res.data.gaps).toHaveLength(1);
    });

    it('returns 404 when querying camera belonging to a different tenant', async () => {
      mockPrisma.camera.findFirst.mockImplementation(({ where }) => {
        // Camera B belongs to tenant-b
        if (where.id === 'cam-b-1' && where.tenantId === 'tenant-b') {
          return Promise.resolve({ id: 'cam-b-1', tenantId: 'tenant-b', name: 'Vault Cam' });
        }
        return Promise.resolve(null);
      });

      // Tenant A operator attempts to access Tenant B's camera
      const res = await client.get('/cam-b-1/segments', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
      });

      expect(res.status).toBe(404);
      expect(res.data.error).toBe('Camera not found');
    });

    it('returns coverage report for authorized tenant and rejects missing parameters', async () => {
      mockPrisma.camera.findFirst.mockResolvedValueOnce({ id: 'cam-a-1', tenantId: 'tenant-a' });
      mockGetCoverage.mockResolvedValueOnce({
        blocks: [],
        gaps: [],
        totalRecordedMs: 0,
      } as any);

      const badRes = await client.get('/cam-a-1/coverage', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
      });
      expect(badRes.status).toBe(400);

      const goodRes = await client.get('/cam-a-1/coverage?start=2026-09-13T00:00:00Z&end=2026-09-13T12:00:00Z', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
      });
      expect(goodRes.status).toBe(200);
      expect(goodRes.data.totalRecordedMs).toBe(0);
    });
  });

  describe('GET /stream/:segmentId (Streaming & Byte Range Support)', () => {
    it('serves full fMP4 file with HTTP 200 and Content-Length when no Range requested', async () => {
      mockPrisma.recordingSegment.findUnique.mockResolvedValueOnce({
        id: 'seg-a-1',
        filePath: testSegmentFileA,
        camera: { tenantId: 'tenant-a' },
      });

      const res = await client.get('/stream/seg-a-1', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
        responseType: 'arraybuffer',
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['content-length']).toBe('1024');
      expect(Buffer.from(res.data).length).toBe(1024);
      expect(Buffer.from(res.data)).toEqual(dummyMediaBytes);
    });

    it('serves partial range with HTTP 206, Content-Range, and Accept-Ranges', async () => {
      mockPrisma.recordingSegment.findUnique.mockResolvedValueOnce({
        id: 'seg-a-1',
        filePath: testSegmentFileA,
        camera: { tenantId: 'tenant-a' },
      });

      const res = await client.get('/stream/seg-a-1', {
        headers: {
          Authorization: `Bearer ${tokenTenantA}`,
          Range: 'bytes=100-199',
        },
        responseType: 'arraybuffer',
      });

      expect(res.status).toBe(206);
      expect(res.headers['content-type']).toBe('video/mp4');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.headers['content-range']).toBe('bytes 100-199/1024');
      expect(res.headers['content-length']).toBe('100');

      const receivedBuf = Buffer.from(res.data);
      expect(receivedBuf.length).toBe(100);
      expect(receivedBuf).toEqual(dummyMediaBytes.subarray(100, 200));
    });

    it('enforces cross-tenant isolation: rejects stream request for segment of another tenant with 404', async () => {
      mockPrisma.recordingSegment.findUnique.mockResolvedValueOnce({
        id: 'seg-b-1',
        filePath: testSegmentFileB,
        camera: { tenantId: 'tenant-b' },
      });

      // Tenant A operator attempts to stream Tenant B segment
      const res = await client.get('/stream/seg-b-1', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
      });

      expect(res.status).toBe(404);
      expect(res.data.error).toBe('Segment not found');
    });

    it('returns 404 if segment file is missing on storage disk', async () => {
      mockPrisma.recordingSegment.findUnique.mockResolvedValueOnce({
        id: 'seg-missing',
        filePath: '/tmp/non_existent_file_path_12345.mp4',
        camera: { tenantId: 'tenant-a' },
      });

      const res = await client.get('/stream/seg-missing', {
        headers: { Authorization: `Bearer ${tokenTenantA}` },
      });

      expect(res.status).toBe(404);
      expect(res.data.error).toBe('Segment file missing on storage disk');
    });
  });
});
