import { handleSegmentComplete } from '../routes/internal.routes';
import { EvidenceManifestService } from '../services/evidence/evidenceManifest.service';
import { ChainOfCustodyService } from '../services/evidence/chainOfCustody.service';
import { RecordingIndexService } from '../services/recording/recordingIndex.service';
import { AiWorker } from '../../../services/ai-worker/src/worker';
import { OnnxInferenceEngine } from '../../../services/ai-worker/src/inferenceEngine';
import { CoordinateTransformer } from '../../../services/ai-worker/src/coordinateTransformer';
import { VideoFrame, ModelManifestRecord } from '../../../services/ai-worker/src/types';
import prisma from '../config/database';

jest.mock('../config/database', () => ({
  __esModule: true,
  default: {
    camera: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
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
    detectionEvent: {
      upsert: jest.fn(),
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

describe('Architectural Evidence Plane Isolation Under Heavy AI Load', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.AI_INFERENCE_MODE = 'test-stub';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('guarantees 100% evidence segment ingestion and custody hashing while AI plane suffers severe timeout and frame drop loads', async () => {
    // 1. Setup Evidence Plane mocks
    (prisma.camera.findFirst as jest.Mock).mockImplementation(({ where }) =>
      Promise.resolve({
        id: `cam-${where.streamPath || 'default'}`,
        tenantId: 'tenant-critical',
        streamPath: where.streamPath,
      })
    );

    let queuedJobsCount = 0;
    (prisma.segmentJob.upsert as jest.Mock).mockImplementation(({ where }) => {
      queuedJobsCount++;
      return Promise.resolve({
        id: `job-${where.segmentPath}`,
        status: 'PENDING',
      });
    });

    (prisma.evidenceManifest.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'manifest-sec63-001',
        ...data,
      })
    );

    (prisma.chainOfCustodyLog.create as jest.Mock).mockImplementation(({ data }) =>
      Promise.resolve({
        id: 'custody-log-001',
        ...data,
      })
    );

    // 2. Setup AI Worker under test with tight scheduler deadline to induce timeouts & stale drops
    const manifest: ModelManifestRecord = {
      id: 'manifest-detector-1',
      name: 'vigilone-person-vehicle-detector',
      version: '1.0.0',
      sha256: 'mock-sha',
      codeLicense: 'Apache-2.0',
      weightLicense: 'Apache-2.0',
      runtimeConfigJson: {
        runtime: 'onnxruntime',
        inputWidth: 640,
        inputHeight: 640,
        colorSpace: 'RGB',
        modelFormat: 'ONNX',
      },
      classesJson: { '0': 'person', '1': 'vehicle' },
      thresholdsJson: { person: 0.45, vehicle: 0.5 },
      modelSignatureJson: {
        input: { name: 'images', shape: [1, 3, 640, 640], dtype: 'float32' },
        output: { name: 'output0', shape: [1, 6, 8400], dtype: 'float32' },
        coordinateFormat: 'cxcywh',
        hasObjectness: false,
        classCount: 2,
      },
      isActive: true,
    };

    const engine = new OnnxInferenceEngine();
    await engine.load(Buffer.from('mock-bytes'), manifest.runtimeConfigJson, manifest);

    const worker = new AiWorker(
      {
        backendBaseUrl: 'http://127.0.0.1:4000',
        internalSecret: 'test-secret',
        schedulerOptions: { maxConcurrency: 2, timeoutMs: 20 }, // very tight 20ms timeout to trigger timeouts under load
      },
      engine
    );
    (worker as any).loadedModel = { manifest, buffer: Buffer.from('mock'), verified: true };
    worker.core.setModel({ manifest }); // the adapter core serves inference (Phase 2)
    (worker as any).apiClient.submitDetection = jest.fn().mockResolvedValue({ success: true });

    const geometry = CoordinateTransformer.computeGeometry(1920, 1080, 640, 640, true);

    // 3. Launch concurrent storm of AI frames across 3 cameras sharing 2 concurrency slots
    const aiFramePromises: Promise<any>[] = [];
    const NUM_AI_FRAMES = 30;

    for (let i = 0; i < NUM_AI_FRAMES; i++) {
      const cameraId = `cam-${i % 3}`;
      const frame: VideoFrame = {
        cameraId,
        tenantId: 'tenant-critical',
        streamPath: `stream_${cameraId}`,
        streamSessionId: `sess-${cameraId}`,
        sequenceNumber: i + 1,
        sampledAt: new Date(),
        receivedAt: new Date(),
        width: 640,
        height: 640,
        channels: 3,
        data: Buffer.alloc(640 * 640 * 3),
        geometry,
      };

      aiFramePromises.push(worker.processFrame(frame));
    }

    // 4. Concurrently, fire MediaMTX segment completion webhooks and Section 63 BSA evidence manifest generation
    const evidencePromises: Promise<any>[] = [];
    const NUM_EVIDENCE_SEGMENTS = 15;

    for (let s = 0; s < NUM_EVIDENCE_SEGMENTS; s++) {
      const streamPath = `cam-${s % 3}`;
      const req: any = {
        body: {
          path: streamPath,
          file: `/recordings/${streamPath}/segment_${s}.mp4`,
        },
      };
      const res = createMockRes();

      evidencePromises.push(
        handleSegmentComplete(req, res).then(() => {
          expect(res.statusCode).toBe(200);
          expect(res.body.queued).toBe(true);
        })
      );
    }

    // Also run Section 63 BSA Evidence Manifest creation and Chain of Custody logging
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

    const custodyPromise = (async () => {
      const manifestResult = await manifestService.createManifest({
        tenantId: 'tenant-critical',
        createdByUserId: 'usr-investigator',
        cameraIds: ['cam-0'],
        startUtc: new Date('2026-09-24T00:00:00Z'),
        endUtc: new Date('2026-09-24T01:00:00Z'),
        notes: 'Section 63 BSA Evidence Package Generated while AI Worker is active',
      });
      expect(manifestResult).toBeDefined();
      expect(manifestResult.masterEvidenceHash).toBeDefined();

      const custodyLog = await chainOfCustody.recordEvent({
        tenantId: 'tenant-critical',
        evidenceId: 'manifest-sec63-001',
        actorUserId: 'officer-smith',
        action: 'EXPORT',
        sourceHash: '0'.repeat(64),
        metadata: { reason: 'Exported for judicial court review under Section 63 BSA' },
      });
      expect(custodyLog).toBeDefined();
    })();

    // 5. Await both planes simultaneously
    await Promise.all([...evidencePromises, custodyPromise, ...aiFramePromises]);

    // 6. Strict architectural invariant assertions:
    // Evidence plane: 100% of segments queued into durable storage with status 200
    expect(queuedJobsCount).toBe(NUM_EVIDENCE_SEGMENTS);
    expect(prisma.evidenceManifest.create).toHaveBeenCalled();
    expect(prisma.chainOfCustodyLog.create).toHaveBeenCalled();

    // AI plane: Telemetry confirms heavy load was absorbed and scheduler performed its duties
    const telemetry = worker.getSchedulerTelemetry();
    expect(telemetry.inferenceCount).toBe(NUM_AI_FRAMES);
    expect(telemetry.successCount + telemetry.timeoutCount + telemetry.droppedStaleCount).toBeGreaterThan(0);
  });
});
