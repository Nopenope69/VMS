import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PrismaClient, ExportStatus } from '@prisma/client';
import {
  EvidenceArchive,
  MerkleTree,
  SegmentLeafInput,
  CustodyLedger,
  EvidencePinAdapter,
  BsaCertificatePackageBuilder,
  canonicalizeJson,
} from '../services/evidence/archive';
import {
  signEvidenceManifest,
  verifyEvidenceManifest,
  getOrCreateApplianceEd25519Keys,
} from '../utils/crypto';

describe('Authoritative EvidenceArchive Deep Module Tests', () => {
  let prisma: any;
  let mockRecordingCatalog: any;
  let archive: EvidenceArchive;
  let custodyLogs: any[];
  let evidencePins: any[];

  beforeEach(() => {
    custodyLogs = [];
    evidencePins = [];

    prisma = {
      evidenceManifest: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'man-uuid-1', ...data })
        ),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ id: where.id, ...data })
        ),
      },
      evidenceExport: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'exp-uuid-1', ...data })
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ id: where.id, ...data })
        ),
        findFirst: jest.fn(),
      },
      evidencePin: {
        create: jest.fn().mockImplementation(({ data }) => {
          const pin = { id: `pin-${evidencePins.length + 1}`, releasedAt: null, ...data };
          evidencePins.push(pin);
          return Promise.resolve(pin);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            evidencePins.filter((p) => {
              if (where?.segmentId?.in && !where.segmentId.in.includes(p.segmentId)) return false;
              if (where?.segmentId && where.segmentId !== p.segmentId) return false;
              if (where?.exportJobId && where.exportJobId !== p.exportJobId) return false;
              if (where?.releasedAt === null && p.releasedAt !== null) return false;
              return true;
            })
          );
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const p of evidencePins) {
            let match = true;
            if (where?.exportJobId && p.exportJobId !== where.exportJobId) match = false;
            if (where?.pinType && p.pinType !== where.pinType) match = false;
            if (where?.releasedAt === null && p.releasedAt !== null) match = false;
            if (match) {
              Object.assign(p, data);
              count++;
            }
          }
          return Promise.resolve({ count });
        }),
        count: jest.fn().mockImplementation(({ where }) => {
          const matches = evidencePins.filter((p) => {
            if (where?.segmentId && p.segmentId !== where.segmentId) return false;
            if (where?.releasedAt === null && p.releasedAt !== null) return false;
            return true;
          });
          return Promise.resolve(matches.length);
        }),
      },
      chainOfCustodyLog: {
        create: jest.fn().mockImplementation(({ data }) => {
          const entry = { id: `custody-${custodyLogs.length + 1}`, ...data };
          custodyLogs.push(entry);
          return Promise.resolve(entry);
        }),
        findFirst: jest.fn().mockImplementation(() => {
          if (custodyLogs.length === 0) return Promise.resolve(null);
          return Promise.resolve(custodyLogs[custodyLogs.length - 1]);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(custodyLogs)),
      },
      recordingSegment: {
        count: jest.fn().mockResolvedValue(100),
      },
      camera: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cam-alpha',
          name: 'Front Gate',
          model: 'VigilCam Pro',
          serialNumber: 'SN-98765',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'usr-analyst',
          name: 'Chief Analyst',
          email: 'analyst@vigilone.local',
        }),
      },
    } as unknown as PrismaClient;

    mockRecordingCatalog = {
      findSegments: jest.fn(),
      pinSegment: jest.fn().mockImplementation((tenantId, segmentId, exportJobId, reason, durationDays, pinType) => {
        const pin = {
          id: `pin-${evidencePins.length + 1}`,
          tenantId,
          segmentId,
          exportJobId,
          reason,
          durationDays,
          pinType: pinType || 'TEMPORARY_EXPORT',
          releasedAt: null,
          expiresAt: new Date(Date.now() + (durationDays || 365) * 86400000),
        };
        evidencePins.push(pin);
        return Promise.resolve(pin);
      }),
      releaseExportPins: jest.fn().mockImplementation((exportJobId) => {
        let count = 0;
        for (const p of evidencePins) {
          if (p.exportJobId === exportJobId && p.pinType === 'TEMPORARY_EXPORT' && p.releasedAt === null) {
            p.releasedAt = new Date();
            count++;
          }
        }
        return Promise.resolve(count);
      }),
      releaseLegalHoldPins: jest.fn().mockImplementation((tenantId, manifestId) => {
        let count = 0;
        for (const p of evidencePins) {
          if (p.exportJobId === manifestId && p.pinType === 'LEGAL_HOLD' && p.releasedAt === null) {
            p.releasedAt = new Date();
            count++;
          }
        }
        return Promise.resolve(count);
      }),
      isPinned: jest.fn().mockImplementation((segmentId) => {
        const now = new Date();
        const active = evidencePins.some(
          (p) => p.segmentId === segmentId && p.releasedAt === null && p.expiresAt > now
        );
        return Promise.resolve(active);
      }),
    };

    archive = new EvidenceArchive(prisma, mockRecordingCatalog);
  });

  describe('Mandatory Invariant 1: Canonical Merkle leaf encoding produces identical roots across runs', () => {
    it('computes identical binary length-prefixed leaf hashes and Merkle root deterministically', () => {
      const segA: SegmentLeafInput = {
        segmentId: 'seg-101',
        cameraId: 'cam-main',
        startTime: new Date('2026-09-08T08:00:00.000Z'),
        endTime: new Date('2026-09-08T08:05:00.000Z'),
        mediaSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      };

      const segB: SegmentLeafInput = {
        segmentId: 'seg-102',
        cameraId: 'cam-main',
        startTime: new Date('2026-09-08T08:05:00.000Z'),
        endTime: new Date('2026-09-08T08:10:00.000Z'),
        mediaSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      };

      const hash1 = MerkleTree.computeLeafHash(segA);
      const hash2 = MerkleTree.computeLeafHash(segA);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);

      // Run tree generation twice
      const tree1 = MerkleTree.buildTree([segA, segB]);
      const tree2 = MerkleTree.buildTree([segB, segA]); // Input order is sorted internally
      expect(tree1.rootHash).toBe(tree2.rootHash);
      expect(tree1.leafEntries).toHaveLength(2);
    });
  });

  describe('Mandatory Invariant 2: Odd-leaf duplication produces deterministic root and inclusion proof', () => {
    it('duplicates trailing odd node at each level and verifies standalone inclusion proof', () => {
      const leaves: SegmentLeafInput[] = [1, 2, 3].map((i) => ({
        segmentId: `seg-odd-${i}`,
        cameraId: 'cam-odd',
        startTime: new Date(`2026-09-08T09:0${i}:00.000Z`),
        endTime: new Date(`2026-09-08T09:0${i + 1}:00.000Z`),
        mediaSha256: crypto.createHash('sha256').update(`media-${i}`).digest('hex'),
      }));

      const { rootHash, levels, leafEntries } = MerkleTree.buildTree(leaves);
      expect(rootHash).toBeDefined();
      expect(levels.length).toBe(3); // Level 0: 3 leaves; Level 1: 2 nodes (left=0+1, right=2+2); Level 2: 1 root

      // Verify odd node 2 was combined with itself on Level 1
      const leaf2Hash = leafEntries[2].leafHash;
      const expectedDuplicatedParent = MerkleTree.combineNodes(leaf2Hash, leaf2Hash);
      expect(levels[1][1]).toBe(expectedDuplicatedParent);

      // Generate and verify proof for leaf 2 (odd leaf)
      const proof2 = MerkleTree.generateInclusionProof(levels, 2);
      const isValid = MerkleTree.verifyInclusionProof(leaf2Hash, proof2, rootHash);
      expect(isValid).toBe(true);

      // Tampered proof must fail
      const tamperedValid = MerkleTree.verifyInclusionProof('0'.repeat(64), proof2, rootHash);
      expect(tamperedValid).toBe(false);
    });
  });

  describe('Mandatory Invariant 3: Manifest signature verification fails on any field modification', () => {
    it('verifies Ed25519 appliance signature over canonical manifest JSON and detects tampering', () => {
      const canonicalManifest = {
        version: 1,
        applianceIdentifier: 'VIGILONE-EDGE-TENANT01',
        tenantId: 'tenant-01',
        timeRange: {
          startUtc: '2026-09-08T10:00:00.000Z',
          endUtc: '2026-09-08T10:10:00.000Z',
        },
        cameraIds: ['cam-1', 'cam-2'],
        evidenceMerkleRoot: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        leafCount: 2,
      };

      const canonicalString = canonicalizeJson(canonicalManifest);
      const signature = signEvidenceManifest(canonicalString);
      const { publicKeyPem } = getOrCreateApplianceEd25519Keys();

      // Legitimate verification succeeds
      expect(verifyEvidenceManifest(canonicalString, signature, publicKeyPem)).toBe(true);

      // Tampering 1: Modify cameraIds
      const tamperedObj1 = { ...canonicalManifest, cameraIds: ['cam-1', 'cam-3'] };
      expect(verifyEvidenceManifest(canonicalizeJson(tamperedObj1), signature, publicKeyPem)).toBe(false);

      // Tampering 2: Modify time range
      const tamperedObj2 = {
        ...canonicalManifest,
        timeRange: { ...canonicalManifest.timeRange, endUtc: '2026-09-08T10:11:00.000Z' },
      };
      expect(verifyEvidenceManifest(canonicalizeJson(tamperedObj2), signature, publicKeyPem)).toBe(false);

      // Tampering 3: Modify Merkle root
      const tamperedObj3 = { ...canonicalManifest, evidenceMerkleRoot: '0'.repeat(64) };
      expect(verifyEvidenceManifest(canonicalizeJson(tamperedObj3), signature, publicKeyPem)).toBe(false);
    });
  });

  describe('Mandatory Invariant 4: Export cancellation cannot release a legal-hold pin', () => {
    it('keeps segments protected under LEGAL_HOLD when an export lease is released or cancelled', async () => {
      const tenantId = 'tenant-secure';
      const segmentId = 'seg-critical-evidence';
      const manifestId = 'man-legal-hold-01';
      const exportJobId = 'exp-cancelled-job';

      // 1. Place Legal Hold pin on segment
      await archive.pinAdapter.pinForLegalHold(tenantId, [segmentId], manifestId, 'MURDER_INVESTIGATION_HOLD');

      // 2. Start an export job on the same segment (creating a temporary export pin)
      await archive.pinAdapter.acquireExportLease(tenantId, [segmentId], exportJobId, 'EVIDENCE_EXPORT');

      // Verify both pins exist
      expect(evidencePins).toHaveLength(2);
      expect(evidencePins.some((p) => p.pinType === 'LEGAL_HOLD')).toBe(true);
      expect(evidencePins.some((p) => p.pinType === 'TEMPORARY_EXPORT')).toBe(true);
      expect(await archive.isSegmentPinned(segmentId)).toBe(true);

      // 3. Export job is CANCELLED -> releases export lease
      const released = await archive.pinAdapter.releaseExportLease(exportJobId);
      expect(released).toBe(1);

      // 4. CRITICAL INVARIANT: The segment MUST STILL BE PINNED by the LEGAL_HOLD
      const stillPinned = await archive.isSegmentPinned(segmentId);
      expect(stillPinned).toBe(true);

      // Verify the LEGAL_HOLD pin remained unreleased
      const legalHoldPin = evidencePins.find((p) => p.pinType === 'LEGAL_HOLD');
      expect(legalHoldPin.releasedAt).toBeNull();

      // Only explicit legal hold release frees it
      await archive.pinAdapter.releaseLegalHold(tenantId, manifestId);
      expect(await archive.isSegmentPinned(segmentId)).toBe(false);
    });
  });

  describe('Mandatory Invariant 5: Section 63 BSA human certification cannot be auto-signed by appliance', () => {
    it('strictly isolates appliance provenance signature from Schedule Part A and Part B human declarations', () => {
      const certOptions = {
        evidenceId: 'ev-test-123',
        tenantId: 'tenant-delhi',
        applianceIdentifier: 'VIGILONE-EDGE-TENANT-D',
        applianceSignature: 'ED25519_SYSTEM_SIGNATURE_HEX_STRING',
        evidenceMerkleRoot: 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890',
        startUtc: new Date('2026-09-08T12:00:00Z'),
        endUtc: new Date('2026-09-08T12:30:00Z'),
        cameras: [
          {
            cameraId: 'cam-vault',
            name: 'Vault Entrance',
            segmentCount: 6,
          },
        ],
      };

      const certRecord = BsaCertificatePackageBuilder.buildCertificateData(certOptions);

      // Software labels signature strictly as machine provenance
      expect(certRecord.systemProvenanceNotice).toContain('appliance Ed25519 digital signature certifies the technical provenance');
      expect(certRecord.systemProvenanceNotice).toContain('Statutory Schedule Part A and Part B declarations require independent human execution');

      // Statutory disclaimer must emphasize machine non-tampering != human testimony
      expect(certRecord.disclaimer).toContain('certify machine-level non-tampering only and STRICTLY DO NOT substitute for statutory human certifications');
      expect(certRecord.disclaimer).toContain('does not warrant or guarantee statutory or judicial admissibility');
    });
  });

  describe('Contract Test 6: Dual-custody approval check', () => {
    it('rejects derivative export if requester attempts to self-approve when dual-approval is enforced', async () => {
      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue({
        id: 'man-1',
        startUtc: new Date('2026-09-08T10:00:00Z'),
        endUtc: new Date('2026-09-08T10:10:00Z'),
        evidenceMerkleRoot: 'root-hash-1',
      });

      await expect(
        archive.exportDerivativeClip({
          tenantId: 'tenant-1',
          manifestId: 'man-1',
          cameraId: 'cam-1',
          requestedById: 'usr-agent-smith',
          approvedByUserId: 'usr-agent-smith', // Self approval attempt
          outputFilePath: '/tmp/out.mp4',
        })
      ).rejects.toThrow('Dual-custody policy violation');
    });
  });

  describe('Contract Test 7: Tamper-evident custody hash chain', () => {
    it('detects tampering or unverified source hashes in the cryptographic hash chain', async () => {
      const ledger = archive.custodyLedger;
      const tenantId = 'tenant-test';
      const evidenceId = 'ev-custody-test';
      const rootHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

      // Genesis event
      await ledger.recordEvent({
        tenantId,
        evidenceId,
        actorUserId: 'usr-1',
        action: 'EVIDENCE_CREATED',
        sourceHash: rootHash,
      });

      // Legitimate derivative event
      const derivHash = crypto.createHash('sha256').update('deriv-media').digest('hex');
      await ledger.recordEvent({
        tenantId,
        evidenceId,
        actorUserId: 'usr-2',
        action: 'EVIDENCE_EXPORTED',
        sourceHash: rootHash,
        resultHash: derivHash,
      });

      const validVerification = await ledger.verifyChain(tenantId, evidenceId);
      expect(validVerification.valid).toBe(true);
      expect(validVerification.chainIntegrityValid).toBe(true);
      expect(validVerification.entriesCount).toBe(2);

      // Introduce event with unverified sourceHash
      await ledger.recordEvent({
        tenantId,
        evidenceId,
        actorUserId: 'usr-malicious',
        action: 'EVIDENCE_TAMPERED',
        sourceHash: 'fabricated-hash-without-provenance',
      });

      const tamperedVerification = await ledger.verifyChain(tenantId, evidenceId);
      expect(tamperedVerification.valid).toBe(false);
      expect(tamperedVerification.error).toContain('Chain broken');
    });
  });

  describe('Contract Test 8: Structured evidence export package assembly', () => {
    it('creates zip containing manifest.json, manifest.sha256, manifest.sig, and appliance public key', async () => {
      const outDir = '/tmp/vigilone_test_export_' + Date.now();
      fs.mkdirSync(outDir, { recursive: true });
      const targetZip = path.join(outDir, 'Evidence_TEST_01.zip');

      const manifestData = {
        exportId: 'TEST_01',
        evidenceMerkleRoot: 'a1b2c3d4e5f6',
        leafCount: 1,
      };
      const signature = signEvidenceManifest(canonicalizeJson(manifestData));

      try {
        const result = await archive.manifestBuilder; // manifestBuilder accessible
        const { PackageAssembler } = await import('../services/evidence/archive/packageAssembler');
        const pkgResult = await PackageAssembler.assemblePackage({
          exportId: 'TEST_01',
          targetZipPath: targetZip,
          manifestData,
          applianceSignature: signature,
        });

        expect(fs.existsSync(pkgResult.zipPath)).toBe(true);
        expect(pkgResult.fileSizeBytes).toBeGreaterThan(0n);
        expect(pkgResult.packageSha256).toHaveLength(64);
      } finally {
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {}
      }
    });
  });

  describe('Contract Test 9: Multi-camera manifest creation and verification', () => {
    it('creates manifest via facade and verifies cryptographic integrity', async () => {
      const startUtc = new Date('2026-09-08T14:00:00Z');
      const endUtc = new Date('2026-09-08T14:15:00Z');

      (mockRecordingCatalog.findSegments as jest.Mock).mockResolvedValue([
        {
          id: 'seg-cam1-1',
          cameraId: 'cam-1',
          startTime: startUtc,
          endTime: endUtc,
          sha256Hash: crypto.createHash('sha256').update('cam1-data').digest('hex'),
        },
      ]);

      const manifest = await archive.createManifest({
        tenantId: 'tenant-facade',
        createdByUserId: 'usr-admin',
        cameraIds: ['cam-1'],
        startUtc,
        endUtc,
        legalHold: true,
      });

      expect(manifest.id).toBe('man-uuid-1');
      expect(manifest.evidenceMerkleRoot).toBeDefined();
      expect(manifest.applianceSignature).toBeDefined();

      (prisma.evidenceManifest.findUnique as jest.Mock).mockResolvedValue(manifest);

      const verification = await archive.verifyManifestIntegrity(manifest.id);
      expect(verification.valid).toBe(true);
      expect(verification.signatureValid).toBe(true);
      expect(verification.matchedSegments).toBe(1);
    });
  });
});
