import { PrismaClient, RedactionMode, RedactionJobStatus, Role } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrivacyPolicyService } from '../services/privacy/privacyPolicy.service';
import { VideoRedactorService } from '../services/privacy/videoRedactor.service';
import { ChainOfCustodyService } from '../services/evidence/chainOfCustody.service';

describe('Bucket 6: Privacy Policy Enforcement & Video Redaction', () => {
  let prisma: any;
  let chainOfCustody: any;
  let privacyService: PrivacyPolicyService;
  let redactorService: VideoRedactorService;
  let tempExportsDir: string;
  const originalExportsDir = process.env.EXPORTS_DIR;

  beforeAll(() => {
    tempExportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-redact-test-'));
    process.env.EXPORTS_DIR = tempExportsDir;
  });

  afterAll(() => {
    process.env.EXPORTS_DIR = originalExportsDir;
    if (tempExportsDir && fs.existsSync(tempExportsDir)) {
      fs.rmSync(tempExportsDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    prisma = {
      privacyPolicy: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'pol-1', ...data })),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
        delete: jest.fn().mockResolvedValue({ id: 'pol-1' }),
      },
      evidenceManifest: {
        findUnique: jest.fn(),
      },
      dataProtectionSettings: {
        findUnique: jest.fn().mockResolvedValue({ tenantId: 'tenant-1', faceProcessingEnabled: true, plateRetentionDays: 30, detectionSnapshotRetentionDays: 30, allowedPurposes: [] }),
      },
      redactionJob: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'job-1', ...data })),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      },
      chainOfCustodyLog: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'custody-1', ...data })),
      },
    } as unknown as PrismaClient;

    chainOfCustody = new ChainOfCustodyService(prisma);
    privacyService = new PrivacyPolicyService(prisma);
    redactorService = new VideoRedactorService(prisma, chainOfCustody);
  });

  describe('Privacy Policy Evaluation & Dual-Custody Approval Check', () => {
    it('requires dual-custody approval when operator requests unredacted footage under restricted policy', () => {
      const policy: any = {
        id: 'pol-dpdp',
        tenantId: 'tenant-1',
        enabled: true,
        faceRedaction: true,
        approvalRequired: true,
        restrictedZonesJson: null,
      };

      // Operator requesting unredacted raw footage
      const evalResult = privacyService.evaluateExportCompliance(policy, Role.OPERATOR, false);

      expect(evalResult.compliant).toBe(false);
      expect(evalResult.requiresApproval).toBe(true);
      expect(evalResult.requiresRedaction).toBe(true);
      expect(evalResult.reason).toContain('dual-custody supervisory approval');
    });

    it('allows redacted exports without blocking on approval if redactions are applied', () => {
      const policy: any = {
        id: 'pol-dpdp',
        tenantId: 'tenant-1',
        enabled: true,
        faceRedaction: true,
        approvalRequired: true,
        restrictedZonesJson: null,
      };

      // Export is redacted
      const evalResult = privacyService.evaluateExportCompliance(policy, Role.OPERATOR, true);

      expect(evalResult.compliant).toBe(true);
      expect(evalResult.requiresApproval).toBe(false);
      expect(evalResult.requiresRedaction).toBe(false);
    });

    it('allows superadmin bypass of dual-custody approval requirement', () => {
      const policy: any = {
        id: 'pol-dpdp',
        tenantId: 'tenant-1',
        enabled: true,
        faceRedaction: false,
        approvalRequired: true,
        restrictedZonesJson: null,
      };

      const evalResult = privacyService.evaluateExportCompliance(policy, Role.SUPER_ADMIN, false);

      expect(evalResult.requiresApproval).toBe(false);
      expect(evalResult.compliant).toBe(true);
    });
  });

  describe('Redaction Job Creation & Model Identity', () => {
    it('creates redaction job without injecting any model identity (set only from detector provenance)', async () => {
      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue({
        id: 'manifest-1',
        tenantId: 'tenant-1',
        masterEvidenceHash: 'hash-abc',
        cameraIdsJson: ['cam-1'],
      });

      await redactorService.createRedactionJob({
        tenantId: 'tenant-1',
        createdByUserId: 'user-1',
        sourceManifestId: 'manifest-1',
        redactionMode: RedactionMode.FACE,
      });

      const callData = (prisma.redactionJob.create as jest.Mock).mock.calls[0][0].data;
      expect(callData.modelVersion).toBeUndefined();
      expect(callData).toMatchObject({ cameraId: 'cam-1', detectKinds: ['FACE'], sampleFps: 4, status: RedactionJobStatus.QUEUED });
    });

    it('refuses a manifest of another tenant, an unsupported mode and an ambiguous camera', async () => {
      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue({ id: 'm', tenantId: 'other', cameraIdsJson: ['a'] });
      await expect(redactorService.createRedactionJob({ tenantId: 't', createdByUserId: 'u', sourceManifestId: 'm', redactionMode: RedactionMode.FACE })).rejects.toThrow(/REDACTION_SOURCE_NOT_FOUND/);
      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue({ id: 'm', tenantId: 't', cameraIdsJson: ['a', 'b'] });
      await expect(redactorService.createRedactionJob({ tenantId: 't', createdByUserId: 'u', sourceManifestId: 'm', redactionMode: RedactionMode.BYSTANDER })).rejects.toThrow(/REDACTION_MODE_UNSUPPORTED/);
      await expect(redactorService.createRedactionJob({ tenantId: 't', createdByUserId: 'u', sourceManifestId: 'm', redactionMode: RedactionMode.FACE })).rejects.toThrow(/REDACTION_CAMERA_REQUIRED/);
      await expect(redactorService.createRedactionJob({ tenantId: 't', createdByUserId: 'u', sourceManifestId: 'm', redactionMode: RedactionMode.STATIC_MASK, cameraId: 'a' })).rejects.toThrow(/nothing to redact/);
      expect(prisma.redactionJob.create).not.toHaveBeenCalled();
    });
  });

  // Execution (real ffmpeg, real files, real DB, including the job that must fail when no output
  // file is produced) is covered in redactionRealDb.test.ts.
});
