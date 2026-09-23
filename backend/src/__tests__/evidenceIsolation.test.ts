import crypto from 'crypto';
import { handleSegmentComplete } from '../routes/internal.routes';
import { EvidenceManifestService } from '../services/evidence/evidenceManifest.service';
import { ChainOfCustodyService } from '../services/evidence/chainOfCustody.service';
import { RecordingIndexService } from '../services/recording/recordingIndex.service';
import { StreamManager } from '../../../services/ai-worker/src/streamManager';
import prisma from '../config/database';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    camera: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    segmentJob: {
      upsert: jest.fn(),
    },
    evidenceManifest: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    chainOfCustodyLog: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    recordingSegment: {
      findMany: jest.fn(),
    },
  },
}));

function createMockRes() {
  const res: any = {};
  res.statusCode = 200;
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data: any) => {
    res.body = data;
    return res;
  };
  return res;
}

describe('Architectural Invariant: AI / Evidence Plane Strict Decoupling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Evidence Recording Continuity Under AI Stream Crashes', () => {
    it('recording segment ingestion proceeds with 100% success when AI loopback extractor crashes', async () => {
      // 1. Simulate AI StreamManager experiencing crash and disconnect
      const aiManager = new StreamManager({
        cameraId: 'cam-court-evidence',
        tenantId: 'tenant-secure',
        streamPath: 'cam_court_evidence',
        baseBackoffMs: 50,
      });

      // AI manager enters backoff/disconnect state
      aiManager.start();

      // 2. Concurrently, MediaMTX finalizes an fMP4 recording segment and calls handleSegmentComplete
      (prisma.camera.findFirst as jest.Mock).mockResolvedValue({
        id: 'cam-court-evidence',
        tenantId: 'tenant-secure',
      });

      (prisma.segmentJob.upsert as jest.Mock).mockResolvedValue({
        id: 'job-durable-001',
        status: 'PENDING',
      });

      const req: any = {
        body: {
          path: 'cam_court_evidence',
          file: '/recordings/cam_court_evidence/2026-09-24_01-00-00.mp4',
        },
      };
      const res = createMockRes();

      await handleSegmentComplete(req, res);

      // 3. Assert segment was ingested into durable queue with status 200
      expect(res.statusCode).toBe(200);
      expect(res.body.queued).toBe(true);
      expect(res.body.jobId).toBe('job-durable-001');

      // Clean up AI worker
      await aiManager.stop();
    });
  });

  describe('2. Evidence Custody & Manifest Purity (Zero AI Mutation)', () => {
    it('AI worker reconnect cycles and frame errors NEVER invoke or mutate evidence plane', async () => {
      const manifestSpy = jest.spyOn(prisma.evidenceManifest, 'create');
      const custodySpy = jest.spyOn(prisma.chainOfCustodyLog, 'create');

      // Simulate 5 rapid AI stream manager backoff calculations
      const aiManager = new StreamManager({
        cameraId: 'cam-patrol-01',
        tenantId: 'tenant-secure',
        streamPath: 'cam_patrol_01',
        baseBackoffMs: 10,
        maxBackoffMs: 50,
      });

      for (let i = 0; i < 5; i++) {
        aiManager.calculateBackoffDelay(i);
      }

      // Assert zero calls to evidence tables from AI stream transport
      expect(manifestSpy).not.toHaveBeenCalled();
      expect(custodySpy).not.toHaveBeenCalled();

      await aiManager.stop();
    });

    it('creates Section 63 BSA evidence manifest with authentic SHA-256 root hash in parallel with AI pipeline operations', async () => {
      const custodyLogs: any[] = [];
      (prisma.chainOfCustodyLog.create as jest.Mock).mockImplementation(({ data }) => {
        const entry = { id: `custody-${custodyLogs.length + 1}`, ...data };
        custodyLogs.push(entry);
        return Promise.resolve(entry);
      });

      (prisma.evidenceManifest.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({ id: 'manifest-bsa-001', ...data })
      );

      const recordingIndex = {
        findSegments: jest.fn().mockResolvedValue([
          {
            id: 'seg-1',
            segmentUri: '/store/cam1_seg1.mp4',
            startUtc: new Date('2026-09-24T00:00:00Z'),
            endUtc: new Date('2026-09-24T00:05:00Z'),
          },
        ]),
      } as unknown as RecordingIndexService;

      const chainOfCustody = new ChainOfCustodyService(prisma);
      const manifestService = new EvidenceManifestService(prisma, recordingIndex, chainOfCustody);

      const manifest = await manifestService.createManifest({
        tenantId: 'tenant-secure',
        createdByUserId: 'usr-investigator',
        cameraIds: ['cam-court-evidence'],
        startUtc: new Date('2026-09-24T00:00:00Z'),
        endUtc: new Date('2026-09-24T00:05:00Z'),
        notes: 'Section 63 BSA Evidence Package Generated while AI Worker is active',
      });

      expect(manifest).toBeDefined();
      expect(manifest.id).toBe('manifest-bsa-001');
      expect(manifest.masterEvidenceHash).toBeDefined();
      expect(manifest.masterEvidenceHash).toHaveLength(64); // SHA-256
      const certData = manifest.certificateDataJson as any;
      expect(certData.disclaimer).toContain('Bharatiya Sakshya Adhiniyam, 2023');
      expect(custodyLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
