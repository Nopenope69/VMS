import fs from 'fs';
import path from 'path';
import os from 'os';
import { AuditChainService } from '../services/audit/auditChain.service';
import { CustodyLedger } from '../services/evidence/archive/custodyLedger';
import { RetentionPolicyEngine } from '../services/recording/catalog/retentionPolicy';
import { PackageAssembler } from '../services/evidence/archive/packageAssembler';
import { EvidenceArchive } from '../services/evidence/archive/evidenceArchive.service';
import config from '../config/env';

describe('Task 2.3: Fail-Closed Custody Ledger & Audit Chain (C-012)', () => {
  const originalExportsDir = config.EXPORTS_DIR;
  const testExportsDir = path.join(os.tmpdir(), `vigilone-exports-test-${Date.now()}`);

  beforeAll(() => {
    (config as any).EXPORTS_DIR = testExportsDir;
    fs.mkdirSync(testExportsDir, { recursive: true });
  });

  afterAll(() => {
    (config as any).EXPORTS_DIR = originalExportsDir;
    try {
      fs.rmSync(testExportsDir, { recursive: true, force: true });
    } catch {}
  });
  describe('AuditChainService Fail-Closed Invariant', () => {
    it('should throw and fail closed if advisory lock acquisition fails', async () => {
      const mockPrisma = {
        $transaction: jest.fn().mockImplementation(async (cb) => {
          const mockTx = {
            $executeRaw: jest.fn().mockRejectedValue(new Error('PostgreSQL advisory lock timeout: deadlocked')),
          };
          return cb(mockTx);
        }),
      };

      await expect(
        AuditChainService.record(mockPrisma as any, {
          tenantId: 'tenant_fail',
          action: 'TEST_ACTION',
          resourceType: 'Test',
          ipAddress: '127.0.0.1',
        })
      ).rejects.toThrow('PostgreSQL advisory lock timeout: deadlocked');
    });

    it('should throw and fail closed if auditEvent.create fails inside transaction', async () => {
      const mockPrisma = {
        $transaction: jest.fn().mockImplementation(async (cb) => {
          const mockTx = {
            $executeRaw: jest.fn().mockResolvedValue(1),
            auditEvent: {
              findFirst: jest.fn().mockResolvedValue(null),
              create: jest.fn().mockRejectedValue(new Error('Disk full: could not write audit entry')),
            },
          };
          return cb(mockTx);
        }),
      };

      await expect(
        AuditChainService.record(mockPrisma as any, {
          tenantId: 'tenant_fail',
          action: 'TEST_ACTION',
          resourceType: 'Test',
          ipAddress: '127.0.0.1',
        })
      ).rejects.toThrow('Disk full: could not write audit entry');
    });
  });

  describe('CustodyLedger Fail-Closed Invariant', () => {
    it('should throw and fail closed if custody advisory lock fails', async () => {
      const mockPrisma = {
        $transaction: jest.fn().mockImplementation(async (cb) => {
          const mockTx = {
            $executeRaw: jest.fn().mockRejectedValue(new Error('pg_advisory_xact_lock aborted by database')),
          };
          return cb(mockTx);
        }),
      };

      const ledger = new CustodyLedger(mockPrisma as any);

      await expect(
        ledger.recordEvent({
          tenantId: 'tenant_custody_fail',
          evidenceId: 'ev_123',
          actorUserId: 'usr_admin',
          action: 'SEAL',
          sourceHash: 'a'.repeat(64),
        })
      ).rejects.toThrow('pg_advisory_xact_lock aborted by database');
    });
  });

  describe('Retention Policy Fail-Closed Invariant', () => {
    it('should NOT delete media file on disk when database execution fails', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-retention-'));
      const testFilePath = path.join(tempDir, 'segment_to_preserve.mp4');
      fs.writeFileSync(testFilePath, 'precious footage that must not be deleted on db error');

      const mockPrisma = {
        $executeRaw: jest.fn().mockRejectedValue(new Error('DB Connection Dropped: Query Failed')),
      };
      const mockSegmentRepo = {
        deleteSegment: jest.fn(),
      };
      const mockPinRegistry = {
        isPinned: jest.fn().mockResolvedValue(false),
      };
      const mockStorageAdapter = {
        deleteFile: jest.fn().mockImplementation(async (p: string) => {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }),
      };

      const engine = new RetentionPolicyEngine(
        mockPrisma as any,
        mockSegmentRepo as any,
        mockPinRegistry as any,
        mockStorageAdapter as any
      );

      // Attempt deletion: DB fails -> must reject and NEVER delete disk file
      await expect(
        engine.atomicDeleteSegmentIfUnpinned('seg_123', testFilePath)
      ).rejects.toThrow('DB Connection Dropped: Query Failed');

      // Verify file still exists on disk!
      expect(fs.existsSync(testFilePath)).toBe(true);
      expect(mockStorageAdapter.deleteFile).not.toHaveBeenCalled();

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Evidence Export Fail-Closed (Anti-Fake Byte Principle)', () => {
    it('should throw NO_RECORDING_SEGMENTS_FOUND when 0 segments match export range', async () => {
      const mockPrisma = {
        camera: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'cam_1',
            streamPath: 'physical_gate_cam',
            ipAddress: '192.168.1.100',
            mainRtspUri: 'rtsp://192.168.1.100:554/live',
          }),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'admin_1',
            name: 'Security Head',
          }),
        },
        evidenceExport: {
          create: jest.fn().mockResolvedValue({
            id: 'export_job_1',
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      };

      const mockCatalog = {
        findSegments: jest.fn().mockResolvedValue([]),
      };
      const mockPinAdapter = {
        checkAdmissionControl: jest.fn().mockResolvedValue({ admitted: true }),
        acquireExportLease: jest.fn().mockResolvedValue(0),
        releaseExportLease: jest.fn().mockResolvedValue(0),
      };

      const service = new EvidenceArchive(
        mockPrisma as any,
        mockCatalog as any,
        undefined,
        mockPinAdapter as any
      );

      await expect(
        service.processExport({
          tenantId: 'tenant_1',
          cameraId: 'cam_1',
          startTime: new Date('2026-09-04T00:00:00Z'),
          endTime: new Date('2026-09-04T01:00:00Z'),
          requestedById: 'admin_1',
        })
      ).rejects.toThrow(/NO_RECORDING_SEGMENTS_FOUND/);
    });

    it('PackageAssembler should reject packaging when video file is missing on disk', async () => {
      await expect(
        PackageAssembler.assemblePackage({
          exportId: 'EV-FAIL-TEST',
          targetZipPath: '/tmp/test_export_missing_video.zip',
          videoFilePath: '/tmp/definitely_non_existent_file_987654.mp4',
          manifestData: { test: true },
          applianceSignature: 'dummy_sig',
        })
      ).rejects.toThrow(/Missing evidence media file/);
    });
  });
});
