import fs from 'fs';
import path from 'path';
import os from 'os';
import { generate64CameraTopology } from '../config/soakTopology';
import { SoakTestHarness } from '../scripts/soakHarness';
import { SegmentStatus } from '@prisma/client';

describe('Task 3.1 & 3.2: 64-Camera Soak Workload & Zero Footage Loss (Section 3.1.1)', () => {
  let tempDir: string;
  let prismaMock: any;
  let camerasTable: Map<string, any>;
  let segmentsTable: Map<string, any>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-soak-workload-'));
    camerasTable = new Map();
    segmentsTable = new Map();

    prismaMock = {
      camera: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const c of camerasTable.values()) {
            if (where?.OR) {
              const matched = where.OR.some((clause: any) => {
                if (clause.id && c.id === clause.id) return true;
                if (clause.streamPath && c.streamPath === clause.streamPath) return true;
                return false;
              });
              if (matched) return Promise.resolve(c);
            }
            if (where?.streamPath && c.streamPath === where.streamPath) return Promise.resolve(c);
            if (where?.id && c.id === where.id) return Promise.resolve(c);
          }
          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          camerasTable.set(data.id, data);
          return Promise.resolve(data);
        }),
      },
      recordingSegment: {
        upsert: jest.fn().mockImplementation(({ where, create, update }) => {
          let existing = null;
          for (const s of segmentsTable.values()) {
            if (where?.filePath && s.filePath === where.filePath) existing = s;
          }
          if (existing) {
            const updated = { ...existing, ...update };
            segmentsTable.set(existing.id, updated);
            return Promise.resolve(updated);
          }
          const id = `seg-${Date.now()}-${Math.random()}`;
          const created = { id, ...create };
          segmentsTable.set(id, created);
          return Promise.resolve(created);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(segmentsTable.values());
          if (where?.cameraId) list = list.filter((s) => s.cameraId === where.cameraId);
          return Promise.resolve(list);
        }),
      },
    };
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('validates 64-camera topology across 4 vendor cohorts (16 streams each)', () => {
    const topology = generate64CameraTopology();
    expect(topology).toHaveLength(64);

    const hikvision = topology.filter((c) => c.cohort === 'HIKVISION');
    const dahua = topology.filter((c) => c.cohort === 'DAHUA');
    const cpplus = topology.filter((c) => c.cohort === 'CP_PLUS');
    const onvif = topology.filter((c) => c.cohort === 'ONVIF_PROFILE_ST');

    expect(hikvision).toHaveLength(16);
    expect(dahua).toHaveLength(16);
    expect(cpplus).toHaveLength(16);
    expect(onvif).toHaveLength(16);

    // Verify mandatory workload parameters from Contract Section 3.1.1
    for (const cam of topology) {
      expect(cam.resolutionPrimary).toBe('1920x1080');
      expect(cam.fpsPrimary).toBe(25);
      expect(cam.bitrateKbpsPrimary).toBe(2500);
      expect(cam.resolutionSub).toBe('640x360');
      expect(cam.fpsSub).toBe(10);
      expect(cam.bitrateKbpsSub).toBe(512);
      expect(cam.gopFrames).toBe(50);
      expect(cam.keyframeIntervalSec).toBe(2.0);
      expect(cam.transport).toBe('TCP');
      expect(cam.recordingFormat).toBe('fmp4');
      expect(cam.segmentDurationSec).toBe(600);
      expect(cam.partDurationSec).toBe(1);
    }
  });

  it('executes continuous soak cycles across all 64 cameras with zero footage loss', async () => {
    const harness = new SoakTestHarness(prismaMock, tempDir);
    const tenantId = 'tenant-soak-64';

    // 1. Provision 64 cameras
    const provisioned = await harness.provisionCameras(tenantId);
    expect(provisioned).toBe(64);
    expect(camerasTable.size).toBe(64);

    // 2. Simulate Cycle 1 (T0)
    const t0 = new Date('2026-09-12T00:00:00.000Z');
    const cycle1 = await harness.simulateSegmentCycle(1, t0, 600);

    expect(cycle1.totalCameras).toBe(64);
    expect(cycle1.segmentsCreated).toBe(64);
    expect(cycle1.segmentsIndexed).toBe(64);
    expect(cycle1.zeroByteFiles).toBe(0);
    expect(cycle1.footageLossGaps).toBe(0);
    expect(cycle1.storageUsageBytes).toBeGreaterThan(0);

    // 3. Simulate Cycle 2 (T0 + 10 minutes)
    const t1 = new Date(t0.getTime() + 600 * 1000);
    const cycle2 = await harness.simulateSegmentCycle(2, t1, 600);

    expect(cycle2.segmentsCreated).toBe(64);
    expect(cycle2.segmentsIndexed).toBe(64);
    expect(cycle2.footageLossGaps).toBe(0);

    // Verify 128 total segments indexed in DB (64 x 2)
    expect(segmentsTable.size).toBe(128);

    // 4. Verify temporal continuity between Cycle 1 and Cycle 2 for every camera
    const topology = generate64CameraTopology();
    for (const cam of topology) {
      const camSegments = Array.from(segmentsTable.values())
        .filter((s) => s.cameraId === cam.id)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

      expect(camSegments).toHaveLength(2);
      const seg1 = camSegments[0];
      const seg2 = camSegments[1];

      // Zero footage loss: seg1 endTime equals seg2 startTime
      expect(seg1.endTime.getTime()).toBe(seg2.startTime.getTime());
      expect(seg1.durationMs).toBe(600000);
      expect(seg2.durationMs).toBe(600000);
      expect(seg1.status).toBe(SegmentStatus.FINALIZED);
      expect(seg2.status).toBe(SegmentStatus.FINALIZED);
    }
  });
});
