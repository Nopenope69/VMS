import http from 'http';
import fs from 'fs';
import path from 'path';
import express, { Express } from 'express';
import jwt from 'jsonwebtoken';
import axios, { AxiosInstance } from 'axios';
import config from '../config/env';

// Mock database before importing routes
const mockPrisma: any = {
  $transaction: jest.fn().mockImplementation((cb: any) => cb(mockPrisma)),
  $executeRaw: jest.fn().mockResolvedValue(1),
  user: {
    findUnique: jest.fn(),
  },
  camera: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  evidenceExport: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  auditEvent: {
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'audit-1', ...data })),
  },
};

jest.mock('../config/database', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { EvidenceArchive } from '../services/evidence/archive';
import { BsaCertificatePackageBuilder } from '../services/evidence/archive/bsaCertificatePackageBuilder';

const mockProcessExport = jest.spyOn(EvidenceArchive.prototype, 'processExport');

import evidenceRoutes from '../routes/evidence.routes';

describe('Phase 5: Evidence Routes & Section 63 BSA Cryptographic Export Verification', () => {
  let app: Express;
  let server: http.Server;
  let client: AxiosInstance;
  let baseUrl: string;

  const testOutputDir = path.join('/tmp', 'vigilone_test_evidence_routes');
  const testZipTenantA = path.join(testOutputDir, 'export_tenant_a_123.zip');
  const testZipTenantB = path.join(testOutputDir, 'export_tenant_b_456.zip');
  const testBsaPdfPath = path.join(testOutputDir, 'bsa_sec63_test.pdf');

  const tokenAdminA = jwt.sign(
    { id: 'admin-a-1', email: 'admin@tenant-a.com', role: 'SUPER_ADMIN', type: 'ACCESS' },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

  const tokenAdminB = jwt.sign(
    { id: 'admin-b-1', email: 'admin@tenant-b.com', role: 'SUPER_ADMIN', type: 'ACCESS' },
    config.JWT_SECRET,
    { expiresIn: '1h' }
  );

  beforeAll((done) => {
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }
    fs.writeFileSync(testZipTenantA, 'PK\x03\x04mock_zip_content_tenant_a');
    fs.writeFileSync(testZipTenantB, 'PK\x03\x04mock_zip_content_tenant_b');

    app = express();
    app.use(express.json());
    app.use('/api/v1/evidence', evidenceRoutes);

    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}/api/v1/evidence`;
      client = axios.create({ baseURL: baseUrl, validateStatus: () => true });
      done();
    });
  });

  afterAll((done) => {
    if (fs.existsSync(testZipTenantA)) fs.unlinkSync(testZipTenantA);
    if (fs.existsSync(testZipTenantB)) fs.unlinkSync(testZipTenantB);
    if (fs.existsSync(testBsaPdfPath)) fs.unlinkSync(testBsaPdfPath);
    if (fs.existsSync(testOutputDir)) fs.rmdirSync(testOutputDir);
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockPrisma.user.findUnique.mockImplementation(({ where }: any) => {
      if (where.id === 'admin-a-1') {
        return Promise.resolve({
          id: 'admin-a-1',
          name: 'Security Admin A',
          email: 'admin@tenant-a.com',
          role: 'SUPER_ADMIN',
          tenantId: 'tenant-a',
          active: true,
        });
      }
      if (where.id === 'admin-b-1') {
        return Promise.resolve({
          id: 'admin-b-1',
          name: 'Security Admin B',
          email: 'admin@tenant-b.com',
          role: 'SUPER_ADMIN',
          tenantId: 'tenant-b',
          active: true,
        });
      }
      return Promise.resolve(null);
    });
  });

  describe('POST /export (Section 63 BSA Evidence Package Generation)', () => {
    it('creates Section 63 BSA evidence export package for authorized camera and returns downloadUrl', async () => {
      mockPrisma.camera.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === 'cam-a-1' && where.tenantId === 'tenant-a') {
          return Promise.resolve({ id: 'cam-a-1', tenantId: 'tenant-a', name: 'Main Gate' });
        }
        return Promise.resolve(null);
      });

      mockProcessExport.mockResolvedValueOnce(testZipTenantA);

      const res = await client.post(
        '/export',
        {
          cameraId: 'cam-a-1',
          startTime: '2026-09-13T10:00:00Z',
          endTime: '2026-09-13T10:10:00Z',
          exportMode: 'STREAM_COPY',
          partAPartyName: 'Rajesh Kumar',
          partAPartyDesignation: 'Chief Security Officer',
          partBExpertName: 'Anil Verma',
          partBExpertDesignation: 'Digital Forensics Examiner',
        },
        { headers: { Authorization: `Bearer ${tokenAdminA}` } }
      );

      expect(res.status).toBe(201);
      expect(res.data.message).toBe('Section 63 BSA evidence package generated successfully');
      expect(res.data.downloadUrl).toBe('/api/v1/evidence/download/export_tenant_a_123.zip');
      expect(res.data.filename).toBe('export_tenant_a_123.zip');

      expect(mockProcessExport).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          cameraId: 'cam-a-1',
          requestedById: 'admin-a-1',
          partAPartyName: 'Rajesh Kumar',
        })
      );
    });

    it('enforces cross-tenant isolation: rejects export request for camera of another tenant with 404', async () => {
      mockPrisma.camera.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === 'cam-b-1' && where.tenantId === 'tenant-b') {
          return Promise.resolve({ id: 'cam-b-1', tenantId: 'tenant-b', name: 'Tenant B Camera' });
        }
        return Promise.resolve(null);
      });

      // Tenant A admin attempts to export Tenant B camera
      const res = await client.post(
        '/export',
        {
          cameraId: 'cam-b-1',
          startTime: '2026-09-13T10:00:00Z',
          endTime: '2026-09-13T10:10:00Z',
        },
        { headers: { Authorization: `Bearer ${tokenAdminA}` } }
      );

      expect(res.status).toBe(404);
      expect(res.data.error).toBe('Camera not found');
      expect(mockProcessExport).not.toHaveBeenCalled();
    });

    it('rejects export request with missing required parameters with 400', async () => {
      const res = await client.post(
        '/export',
        { cameraId: 'cam-a-1' }, // Missing startTime and endTime
        { headers: { Authorization: `Bearer ${tokenAdminA}` } }
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toContain('required');
    });
  });

  describe('GET /download/:filename', () => {
    it('downloads export package belonging to authenticated tenant', async () => {
      mockPrisma.evidenceExport.findFirst.mockImplementation(({ where }: any) => {
        const pathFilter = where.outputFilePath?.endsWith || where.outputFilePath;
        if (where.tenantId === 'tenant-a' && pathFilter === 'export_tenant_a_123.zip') {
          return Promise.resolve({
            id: 'exp-a-1',
            tenantId: 'tenant-a',
            outputFilePath: testZipTenantA,
          });
        }
        return Promise.resolve(null);
      });

      const res = await client.get('/download/export_tenant_a_123.zip', {
        headers: { Authorization: `Bearer ${tokenAdminA}` },
        responseType: 'arraybuffer',
      });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-disposition']).toContain('attachment; filename="export_tenant_a_123.zip"');
      expect(Buffer.from(res.data).toString()).toContain('mock_zip_content_tenant_a');
    });

    it('enforces cross-tenant isolation: rejects download of another tenant export package with 404', async () => {
      mockPrisma.evidenceExport.findFirst.mockImplementation(({ where }: any) => {
        const pathFilter = where.outputFilePath?.endsWith || where.outputFilePath;
        if (where.tenantId === 'tenant-b' && pathFilter === 'export_tenant_b_456.zip') {
          return Promise.resolve({
            id: 'exp-b-1',
            tenantId: 'tenant-b',
            outputFilePath: testZipTenantB,
          });
        }
        return Promise.resolve(null);
      });

      // Tenant A admin attempts to download Tenant B package
      const res = await client.get('/download/export_tenant_b_456.zip', {
        headers: { Authorization: `Bearer ${tokenAdminA}` },
      });

      expect(res.status).toBe(404);
      expect(res.data.error).toBe('Evidence package file not found');
    });

    it('rejects path traversal attempts with 400', async () => {
      const res = await client.get('/download/..%2F..%2Fetc%2Fpasswd', {
        headers: { Authorization: `Bearer ${tokenAdminA}` },
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid filename');
    });
  });

  describe('Real PDF Generation via BsaCertificatePackageBuilder (pdfkit)', () => {
    it('generates a genuine Section 63 BSA PDF certificate with valid PDF headers and structure', async () => {
      await BsaCertificatePackageBuilder.generatePdf(testBsaPdfPath, {
        evidenceId: 'EV-2026-TEST-001',
        tenantId: 'tenant-a',
        applianceIdentifier: 'APPLIANCE-HW-X86-01',
        applianceSignature: 'sig_ed25519_test_mock_1234567890',
        evidenceMerkleRoot: 'a69f73cca23a9ac5c8b567dc185a756e97a9fb34a80cbe4f50169792d13f9fb0',
        startUtc: new Date('2026-09-13T10:00:00Z'),
        endUtc: new Date('2026-09-13T10:15:00Z'),
        cameras: [
          {
            cameraId: 'cam-a-1',
            name: 'Perimeter North',
            model: 'DS-2CD2043G2',
            serialNumber: 'SN998124',
            segmentCount: 3,
            segmentHashes: ['hash1', 'hash2', 'hash3'],
          },
        ],
        partAPartyName: 'Rajesh Kumar',
        partAPartyDesignation: 'Chief Security Officer',
        partBExpertName: 'Anil Verma',
        partBExpertDesignation: 'Digital Forensics Examiner',
        partBExpertOrganization: 'Forensic IT Services',
      });

      expect(fs.existsSync(testBsaPdfPath)).toBe(true);
      const pdfBytes = fs.readFileSync(testBsaPdfPath);

      // Verify PDF magic header and trailer
      expect(pdfBytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
      expect(pdfBytes.length).toBeGreaterThan(1000);
      expect(pdfBytes.toString('latin1')).toContain('%%EOF');
    });
  });
});
