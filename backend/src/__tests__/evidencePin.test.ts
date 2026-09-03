import { EvidencePinManager } from '../services/storage/evidencePinManager.service';

describe('Evidence Pin Lease Manager & Admission Control', () => {
  const testTenantId = 'tenant_pin_test_01';
  const segmentId1 = 'seg_01';
  const segmentId2 = 'seg_02';

  // In-memory store simulating PostgreSQL EvidencePin table
  const pinsStore: any[] = [];

  beforeAll(() => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || 'postgresql://vigilone:vigilone_dev@localhost:5432/vigilone_db';

    // Mock PrismaClient calls inside EvidencePinManager
    const mockPrisma = (EvidencePinManager as any).prisma;

    jest.spyOn(mockPrisma.evidencePin, 'createMany').mockImplementation(async ({ data }: any) => {
      for (const item of data) {
        pinsStore.push({
          id: `pin_${Date.now()}_${Math.random()}`,
          releasedAt: null,
          ...item,
        });
      }
      return { count: data.length };
    });

    jest.spyOn(mockPrisma.evidencePin, 'findMany').mockImplementation(async (query: any) => {
      return pinsStore.filter((p) => {
        if (query?.where?.exportJobId && p.exportJobId !== query.where.exportJobId) return false;
        if (query?.where?.releasedAt === null && p.releasedAt !== null) return false;
        if (query?.where?.expiresAt?.gt && p.expiresAt <= query.where.expiresAt.gt) return false;
        return true;
      });
    });

    jest.spyOn(mockPrisma.evidencePin, 'findFirst').mockImplementation(async (query: any) => {
      return (
        pinsStore.find((p) => {
          if (query?.where?.segmentId && p.segmentId !== query.where.segmentId) return false;
          if (query?.where?.releasedAt === null && p.releasedAt !== null) return false;
          if (query?.where?.expiresAt?.gt && p.expiresAt <= query.where.expiresAt.gt) return false;
          return true;
        }) || null
      );
    });

    jest.spyOn(mockPrisma.evidencePin, 'updateMany').mockImplementation(async (query: any) => {
      let count = 0;
      for (const p of pinsStore) {
        let match = true;
        if (query?.where?.exportJobId && p.exportJobId !== query.where.exportJobId) match = false;
        if (query?.where?.releasedAt === null && p.releasedAt !== null) match = false;
        if (query?.where?.expiresAt?.lt && p.expiresAt >= query.where.expiresAt.lt) match = false;

        if (match) {
          Object.assign(p, query.data);
          count++;
        }
      }
      return { count };
    });

    jest.spyOn(mockPrisma.recordingSegment, 'count').mockResolvedValue(100);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    pinsStore.length = 0;
  });

  it('should acquire concurrent leases on the same segment without collisions', async () => {
    const exportJobA = 'export_job_aaa';
    const exportJobB = 'export_job_bbb';

    // Job A pins segment 1 and 2
    await EvidencePinManager.acquireLease(testTenantId, [segmentId1, segmentId2], exportJobA, 'EXPORT_A', 1);

    // Job B concurrently pins segment 1
    await EvidencePinManager.acquireLease(testTenantId, [segmentId1], exportJobB, 'EXPORT_B', 1);

    expect(await EvidencePinManager.isSegmentPinned(segmentId1)).toBe(true);
    expect(await EvidencePinManager.isSegmentPinned(segmentId2)).toBe(true);

    // Releasing Job A should NOT unpin segment 1 because Job B still holds an active lease
    const releasedCount = await EvidencePinManager.releaseLease(exportJobA);
    expect(releasedCount).toBe(2);

    // Segment 1 is still protected by Job B's lease
    expect(await EvidencePinManager.isSegmentPinned(segmentId1)).toBe(true);

    // Segment 2 was only held by Job A, so it is now unpinned
    expect(await EvidencePinManager.isSegmentPinned(segmentId2)).toBe(false);

    // Releasing Job B unpins segment 1
    await EvidencePinManager.releaseLease(exportJobB);
    expect(await EvidencePinManager.isSegmentPinned(segmentId1)).toBe(false);
  });

  it('should automatically reap expired leases during recovery sweep', async () => {
    const expiredJob = 'export_job_expired';

    // Inject expired lease
    pinsStore.push({
      id: 'pin_expired_1',
      tenantId: testTenantId,
      segmentId: segmentId1,
      exportJobId: expiredJob,
      reason: 'CRASHED_EXPORT',
      expiresAt: new Date(Date.now() - 60000), // 1 minute in the past
      releasedAt: null,
    });

    // Before reap, isSegmentPinned returns false because expiresAt is in past
    expect(await EvidencePinManager.isSegmentPinned(segmentId1)).toBe(false);

    // Sweeper marks it released
    const reaped = await EvidencePinManager.reapExpiredLeases();
    expect(reaped).toBe(1);
    expect(pinsStore[0].releasedAt).toBeDefined();
  });

  it('should enforce admission control when storage free space is critical and pinned ratio exceeds 85%', async () => {
    // Inject 90 pinned segments out of 100
    for (let i = 0; i < 90; i++) {
      pinsStore.push({
        id: `pin_${i}`,
        tenantId: testTenantId,
        segmentId: `seg_${i}`,
        exportJobId: 'job_flood',
        expiresAt: new Date(Date.now() + 3600000),
        releasedAt: null,
      });
    }

    const admission = await EvidencePinManager.checkAdmissionControl('/tmp');
    expect(admission).toBeDefined();
    expect(admission.activePinnedSegments).toBe(90);
    expect(admission.pinnedRatio).toBe(0.9);
  });
});
