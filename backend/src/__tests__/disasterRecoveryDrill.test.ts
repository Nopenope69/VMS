import fs from 'fs';
import path from 'path';
import os from 'os';
import { PrismaClient, SegmentStatus, EventSeverity, EventType } from '@prisma/client';
import ClockGuard from '../utils/clockGuard';
import PinStateMirrorService from '../services/evidence/pinStateMirror.service';
import ControlPlaneManifestService from '../services/appliance/controlPlaneManifest.service';
import { DisasterRecoveryService } from '../services/appliance/disasterRecovery.service';
import { FFmpegService } from '../services/ffmpeg/ffmpeg.service';

describe('Stage 4 Task 4.3: End-to-End Disaster Recovery & Database Restore Drill', () => {
  let testDir: string;
  let configDir: string;
  let recordingsDir: string;
  let prismaMock: any;
  let drService: DisasterRecoveryService;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-dr-drill-'));
    configDir = path.join(testDir, 'config');
    recordingsDir = path.join(testDir, 'recordings');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(recordingsDir, { recursive: true });

    // Set paths
    ClockGuard.setStateFilePath(path.join(configDir, 'clock_guard.state'));
    ClockGuard.resetToEpoch();

    PinStateMirrorService.setMirrorPath(path.join(configDir, 'pinned_segments.state'));
    ControlPlaneManifestService.setManifestPath(path.join(configDir, 'appliance_manifest.json'));

    // Setup in-memory mock DB
    const segmentsStore: any[] = [];
    const pinsStore: any[] = [];
    const eventsStore: any[] = [];
    const camerasStore: any[] = [];

    prismaMock = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-dr-1' }),
      },
      camera: {
        findFirst: jest.fn().mockImplementation((args: any) => {
          const val = args?.where?.OR?.[0]?.id || args?.where?.OR?.[1]?.streamPath;
          return camerasStore.find((c) => c.id === val || c.streamPath === val) || null;
        }),
        findUnique: jest.fn().mockImplementation((args: any) => {
          return camerasStore.find((c) => c.id === args?.where?.id) || null;
        }),
        create: jest.fn().mockImplementation((args: any) => {
          const cam = { ...args.data };
          camerasStore.push(cam);
          return cam;
        }),
      },
      site: {
        findFirst: jest.fn().mockResolvedValue({ id: 'site-dr-1', name: 'Main Facility' }),
        create: jest.fn().mockResolvedValue({ id: 'site-dr-1', name: 'Main Facility' }),
      },
      recordingSegment: {
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          return segmentsStore.find((s) => s.filePath === args?.where?.filePath) || null;
        }),
        findMany: jest.fn().mockImplementation(async () => segmentsStore),
        create: jest.fn().mockImplementation(async (args: any) => {
          const seg = { id: `seg-${segmentsStore.length + 1}`, ...args.data };
          segmentsStore.push(seg);
          return seg;
        }),
        update: jest.fn(),
      },
      evidencePin: {
        create: jest.fn().mockImplementation(async (args: any) => {
          const pin = { id: `pin-${pinsStore.length + 1}`, ...args.data };
          pinsStore.push(pin);
          return pin;
        }),
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          return pinsStore.find((p) => p.segmentId === args?.where?.segmentId && !p.releasedAt) || null;
        }),
        findMany: jest.fn().mockImplementation(async () => pinsStore),
      },
      event: {
        create: jest.fn().mockImplementation(async (args: any) => {
          const ev = { id: `ev-${eventsStore.length + 1}`, ...args.data };
          eventsStore.push(ev);
          return ev;
        }),
      },
      alarm: {
        create: jest.fn().mockResolvedValue({ id: 'alarm-1' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };

    // Mock FFmpeg probe for valid fMP4
    jest.spyOn(FFmpegService, 'probe').mockResolvedValue({
      durationSeconds: 60,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      fps: 25,
      sizeBytes: 1024000,
    });

    drService = new DisasterRecoveryService(prismaMock as unknown as PrismaClient, configDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('Scenario A: restores backup and strictly enforces security state monotonicity', async () => {
    // Current live system has reached 2026-09-25
    const liveTime = new Date('2026-09-25T14:00:00Z');
    ClockGuard.recordCheckpoint(liveTime);

    // Old backup contains a previous state from 2026-09-20
    const backupDir = path.join(testDir, 'extracted-backup');
    fs.mkdirSync(backupDir, { recursive: true });

    const olderTime = new Date('2026-09-20T08:00:00Z');
    fs.writeFileSync(path.join(backupDir, 'clock_guard.state'), olderTime.toISOString());
    fs.writeFileSync(
      path.join(backupDir, 'pinned_segments.state'),
      JSON.stringify({
        version: 1,
        updatedAt: olderTime.toISOString(),
        pins: {
          'hash-abc-123': {
            sha256: 'hash-abc-123',
            segmentId: 'seg-100',
            cameraId: 'cam-1',
            pinnedAt: olderTime.toISOString(),
            pinnedBy: 'auditor',
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(backupDir, 'appliance_manifest.json'),
      JSON.stringify({
        version: 1,
        updatedAt: olderTime.toISOString(),
        applianceId: 'appliance-alpha',
        tenantId: 'tenant-dr-1',
        cameras: [{ id: 'cam-1', name: 'Front Gate', streamPath: 'cam1', tenantId: 'tenant-dr-1' }],
      })
    );

    const result = await drService.restoreSecurityMonotonicState(backupDir);
    expect(result.manifestRestored).toBe(true);
    expect(result.pinsRestored).toBe(1);

    // CRITICAL: Clock floor MUST NOT regress back to 2026-09-20!
    const sanitized = ClockGuard.getSanitizedTimeForLicense();
    expect(sanitized.getTime()).toBeGreaterThanOrEqual(liveTime.getTime());

    // Verify pin was restored to mirror
    const pin = PinStateMirrorService.lookup('hash-abc-123');
    expect(pin).toBeDefined();
    expect(pin?.segmentId).toBe('seg-100');
  });

  it('Scenario B: catastrophic DB loss rebuild admits mapped media, restores pin from host mirror, and quarantines unmapped media', async () => {
    // 1. Establish surviving control-plane manifest
    const manifestCamera = {
      id: 'cam-gate-99',
      name: 'South Gate 99',
      streamPath: 'cam_south_gate',
      tenantId: 'tenant-dr-1',
    };
    fs.writeFileSync(
      ControlPlaneManifestService.getManifestPath(),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        applianceId: 'appliance-dr-core',
        tenantId: 'tenant-dr-1',
        cameras: [manifestCamera],
      })
    );

    // 2. Establish surviving pin mirror on host
    const pinnedHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    PinStateMirrorService.recordPin({
      sha256: pinnedHash,
      segmentId: 'seg-original-pinned',
      cameraId: manifestCamera.id,
      pinnedAt: '2026-09-10T10:00:00Z',
      pinnedBy: 'investigator-1',
      reason: 'BSA Section 63 Legal Hold',
    });

    // 3. Create physical media files on disk in recordings directory:
    // File A: Pinned legitimate segment
    const camDir = path.join(recordingsDir, manifestCamera.streamPath);
    fs.mkdirSync(camDir, { recursive: true });
    const fileA = path.join(camDir, '2026-09-12_10-00-00-000000.mp4');
    fs.writeFileSync(fileA, 'real-video-bytes-for-pinned-segment');

    // File B: Unpinned legitimate segment
    const fileB = path.join(camDir, '2026-09-12_10-10-00-000000.mp4');
    fs.writeFileSync(fileB, 'real-video-bytes-for-unpinned-segment');

    // File C: Unmapped rogue file (not in manifest)
    const rogueDir = path.join(recordingsDir, 'unregistered_camera_stream');
    fs.mkdirSync(rogueDir, { recursive: true });
    const rogueFile = path.join(rogueDir, '2026-09-12_10-20-00-000000.mp4');
    fs.writeFileSync(rogueFile, 'rogue-unmapped-footage');

    // Spy on hash calculation to return pinnedHash for fileA
    jest.spyOn(require('../utils/crypto'), 'computeFileSha256').mockImplementation(async (fPath: any) => {
      if (fPath === fileA) return pinnedHash;
      return 'different-hash-' + path.basename(fPath);
    });

    // 4. Execute Catastrophic Rebuild Drill
    const report = await drService.reconstructFromSurvivingMedia(recordingsDir);

    expect(report.orphansIndexed).toBe(2); // File A and File B
    expect(report.filesQuarantined).toBe(1); // Rogue File C was quarantined!

    // Verify rogue file was moved into .quarantine
    expect(fs.existsSync(rogueFile)).toBe(false);
    expect(fs.existsSync(path.join(rogueDir, '.quarantine', path.basename(rogueFile)))).toBe(true);

    // Verify File A was admitted, indexed, and restored as PINNED
    expect(prismaMock.recordingSegment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          filePath: fileA,
          cameraId: manifestCamera.id,
        }),
      })
    );

    // Verify EvidencePin was created with restored status
    expect(prismaMock.evidencePin.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'BSA Section 63 Legal Hold',
          exportJobId: 'investigator-1',
          pinType: 'LEGAL_HOLD',
        }),
      })
    );

    // Verify honest audit event was recorded noting custody gap
    expect(prismaMock.event.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: EventType.STORAGE_WARNING,
          description: expect.stringContaining('Pin restored from host-state mirror after DB rebuild'),
        }),
      })
    );
  });
});
