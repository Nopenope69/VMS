import fs from 'fs';
import { PrismaClient, RedactionMode, RedactionJobStatus, Role } from '@prisma/client';
import { PrivacyPolicyService } from '../services/privacy/privacyPolicy.service';
import { VideoRedactorService } from '../services/privacy/videoRedactor.service';
import { ChainOfCustodyService } from '../services/evidence/chainOfCustody.service';

describe('Bucket 6: Privacy Policy Enforcement & Video Redaction', () => {
  let prisma: any;
  let chainOfCustody: any;
  let privacyService: PrivacyPolicyService;
  let redactorService: VideoRedactorService;

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

      expect(res.filterComplex).toContain('x=1900:y=1050:w=20:h=30');
    });
  });

  describe('Redaction Job Execution & Cryptographic Derivative Lineage', () => {
    it('executes redaction job; records derivative SHA-256 and preserves parent manifest hash', async () => {
      const parentMasterHash = 'master-sha256-root-112233';

      (prisma.redactionJob.findUnique as jest.Mock).mockResolvedValue({
        id: 'job-redact-99',
        tenantId: 'tenant-1',
        sourceManifestId: 'man-1',
        createdByUserId: 'user-op',
        redactionMode: RedactionMode.FACE,
        sourceManifest: {
          id: 'man-1',
          masterEvidenceHash: parentMasterHash,
        },
      });

      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      const readSpy = jest.spyOn(fs, 'createReadStream').mockReturnValue({
        on: (event: string, cb: any) => {
          if (event === 'data') {
            cb(Buffer.from('abc'));
          }
          if (event === 'end') {
            cb();
          }
          return this;
        },
      } as any);

      try {
        const completed = await redactorService.executeRedactionJob('job-redact-99');

        expect(completed.status).toBe(RedactionJobStatus.COMPLETED);
        expect(completed.outputObjectKey).toContain('job-redact-99.mp4');
        expect(completed.outputSha256).toBeDefined();

        expect(prisma.chainOfCustodyLog.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              action: 'EVIDENCE_REDACTED',
              sourceHash: parentMasterHash,
              resultHash: completed.outputSha256,
            }),
          })
        );
      } finally {
        existsSpy.mockRestore();
        readSpy.mockRestore();
      }
    });

    it('fails a redaction job when no output file is produced', async () => {
      const parentMasterHash = 'master-sha256-root-112233';

      (prisma.redactionJob.findUnique as jest.Mock).mockResolvedValue({
        id: 'job-redact-missing-output',
        tenantId: 'tenant-1',
        sourceManifestId: 'man-1',
        createdByUserId: 'user-op',
        redactionMode: RedactionMode.FACE,
        sourceManifest: {
          id: 'man-1',
          masterEvidenceHash: parentMasterHash,
        },
      });

      const existsSpy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);

      try {
        await expect(redactorService.executeRedactionJob('job-redact-missing-output')).rejects.toThrow(
          /Redaction output file was not produced/
        );

        expect(prisma.redactionJob.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 'job-redact-missing-output' },
            data: expect.objectContaining({
              status: RedactionJobStatus.FAILED,
            }),
          })
        );
      } finally {
        existsSpy.mockRestore();
      }
    });
  });
});
