import { PrismaClient } from '@prisma/client';
import { EvidenceManifestService } from '../services/evidence/evidenceManifest.service';
import { ChainOfCustodyService } from '../services/evidence/chainOfCustody.service';
import { RecordingIndexService } from '../services/recording/recordingIndex.service';

describe('Bucket 6: Evidence Integrity, Multi-Camera Manifest & Section 63 BSA Provenance', () => {
  let prisma: any;
  let recordingIndex: any;
  let chainOfCustody: ChainOfCustodyService;
  let manifestService: EvidenceManifestService;

  beforeEach(() => {
    const custodyLogs: any[] = [];

    prisma = {
      evidenceManifest: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'man-123', ...data })),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
      },
      evidenceExport: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'exp-999', ...data })),
      },
      chainOfCustodyLog: {
        create: jest.fn().mockImplementation(({ data }) => {
          const entry = { id: `custody-${custodyLogs.length + 1}`, ...data };
          custodyLogs.push(entry);
          return Promise.resolve(entry);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(custodyLogs)),
      },
    } as unknown as PrismaClient;

    recordingIndex = {
      findSegments: jest.fn(),
    } as unknown as RecordingIndexService;

    chainOfCustody = new ChainOfCustodyService(prisma);
    manifestService = new EvidenceManifestService(prisma, recordingIndex, chainOfCustody);
  });

  describe('Multi-Camera Evidence Manifest Creation & Section 63 BSA Metadata', () => {
    it('creates multi-camera manifest with deterministic master hash and Section 63 BSA disclaimer', async () => {
      const startUtc = new Date('2026-09-08T10:00:00.000Z');
      const endUtc = new Date('2026-09-08T10:05:00.000Z');

      (recordingIndex.findSegments as jest.Mock).mockImplementation((tenantId, camId) => {
        return Promise.resolve([
          {
            id: `seg-${camId}-1`,
            segmentUri: `/store/${camId}_01.mp4`,
            startUtc,
            endUtc,
          },
        ]);
      });

      const manifest = await manifestService.createManifest({
        tenantId: 'tenant-enterprise',
        createdByUserId: 'usr-investigator',
        cameraIds: ['cam-1', 'cam-2'],
        startUtc,
        endUtc,
        legalHold: true,
        partAPartyName: 'Chief Security Officer',
        partAPartyDesignation: 'System In-Charge',
      });

      expect(manifest.id).toBe('man-123');
      expect(manifest.masterEvidenceHash).toBeDefined();
      expect(manifest.legalHold).toBe(true);

      const certData = manifest.certificateDataJson as any;
      expect(certData.complianceFramework).toBe('BHARATIYA_SAKSHYA_ADHINIYAM_2023_SEC_63');
      // Verify strict invariant disclaimer
      expect(certData.disclaimer).toContain('Section 63 of the Bharatiya Sakshya Adhiniyam, 2023');
      expect(certData.disclaimer).toContain('does not warrant or guarantee statutory or judicial admissibility');
      expect(certData.applianceIdentifier).toContain('VIGILONE-EDGE');
      expect(certData.cameras.length).toBe(2);

      // Verify chain of custody logged root EVIDENCE_CREATED event
      expect(prisma.chainOfCustodyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'EVIDENCE_CREATED',
            sourceHash: manifest.masterEvidenceHash,
          }),
        })
      );
    });
  });

  describe('Evidence Integrity Invariant: Master Immutability & Derivative Lineage', () => {
    it('exports derivative clip without altering master evidence; links parent hash in custody log', async () => {
      const masterHash = 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890';

      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue({
        id: 'man-123',
        tenantId: 'tenant-1',
        startUtc: new Date('2026-09-08T10:00:00.000Z'),
        endUtc: new Date('2026-09-08T10:05:00.000Z'),
        masterEvidenceHash: masterHash,
      });

      const derivative = await manifestService.exportDerivativeClip({
        tenantId: 'tenant-1',
        manifestId: 'man-123',
        cameraId: 'cam-1',
        requestedById: 'usr-investigator',
        outputFilePath: '/export/derivative_cam1.mp4',
        outputSha256: 'derivative-sha256-hash-value',
      });

      expect(derivative.manifestId).toBe('man-123');
      expect(derivative.parentManifestId).toBe('man-123');
      expect(derivative.outputSha256).toBe('derivative-sha256-hash-value');

      // Verify custody logging links parent master hash to derivative hash
      expect(prisma.chainOfCustodyLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'EVIDENCE_EXPORTED',
            sourceHash: masterHash,
            resultHash: 'derivative-sha256-hash-value',
          }),
        })
      );
    });

    it('validates unbroken chain of custody ancestry across multiple derivative actions', async () => {
      const rootHash = 'root-sha256-abc';
      const derivHash = 'deriv-sha256-xyz';

      await chainOfCustody.logEvent({
        tenantId: 'tenant-1',
        evidenceId: 'man-123',
        actorUserId: 'user-1',
        action: 'EVIDENCE_CREATED',
        sourceHash: rootHash,
      });

      await chainOfCustody.logEvent({
        tenantId: 'tenant-1',
        evidenceId: 'man-123',
        actorUserId: 'user-2',
        action: 'EVIDENCE_REDACTED',
        sourceHash: rootHash,
        resultHash: derivHash,
      });

      await chainOfCustody.logEvent({
        tenantId: 'tenant-1',
        evidenceId: 'man-123',
        actorUserId: 'user-3',
        action: 'EVIDENCE_EXPORTED',
        sourceHash: derivHash,
      });

      const verification = await chainOfCustody.verifyCustodyChain('tenant-1', 'man-123');
      expect(verification.valid).toBe(true);
      expect(verification.unbrokenAncestry).toBe(true);
      expect(verification.entriesCount).toBe(3);
    });

    it('detects broken custody chain if an unverified source hash is introduced', async () => {
      const rootHash = 'root-sha256-abc';

      await chainOfCustody.logEvent({
        tenantId: 'tenant-1',
        evidenceId: 'man-123',
        actorUserId: 'user-1',
        action: 'EVIDENCE_CREATED',
        sourceHash: rootHash,
      });

      // Rogue action with unverified hash
      await chainOfCustody.logEvent({
        tenantId: 'tenant-1',
        evidenceId: 'man-123',
        actorUserId: 'user-attacker',
        action: 'EVIDENCE_TAMPERED',
        sourceHash: 'unrecognized-foreign-hash',
      });

      const verification = await chainOfCustody.verifyCustodyChain('tenant-1', 'man-123');
      expect(verification.valid).toBe(false);
      expect(verification.unbrokenAncestry).toBe(false);
      expect(verification.error).toContain('Chain broken');
    });
  });
});
