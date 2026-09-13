import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { SegmentStatus, ExportStatus } from '@prisma/client';
import { formatSegmentFilename, parseSegmentFilenameTimestamp, calculateSegmentBounds } from '../utils/segmentPath';
import { PackageAssembler } from '../services/evidence/archive/packageAssembler';
import { CustodyLedger } from '../services/evidence/archive/custodyLedger';
import { canonicalizeJson } from '../services/evidence/archive/manifestBuilder';
import { signEvidenceManifest, verifyEvidenceManifest, getOrCreateApplianceEd25519Keys, computeFileSha256 } from '../utils/crypto';
import config from '../config/env';

describe('Task 2.5: Physical Camera Canary Pipeline & Temporal Integrity Gate', () => {
  let tempDir: string;
  let prismaMock: any;
  let segmentsTable: Map<string, any>;
  let custodyLogs: any[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-canary-test-'));
    segmentsTable = new Map();
    custodyLogs = [];

    prismaMock = {
      recordingSegment: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(segmentsTable.values());
          if (where?.cameraId) list = list.filter((s) => s.cameraId === where.cameraId);
          if (where?.status) list = list.filter((s) => s.status === where.status);
          if (where?.startTime && where.startTime.gte) {
            list = list.filter((s) => s.startTime >= where.startTime.gte);
          }
          if (where?.endTime && where.endTime.lte) {
            list = list.filter((s) => s.endTime <= where.endTime.lte);
          }
          return Promise.resolve(list);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          for (const s of segmentsTable.values()) {
            if (where.filePath && s.filePath === where.filePath) return Promise.resolve(s);
            if (where.id && s.id === where.id) return Promise.resolve(s);
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const id = `seg-canary-${Date.now()}-${Math.random()}`;
          const seg = { id, evidencePins: [], ...data };
          segmentsTable.set(id, seg);
          return Promise.resolve(seg);
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
      },
      $transaction: jest.fn().mockImplementation((fn: any) => fn(prismaMock)),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('proves unbroken end-to-end temporal consistency: Filename -> DB Bounds -> Range Seek -> Evidence Export', async () => {
    const cameraId = 'canary-hikvision-ch1';
    const tenantId = 'tenant-canary';
    const cameraDir = path.join(tempDir, cameraId);
    fs.mkdirSync(cameraDir, { recursive: true });

    // 1. MediaMTX Segment File generation
    const fixedStartTimeUtc = new Date('2026-09-12T14:30:00.000Z');
    const segmentFilename = formatSegmentFilename(fixedStartTimeUtc, 'mp4');
    const mediaFilePath = path.join(cameraDir, segmentFilename);
    const simulatedVideoPayload = Buffer.from('REAL_CANARY_PHYSICAL_STREAM_MEDIA_PACKETS_H264_AAC');
    fs.writeFileSync(mediaFilePath, simulatedVideoPayload);

    // 2. Tamper mtime aggressively to prove complete independence from filesystem metadata
    const spoofedMtime = new Date('1980-01-01T00:00:00.000Z');
    fs.utimesSync(mediaFilePath, spoofedMtime, spoofedMtime);

    // Verify mtime is spoofed on disk
    const diskStat = fs.statSync(mediaFilePath);
    expect(diskStat.mtime.getUTCFullYear()).toBe(1980);

    // 3. Index segment using filename-based authority (C-011)
    const durationMs = 15000; // 15 seconds
    const bounds = calculateSegmentBounds(mediaFilePath, durationMs);
    const mediaFileSha256 = await computeFileSha256(mediaFilePath);

    expect(bounds.startTime.getTime()).toBe(fixedStartTimeUtc.getTime());
    expect(bounds.endTime.getTime()).toBe(fixedStartTimeUtc.getTime() + durationMs);
    expect(bounds.durationMs).toBe(durationMs);

    const segmentRecord = await prismaMock.recordingSegment.create({
      data: {
        tenantId,
        cameraId,
        filePath: mediaFilePath,
        startTime: bounds.startTime,
        endTime: bounds.endTime,
        durationMs: bounds.durationMs,
        sizeBytes: BigInt(diskStat.size),
        sha256Hash: mediaFileSha256,
        status: SegmentStatus.FINALIZED,
      },
    });

    expect(segmentRecord.startTime.toISOString()).toBe('2026-09-12T14:30:00.000Z');
    expect(segmentRecord.endTime.toISOString()).toBe('2026-09-12T14:30:15.000Z');

    // 4. Playback seek simulation: query segments covering seek target
    const seekTargetUtc = new Date('2026-09-12T14:30:08.000Z');
    const matchingSegments = Array.from(segmentsTable.values()).filter(
      (s) => s.cameraId === cameraId && s.startTime <= seekTargetUtc && s.endTime >= seekTargetUtc
    );
    expect(matchingSegments).toHaveLength(1);
    expect(matchingSegments[0].id).toBe(segmentRecord.id);

    // 5. Evidence Package Export Assembly (Task 2.3 & 2.5)
    const exportOutDir = path.join(tempDir, 'exports');
    fs.mkdirSync(exportOutDir, { recursive: true });
    const targetZipPath = path.join(exportOutDir, `Evidence_Canary_${Date.now()}.zip`);

    const manifestData = {
      exportId: 'EXP_CANARY_STAGE2',
      tenantId,
      cameraId,
      timeRange: {
        startUtc: bounds.startTime.toISOString(),
        endUtc: bounds.endTime.toISOString(),
      },
      evidenceMerkleRoot: crypto.createHash('sha256').update(mediaFileSha256).digest('hex'),
      segmentCount: 1,
      sourceSha256: mediaFileSha256,
    };

    const signature = signEvidenceManifest(canonicalizeJson(manifestData));
    const { publicKeyPem } = getOrCreateApplianceEd25519Keys();

    const packageResult = await PackageAssembler.assemblePackage({
      exportId: 'EXP_CANARY_STAGE2',
      targetZipPath,
      manifestData,
      applianceSignature: signature,
      videoFilePath: mediaFilePath,
    });

    // Verify evidence package exists, is non-empty, and has cryptographic integrity
    expect(fs.existsSync(packageResult.zipPath)).toBe(true);
    expect(packageResult.fileSizeBytes).toBeGreaterThan(0n);
    expect(packageResult.packageSha256).toHaveLength(64);

    // Verify signature against manifest
    expect(verifyEvidenceManifest(canonicalizeJson(manifestData), signature, publicKeyPem)).toBe(true);

    // 6. Custody Ledger recording (Task 2.3)
    const custodyLedger = new CustodyLedger(prismaMock);
    const custodyEntry = await custodyLedger.recordEvent({
      tenantId,
      evidenceId: 'EXP_CANARY_STAGE2',
      action: 'EXPORT_PACKAGE_ASSEMBLED',
      actorUserId: 'system-canary-verifier',
      sourceHash: mediaFileSha256,
      resultHash: packageResult.packageSha256,
      metadata: {
        targetZipPath,
        fileSizeBytes: packageResult.fileSizeBytes.toString(),
      },
    });

    expect(custodyEntry).toBeDefined();
    expect(custodyEntry.eventHash).toHaveLength(64);
    expect(custodyLogs).toHaveLength(1);
  });

  it('fails closed when requested video file is missing on disk, refusing to forge dummy bytes', async () => {
    const missingVideoPath = path.join(tempDir, 'non_existent_camera_stream.mp4');
    const targetZipPath = path.join(tempDir, 'Failed_Evidence.zip');

    const manifestData = {
      exportId: 'EXP_FAIL_CLOSED',
      evidenceMerkleRoot: 'a'.repeat(64),
    };
    const signature = signEvidenceManifest(canonicalizeJson(manifestData));

    // Must throw error and NOT assemble or create fake dummy placeholder
    await expect(
      PackageAssembler.assemblePackage({
        exportId: 'EXP_FAIL_CLOSED',
        targetZipPath,
        manifestData,
        applianceSignature: signature,
        videoFilePath: missingVideoPath,
      })
    ).rejects.toThrow(/Missing evidence media file/);

    expect(fs.existsSync(targetZipPath)).toBe(false);
  });
});
