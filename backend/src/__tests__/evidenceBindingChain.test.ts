import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { ExportStatus } from '@prisma/client';
import {
  EvidenceArchive,
  MerkleTree,
  CustodyLedger,
  BsaCertificatePackageBuilder,
  canonicalizeJson,
} from '../services/evidence/archive';
import {
  verifyEvidenceManifest,
  computeFileSha256,
  getOrCreateApplianceEd25519Keys,
} from '../utils/crypto';

import config from '../config/env';

describe('Stage 5: Full Evidence Manifest Cryptographic Binding Chain (Section 3.3)', () => {
  const testOutputDir = path.join(__dirname, '..', '..', 'test_tmp_evidence_binding');
  let prismaMock: any;
  let recordingCatalogMock: any;
  let archive: EvidenceArchive;
  let custodyLogs: any[];
  let evidencePins: any[];

  beforeAll(() => {
    fs.mkdirSync(testOutputDir, { recursive: true });
    config.EXPORTS_DIR = path.join(testOutputDir, 'exports');
    config.RECORDINGS_DIR = testOutputDir;
    fs.mkdirSync(config.EXPORTS_DIR, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    custodyLogs = [];
    evidencePins = [];

    prismaMock = {
      camera: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cam-stage5-benchmark-01',
          name: 'Main Gate 4K Camera',
          manufacturer: 'Hikvision',
          model: 'DS-2CD2043G2-I (Bench Qualified)',
          serialNumber: 'HK-STG5-8829103',
          macAddress: '00:1A:2B:7C:8D:9E',
          ipAddress: '192.168.10.21',
          streamPath: 'hik_cam_01',
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'usr-legal-operator-01',
          name: 'Adv. Rajesh Sharma',
          email: 'r.sharma@enterprise-security.in',
          role: 'COMPLIANCE_OPERATOR',
        }),
      },
      evidenceExport: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'EXP_STAGE5_BINDING_001', ...data })
        ),
        update: jest.fn().mockImplementation(({ where, data }) =>
          Promise.resolve({ id: where.id, ...data })
        ),
      },
      evidencePin: {
        create: jest.fn().mockImplementation(({ data }) => {
          const pin = { id: `pin-${evidencePins.length + 1}`, releasedAt: null, ...data };
          evidencePins.push(pin);
          return Promise.resolve(pin);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve([])),
        updateMany: jest.fn().mockImplementation(() => Promise.resolve({ count: 1 })),
        count: jest.fn().mockImplementation(() => Promise.resolve(0)),
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
        findMany: jest.fn().mockImplementation(() => Promise.resolve([...custodyLogs])),
      },
      evidenceManifest: {
        findUnique: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };

    recordingCatalogMock = {
      findSegments: jest.fn(),
    };

    archive = new EvidenceArchive(prismaMock, recordingCatalogMock);
  });

  it('proves the unbroken 9-link cryptographic binding chain with derivation and artifact commitment', async () => {
    // 1. Prepare synthetic source segments representing recorded CCTV footage
    const seg1Path = path.join(testOutputDir, 'seg_001.mp4');
    const seg2Path = path.join(testOutputDir, 'seg_002.mp4');
    const seg1Content = Buffer.from('MOCK_H264_AVC_STREAM_PAYLOAD_SEGMENT_1_TIMESTAMP_1000');
    const seg2Content = Buffer.from('MOCK_H264_AVC_STREAM_PAYLOAD_SEGMENT_2_TIMESTAMP_2000');
    fs.writeFileSync(seg1Path, seg1Content);
    fs.writeFileSync(seg2Path, seg2Content);

    const seg1Sha = crypto.createHash('sha256').update(seg1Content).digest('hex');
    const seg2Sha = crypto.createHash('sha256').update(seg2Content).digest('hex');

    const startUtc = new Date('2026-09-13T10:00:00.000Z');
    const midUtc = new Date('2026-09-13T10:05:00.000Z');
    const endUtc = new Date('2026-09-13T10:10:00.000Z');

    const mockSegments = [
      {
        id: 'seg-uuid-001',
        cameraId: 'cam-stage5-benchmark-01',
        filePath: seg1Path,
        startTime: startUtc,
        endTime: midUtc,
        sha256Hash: seg1Sha,
      },
      {
        id: 'seg-uuid-002',
        cameraId: 'cam-stage5-benchmark-01',
        filePath: seg2Path,
        startTime: midUtc,
        endTime: endUtc,
        sha256Hash: seg2Sha,
      },
    ];
    recordingCatalogMock.findSegments.mockResolvedValue(mockSegments);

    // Mock FFmpeg concatenation to combine segments
    const { FFmpegService } = await import('../services/ffmpeg/ffmpeg.service');
    const originalConcat = FFmpegService.concatSegments;
    FFmpegService.concatSegments = jest.fn().mockImplementation(async (inputs, output) => {
      const combined = Buffer.concat(inputs.map((f: string) => fs.readFileSync(f)));
      fs.writeFileSync(output, combined);
    });

    // 2. Execute processExport
    const exportResultZip = await archive.processExport({
      tenantId: 'tenant-enterprise-hq',
      cameraId: 'cam-stage5-benchmark-01',
      requestedById: 'usr-legal-operator-01',
      startTime: startUtc,
      endTime: endUtc,
      exportMode: 'STREAM_COPY',
      partAPartyName: 'Adv. Rajesh Sharma',
      partAPartyDesignation: 'Authorised Legal Custodian',
      partBExpertName: 'Dr. Sunita Varma',
      partBExpertDesignation: 'Digital Forensics Examiner',
      partBExpertOrganization: 'National Forensic Sciences Laboratory',
    });

    expect(fs.existsSync(exportResultZip)).toBe(true);

    // Restore FFmpeg
    FFmpegService.concatSegments = originalConcat;

    // 3. Unpack evidence archive to an isolated directory for black-box verification
    const unpackDir = path.join(testOutputDir, 'unpacked_evidence');
    fs.mkdirSync(unpackDir, { recursive: true });
    execSync(`unzip -q -o "${exportResultZip}" -d "${unpackDir}"`);

    // Verify root files exist
    expect(fs.existsSync(path.join(unpackDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(unpackDir, 'manifest.sha256'))).toBe(true);
    expect(fs.existsSync(path.join(unpackDir, 'manifest.sig'))).toBe(true);
    expect(fs.existsSync(path.join(unpackDir, 'appliance_public_key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(unpackDir, 'video.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(unpackDir, 'chain_of_custody.json'))).toBe(true);
    expect(fs.existsSync(path.join(unpackDir, 'bsa-section-63', 'certificate_sec63.pdf'))).toBe(true);

    // 4. Invariant 1: manifest.sha256 matches actual hash of canonical manifest.json
    const manifestJsonRaw = fs.readFileSync(path.join(unpackDir, 'manifest.json'), 'utf8');
    const manifestJson = JSON.parse(manifestJsonRaw);
    const computedManifestSha256 = crypto.createHash('sha256').update(manifestJsonRaw).digest('hex');
    const recordedManifestSha256 = fs.readFileSync(path.join(unpackDir, 'manifest.sha256'), 'utf8').trim();
    expect(computedManifestSha256).toBe(recordedManifestSha256);

    // 5. Invariant 2: Ed25519 signature verification against appliance public key
    const recordedSig = fs.readFileSync(path.join(unpackDir, 'manifest.sig'), 'utf8').trim();
    const pubKeyPem = fs.readFileSync(path.join(unpackDir, 'appliance_public_key.pem'), 'utf8');
    const sigValid = verifyEvidenceManifest(canonicalizeJson(manifestJson), recordedSig, pubKeyPem);
    expect(sigValid).toBe(true);

    // 6. Invariant 3: Explicit Derivation Chain from Source Segments to video.mp4
    expect(manifestJson.sourceSegments).toHaveLength(2);
    expect(manifestJson.sourceSegments[0].segmentId).toBe('seg-uuid-001');
    expect(manifestJson.sourceSegments[0].sequenceIndex).toBe(0);
    expect(manifestJson.sourceSegments[0].mediaSha256).toBe(seg1Sha);
    expect(manifestJson.sourceSegments[1].segmentId).toBe('seg-uuid-002');
    expect(manifestJson.sourceSegments[1].sequenceIndex).toBe(1);
    expect(manifestJson.sourceSegments[1].mediaSha256).toBe(seg2Sha);

    // Verify Merkle inclusion proof for each source segment
    for (const seg of manifestJson.sourceSegments) {
      const proofValid = MerkleTree.verifyInclusionProof(
        seg.merkleLeafHash,
        seg.merkleProof,
        manifestJson.evidenceMerkleRoot
      );
      expect(proofValid).toBe(true);
    }

    // Verify Assembly Specification
    expect(manifestJson.assemblySpecification.derivationMode).toBe('STREAM_COPY');
    expect(manifestJson.assemblySpecification.concatTool).toBe('ffmpeg-v6.1');
    expect(manifestJson.assemblySpecification.derivationDescription).toContain('Byte-preserving');

    // 7. Invariant 4: Package-Wide Artifacts Table Commitments (Every artifact hashed and bound)
    expect(manifestJson.artifacts).toBeDefined();
    expect(manifestJson.artifacts.length).toBeGreaterThanOrEqual(4);

    for (const artifact of manifestJson.artifacts) {
      const artifactDiskPath = path.join(unpackDir, artifact.path);
      expect(fs.existsSync(artifactDiskPath)).toBe(true);
      const actualSize = fs.statSync(artifactDiskPath).size;
      const actualSha256 = await computeFileSha256(artifactDiskPath);
      expect(actualSize).toBe(artifact.byteLength);
      expect(actualSha256).toBe(artifact.sha256);
    }

    // 8. Invariant 5: Dual UTC & Local Timezone Representation
    expect(manifestJson.timeWindow.startUtc).toBe('2026-09-13T10:00:00.000Z');
    expect(manifestJson.timeWindow.endUtc).toBe('2026-09-13T10:10:00.000Z');
    expect(manifestJson.timeWindow.startLocal).toBeDefined();
    expect(manifestJson.timeWindow.endLocal).toBeDefined();
    expect(manifestJson.timeWindow.exportTimestampUtc).toBeDefined();
    expect(manifestJson.timeWindow.exportTimestampLocal).toBeDefined();
    expect(typeof manifestJson.timeWindow.timezoneOffsetMinutes).toBe('number');

    // 9. Invariant 6: Replayable, Unbroken Custody Chain
    const custodyHistoryRaw = fs.readFileSync(path.join(unpackDir, 'chain_of_custody.json'), 'utf8');
    const custodyHistory: any[] = JSON.parse(custodyHistoryRaw);
    expect(custodyHistory.length).toBeGreaterThanOrEqual(1);

    // Replay custody chain verification from genesis
    let previousHash = CustodyLedger.GENESIS_PREV_HASH;
    for (const event of custodyHistory) {
      expect(event.previousEventHash).toBe(previousHash);
      const payloadHash = CustodyLedger.computePayloadHash(
        event.sourceHash,
        event.resultHash,
        event.metadata
      );
      const expectedEventHash = CustodyLedger.computeEventHash({
        previousEventHash: event.previousEventHash,
        eventId: event.eventId,
        action: event.action,
        actorUserId: event.actorUserId,
        timestampUtcIso: new Date(event.timestampUtc).toISOString(),
        payloadHash,
      });
      expect(event.eventHash).toBe(expectedEventHash);
      previousHash = event.eventHash;
    }
    expect(manifestJson.custodySummary.headHash).toBe(previousHash);
    expect(manifestJson.custodySummary.unbrokenAncestry).toBe(true);

    // 10. Invariant 7: Section 63 BSA Technical Attestation & Non-Certifying Disclaimers
    expect(manifestJson.bsaSection63Details.disclaimer).toContain(
      'The system generates a cryptographically verifiable technical integrity attestation and chain-of-custody package'
    );
    expect(manifestJson.bsaSection63Details.disclaimer).toContain(
      'It does not certify legal admissibility or make a judicial determination regarding evidentiary acceptance'
    );
    expect(manifestJson.bsaSection63Details.disclaimer).toContain(
      'does not warrant or guarantee statutory or judicial admissibility'
    );
    expect(manifestJson.bsaSection63Details.provenanceNotice).toContain(
      'The appliance Ed25519 digital signature provides a technical attestation'
    );
    expect(manifestJson.bsaSection63Details.provenanceNotice).not.toContain(
      'certifies the technical provenance'
    );

    // 11. Tamper Resistance Validation: modifying ANY artifact invalidates manifest validation
    const tamperedCustodyPath = path.join(unpackDir, 'chain_of_custody.json');
    fs.appendFileSync(tamperedCustodyPath, ' '); // 1 byte whitespace alteration
    const tamperedCustodySha = await computeFileSha256(tamperedCustodyPath);
    const recordedCustodyEntry = manifestJson.artifacts.find(
      (a: any) => a.path === 'chain_of_custody.json'
    );
    expect(tamperedCustodySha).not.toBe(recordedCustodyEntry.sha256);
  });
});
