import { loadCameraHealth, summariseHealth } from '../services/camera/cameraHealth.service';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);

const cam = (id: string, over: any = {}) => ({
  id,
  name: `Cam ${id}`,
  monitored: true,
  lastSeenAt: ago(5000),
  desiredRecorderState: 'RUNNING',
  observedRecorderState: 'RUNNING',
  lastRecorderError: null,
  lastReconciledAt: ago(1000),
  lastStateChangeAt: ago(1000),
  recordingMode: 'CONTINUOUS',
  effectiveRecordingMode: 'CONTINUOUS',
  degradationReason: 'NONE',
  degradationSince: null,
  tenantId: 't1',
  ...over,
});

function prismaWith(cameras: any[]) {
  const writes = jest.fn();
  const prisma: any = {
    camera: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        cameras.filter((c) => c.tenantId === where.tenantId && (!where.id || c.id === where.id))
      ),
      update: writes,
    },
    recordingSegment: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
        where.cameraId === 'stale' ? { status: 'FINALIZED', startTime: ago(9_000_000), endTime: ago(8_400_000) } : { status: 'FINALIZED', startTime: ago(900_000), endTime: ago(300_000) }
      ),
      create: writes,
    },
    streamDiagnostic: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  return { prisma, writes };
}

describe('loadCameraHealth', () => {
  it('scopes to the tenant and returns one row per camera with its derived state', async () => {
    const { prisma } = prismaWith([cam('a'), cam('stale'), cam('other', { tenantId: 't2' })]);
    const rows = await loadCameraHealth(prisma, 't1', { now: NOW });
    expect(rows.map((r) => r.cameraId).sort()).toEqual(['a', 'stale']);
    expect(rows.find((r) => r.cameraId === 'a')!.health.state).toBe('HEALTHY');
    expect(rows.find((r) => r.cameraId === 'stale')!.health.state).toBe('DEGRADED');
    expect(prisma.camera.findMany.mock.calls[0][0].where.tenantId).toBe('t1');
  });

  it('can be limited to one camera and uses the configured segment length', async () => {
    const { prisma } = prismaWith([cam('a'), cam('stale')]);
    // 1 minute segments make the 300 s old segment overdue (stale after 180 s).
    const rows = await loadCameraHealth(prisma, 't1', { cameraId: 'a', segmentDuration: '1m', now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0].health.state).toBe('DEGRADED');
  });

  it('falls back to 10 minute segments when the setting cannot be read', async () => {
    const { prisma } = prismaWith([cam('a')]);
    const rows = await loadCameraHealth(prisma, 't1', { segmentDuration: 'garbage', now: NOW });
    expect(rows[0].health.recording.staleAfterSeconds).toBe(1260);
  });

  it('is strictly read-only', async () => {
    const { prisma, writes } = prismaWith([cam('a')]);
    await loadCameraHealth(prisma, 't1', { now: NOW });
    expect(writes).not.toHaveBeenCalled();
  });

  it('summarises counts per state', async () => {
    const { prisma } = prismaWith([cam('a'), cam('stale'), cam('off', { monitored: false })]);
    const rows = await loadCameraHealth(prisma, 't1', { now: NOW });
    expect(summariseHealth(rows)).toEqual({ HEALTHY: 1, DEGRADED: 1, DOWN: 0, UNKNOWN: 0, NOT_MONITORED: 1 });
  });
});
