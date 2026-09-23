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

  describe('FFmpeg Filter Expression Generation', () => {
    it('generates delogo expressions with temporal intervals for face / plate redactions', () => {
      const masks = [
        { x: 100, y: 150, width: 80, height: 80, startSec: 5, endSec: 12, label: 'face' },
        { x: 500, y: 600, width: 120, height: 40, startSec: 8, endSec: 15, label: 'plate' },
      ];

      const res = redactorService.generateFfmpegFilter(RedactionMode.FACE, masks, 1920, 1080);

      expect(res.totalMasks).toBe(2);
      expect(res.filterComplex).toContain("delogo=x=100:y=150:w=80:h=80:enable='between(t,5,12)'");
      expect(res.filterComplex).toContain("delogo=x=500:y=600:w=120:h=40:enable='between(t,8,15)'");
    });

    it('generates solid drawbox masks for static restricted privacy zones', () => {
      const masks = [
        { x: 0, y: 0, width: 400, height: 300, startSec: 0, endSec: 60, label: 'restricted_desk' },
      ];

      const res = redactorService.generateFfmpegFilter(RedactionMode.STATIC_MASK, masks, 1920, 1080);

      expect(res.filterComplex).toContain(
        "drawbox=x=0:y=0:w=400:h=300:color=black@1.0:t=fill:enable='between(t,0,60)'"
      );
    });

    it('clamps mask boundaries to video canvas dimensions', () => {
      const outOfBoundsMask = [
        { x: 1900, y: 1050, width: 100, height: 100, startSec: 1, endSec: 5 },
      ];

      const res = redactorService.generateFfmpegFilter(RedactionMode.FACE, outOfBoundsMask, 1920, 1080);

      // Width clamped so x + w <= 1920 (1900 + 20 = 1920); height clamped so y + h <= 1080 (1050 + 30 = 1080)
      expect(res.filterComplex).toContain('x=1900:y=1050:w=20:h=30');
    });
  });

  describe('Redaction Job Creation & Model Identity', () => {
    it('creates redaction job without injecting fake 1.2.0-yolo-cctv model identity', async () => {
      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue({
        id: 'manifest-1',
        masterEvidenceHash: 'hash-abc',
      });

      await redactorService.createRedactionJob({
        tenantId: 'tenant-1',
        createdByUserId: 'user-1',
        sourceManifestId: 'manifest-1',
        redactionMode: RedactionMode.FACE,
      });

      expect(prisma.redactionJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            modelVersion: undefined,
          }),
        })
      );
      const callData = (prisma.redactionJob.create as jest.Mock).mock.calls[0][0].data;
      expect(callData.modelVersion).not.toBe('1.2.0-yolo-cctv');
    });
  });

  describe('Redaction Job Execution & Cryptographic Derivative Lineage', () => {
    it('executes redaction job; records derivative SHA-256 and preserves parent manifest hash', async () => {
      const parentMasterHash = 'master-sha256-root-112233';
      const tenantId = 'tenant-1';
      const jobId = 'job-redact-99';

      const derivativesDir = path.join(tempExportsDir, 'derivatives', tenantId);
      fs.mkdirSync(derivativesDir, { recursive: true });
      const testFilePath = path.join(derivativesDir, `${jobId}.mp4`);
      const fileBytes = Buffer.from('mock-redacted-mp4-stream-content-42');
      fs.writeFileSync(testFilePath, fileBytes);

      const expectedSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');

      (prisma.redactionJob.findUnique as jest.Mock).mockResolvedValue({
        id: jobId,
        tenantId,
        sourceManifestId: 'man-1',
        createdByUserId: 'user-op',
        redactionMode: RedactionMode.FACE,
        sourceManifest: {
          id: 'man-1',
          masterEvidenceHash: parentMasterHash,
        },
      });

      const completed = await redactorService.executeRedactionJob(jobId);

      expect(completed.status).toBe(RedactionJobStatus.COMPLETED);
      expect(completed.outputObjectKey).toBe(`derivatives/${tenantId}/${jobId}.mp4`);
      expect(completed.outputSha256).toBe(expectedSha256);

      // Verify custodial log links master hash to authentic derivative hash
      expect(prisma.chainOfCustodyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'EVIDENCE_REDACTED',
            sourceHash: parentMasterHash,
            resultHash: expectedSha256,
          }),
        })
      );
    });

    it('fails and marks job FAILED if output file was not produced', async () => {
      const tenantId = 'tenant-fail';
      const jobId = 'job-missing-output';

      const missingFilePath = path.join(tempExportsDir, 'derivatives', tenantId, `${jobId}.mp4`);
      if (fs.existsSync(missingFilePath)) {
        fs.unlinkSync(missingFilePath);
      }

      (prisma.redactionJob.findUnique as jest.Mock).mockResolvedValue({
        id: jobId,
        tenantId,
        sourceManifestId: 'man-fail',
        createdByUserId: 'user-op',
        redactionMode: RedactionMode.FACE,
        sourceManifest: {
          id: 'man-fail',
          masterEvidenceHash: 'master-hash-fail',
        },
      });

      await expect(redactorService.executeRedactionJob(jobId)).rejects.toThrow(
        `Redaction output file was not produced: ${missingFilePath}`
      );

      // Verify job status updated to FAILED with meaningful error
      expect(prisma.redactionJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: jobId },
          data: expect.objectContaining({
            status: RedactionJobStatus.FAILED,
            error: `Redaction output file was not produced: ${missingFilePath}`,
          }),
        })
      );

      // Verify custodial log was NOT created for failed job
      expect(prisma.chainOfCustodyLog.create).not.toHaveBeenCalled();
    });

    it('verifies physical output bytes produce authentic SHA-256 in ChainOfCustodyLog', async () => {
      const parentMasterHash = 'master-sha256-verified-root-999';
      const tenantId = 'tenant-custody-check';
      const jobId = 'job-authentic-hash';

      const derivativesDir = path.join(tempExportsDir, 'derivatives', tenantId);
      fs.mkdirSync(derivativesDir, { recursive: true });
      const testFilePath = path.join(derivativesDir, `${jobId}.mp4`);

      // Distinct binary buffer representing physical video bytes
      const physicalVideoBytes = crypto.randomBytes(4096);
      fs.writeFileSync(testFilePath, physicalVideoBytes);

      // Independent authentic hash calculation
      const authenticExpectedSha256 = crypto
        .createHash('sha256')
        .update(physicalVideoBytes)
        .digest('hex');

      (prisma.redactionJob.findUnique as jest.Mock).mockResolvedValue({
        id: jobId,
        tenantId,
        sourceManifestId: 'man-custody',
        createdByUserId: 'user-forensics',
        redactionMode: RedactionMode.STATIC_MASK,
        sourceManifest: {
          id: 'man-custody',
          masterEvidenceHash: parentMasterHash,
        },
      });

      const completed = await redactorService.executeRedactionJob(jobId);

      // Authentic hash assertion
      expect(completed.outputSha256).toBe(authenticExpectedSha256);

      // Verify ChainOfCustodyLog recorded the authentic hash of the physical bytes
      expect(prisma.chainOfCustodyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId,
            evidenceId: 'man-custody',
            actorUserId: 'user-forensics',
            action: 'EVIDENCE_REDACTED',
            sourceHash: parentMasterHash,
            resultHash: authenticExpectedSha256,
            metadata: {
              redactionJobId: jobId,
              redactionMode: RedactionMode.STATIC_MASK,
              derivativeObjectKey: `derivatives/${tenantId}/${jobId}.mp4`,
              derivativeSha256: authenticExpectedSha256,
            },
          }),
        })
      );
    });
  });
});
