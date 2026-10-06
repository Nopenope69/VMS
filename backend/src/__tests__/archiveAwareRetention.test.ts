import { RetentionPriority } from '@prisma/client';
import { RetentionPolicyEngine } from '../services/recording/catalog/retentionPolicy';
import { MetricsService } from '../services/observability/metrics.service';

/**
 * Under storage-quota pressure the retention engine must free segments that are already safe in the archive
 * store before segments that exist nowhere else, and must say so loudly when it has to drop an unarchived one.
 * Pinned evidence is never deleted. A tenant without an enabled archive behaves exactly as before.
 */
const GB = 1024n * 1024n * 1024n;
const NOW = new Date('2026-10-05T12:00:00Z');

interface Setup {
  archiveEnabled?: boolean;
  /** segment numbers (1 = oldest) whose archive job is COMPLETED */
  archived?: number[];
  /** segment numbers that carry an active evidence pin */
  pinned?: number[];
  /** make the archive-job lookup throw */
  archiveLookupFails?: boolean;
  existingActiveAlarm?: boolean;
  segments?: number;
  quotaGb?: number;
}

function build(o: Setup) {
  const segments = o.segments ?? 4;
  const table = new Map<string, any>();
  for (let i = 1; i <= segments; i++) {
    table.set(`seg-${i}`, {
      id: `seg-${i}`,
      cameraId: 'cam-a',
      tenantId: 't1',
      filePath: `/data/cam-a/seg-${i}.mp4`,
      startTime: new Date(NOW.getTime() - (segments + 1 - i) * 3600_000),
      endTime: new Date(NOW.getTime() - (segments - i) * 3600_000),
      sizeBytes: GB,
      status: 'FINALIZED',
    });
  }
  const pinnedIds = new Set((o.pinned ?? []).map((n) => `seg-${n}`));
  const archivedPaths = new Set((o.archived ?? []).map((n) => `/data/cam-a/seg-${n}.mp4`));
  const alarms: any[] = [];
  const deleted: string[] = [];

  const prisma: any = {
    // The engine's atomic delete passes the segment id as the first template value.
    $executeRaw: jest.fn().mockImplementation(async (_s: any, id: string) => (pinnedIds.has(id) ? 0 : 1)),
    camera: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'cam-a',
          name: 'Gate',
          tenantId: 't1',
          retentionPriority: RetentionPriority.NORMAL,
          retentionPolicy: { continuousDays: 30, motionDays: 90, maxStorageGigabytes: o.quotaGb ?? 2 },
        },
      ]),
    },
    retentionPolicy: { findFirst: jest.fn().mockResolvedValue(null) },
    recordingSegment: {
      findMany: jest.fn().mockImplementation(async () =>
        [...table.values()].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
      ),
    },
    alarm: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        alarms.push(data);
        return data;
      }),
      findFirst: jest.fn().mockImplementation(async () => (o.existingActiveAlarm ? { id: 'a1' } : null)),
    },
  };
  if (o.archiveEnabled) {
    prisma.objectStorageConfig = { findFirst: jest.fn().mockResolvedValue({ id: 'c1', enabled: true }) };
    prisma.archiveJob = {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        if (o.archiveLookupFails) throw new Error('db down');
        const paths: string[] = where.segmentPath.in;
        return paths.filter((p) => archivedPaths.has(p)).map((p) => ({ segmentPath: p }));
      }),
    };
  }

  const storage: any = {
    deleteFile: jest.fn().mockImplementation(async (p: string) => {
      deleted.push(p);
    }),
  };
  const engine = new RetentionPolicyEngine(prisma, {} as any, {} as any, storage);
  return { engine, deleted, alarms, prisma };
}

const path = (n: number) => `/data/cam-a/seg-${n}.mp4`;

describe('archive-aware retention under quota pressure', () => {
  it('without an enabled archive, deletes oldest first and reports nothing unarchived', async () => {
    const { engine, deleted, alarms } = build({});
    const r = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(deleted).toEqual([path(1), path(2)]);
    expect(r.unarchivedPurgedCount).toBe(0);
    expect(alarms).toHaveLength(0);
  });

  it('frees archived segments before an older segment that exists only locally', async () => {
    // seg-1 is oldest but not archived; seg-3 and seg-4 are archived. Two must go to fit 2 GB.
    const { engine, deleted, alarms } = build({ archiveEnabled: true, archived: [2, 3, 4] });
    const r = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(deleted).toEqual([path(2), path(3)]);
    expect(deleted).not.toContain(path(1));
    expect(r.unarchivedPurgedCount).toBe(0);
    expect(alarms).toHaveLength(0);
  });

  it('drops the oldest unarchived segment as a last resort, counts it and raises one alarm', async () => {
    const inc = jest.spyOn(MetricsService, 'incCounter');
    const { engine, deleted, alarms } = build({ archiveEnabled: true, archived: [] });
    const r = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(deleted).toEqual([path(1), path(2)]);
    expect(r.unarchivedPurgedCount).toBe(2);
    expect(r.unarchivedPurgedBytes).toBe(2n * GB);
    expect(alarms).toHaveLength(1);
    expect(alarms[0].title).toBe('STORAGE_UNARCHIVED_FOOTAGE_DROPPED');
    expect(alarms[0].metadataJson.segments).toBe(2);
    expect(alarms[0].metadataJson.cameraName).toBe('Gate');
    expect(inc).toHaveBeenCalledWith(expect.stringContaining('unarchived'), expect.any(String), undefined, 2);
    inc.mockRestore();
  });

  it('mixes: archived first, then only as many unarchived as still needed', async () => {
    const { engine, deleted } = build({ archiveEnabled: true, archived: [4], quotaGb: 2 });
    const report = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(deleted).toEqual([path(4), path(1)]);
    expect(report.unarchivedPurgedCount).toBe(1);
  });

  it('never deletes pinned evidence, archived or not, and still reports exhaustion', async () => {
    const { engine, deleted } = build({ archiveEnabled: true, archived: [1, 2], pinned: [1, 2, 3, 4] });
    const r = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(deleted).toEqual([]);
    expect(r.purgedCount).toBe(0);
    expect(r.exhaustionCondition).toBe(true);
  });

  it('treats every segment as unarchived when the archive state cannot be read', async () => {
    const { engine, deleted, alarms } = build({ archiveEnabled: true, archived: [3, 4], archiveLookupFails: true });
    const r = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(deleted).toEqual([path(1), path(2)]); // plain oldest-first, the quota is still enforced
    expect(r.unarchivedPurgedCount).toBe(2);
    expect(alarms).toHaveLength(1);
  });

  it('does not raise a second alarm while one is still active', async () => {
    const { engine, alarms } = build({ archiveEnabled: true, archived: [], existingActiveAlarm: true });
    const r = await engine.pruneCameraQuotasAndRetention('t1', NOW);
    expect(r.unarchivedPurgedCount).toBe(2);
    expect(alarms).toHaveLength(0);
  });
});
