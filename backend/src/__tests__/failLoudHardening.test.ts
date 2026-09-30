/**
 * P0.4 regression tests: test doubles and hooks are available only under NODE_ENV=test, and
 * missing data is reported as missing rather than invented.
 */
import { ObjectStorageArchiveService } from '../services/storage/objectStorageArchive.service';
import { StorageEpochService } from '../services/storage/storageEpoch.service';
import { OtaUpdateService } from '../services/appliance/otaUpdate.service';

const withNodeEnv = async (value: string, fn: () => Promise<void>) => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    await fn();
  } finally {
    process.env.NODE_ENV = saved;
  }
};

describe('P0.4 fail-loud hardening', () => {
  describe('object storage archive', () => {
    // The in-memory "store" that used to stand in for S3 is gone. A job is COMPLETED only after the configured
    // store confirmed the object; with credentials that cannot be read it must never be marked COMPLETED.
    const prismaMock: any = {
      archiveJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          objectKey: 'k',
          segmentPath: '/nonexistent',
          sha256Checksum: 'a'.repeat(64),
          sizeBytes: 1,
          attempts: 0,
          maxAttempts: 3,
          priority: true,
          status: 'QUEUED',
          tenant: { objectStorageConfig: { enabled: true, offPeakStartUtc: '00:00', offPeakEndUtc: '23:59', accessKeyEncrypted: 'not-encrypted', secretKeyEncrypted: 'not-encrypted', bucket: 'b-1', region: 'us-east-1', endpoint: null, bandwidthLimitKbps: 0 } },
        }),
        update: jest.fn(),
      },
    };

    it.each(['development', 'production'])('never marks a job COMPLETED without a store that confirmed it (%s)', async (env) => {
      await withNodeEnv(env, async () => {
        const svc = new ObjectStorageArchiveService(prismaMock);
        const r = await svc.processArchiveJob('job-1');
        expect(r.status).not.toBe('COMPLETED');
        expect(r.error).toMatch(/cannot be decrypted/);
        for (const call of prismaMock.archiveJob.update.mock.calls) expect(call[0].data.status).not.toBe('COMPLETED');
      });
    });
  });

  describe('storage epoch chain', () => {
    it('records an explicit chain-break marker instead of re-anchoring to genesis', async () => {
      const created: any[] = [];
      const prismaMock: any = {
        storageEpoch: {
          findFirst: jest.fn().mockResolvedValue({ id: 'epoch-corrupt', epochNumber: 4, epochHash: null }),
          update: jest.fn().mockResolvedValue({}),
          create: jest.fn().mockImplementation(({ data }) => {
            created.push(data);
            return Promise.resolve({ id: 'epoch-5', ...data });
          }),
        },
      };
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const svc = new StorageEpochService(prismaMock);
      const next = await svc.transitionEpoch({
        tenantId: 't',
        cameraId: 'cam-1',
        toVolumeId: 'vol-2',
        reason: 'VOLUME_SWITCH',
      } as any);
      errSpy.mockRestore();

      expect(next.epochNumber).toBe(5);
      expect(created[0].prevEpochHash).toBe(`${StorageEpochService.CHAIN_BREAK_PREFIX}epoch-corrupt`);
      expect(created[0].prevEpochHash).not.toBe('0'.repeat(64));
    });
  });

  describe('OTA test hooks', () => {
    it.each(['development', 'production'])('rejects skipHealthCheck in %s', async (env) => {
      await withNodeEnv(env, async () => {
        const svc = new OtaUpdateService({} as any);
        const result = await svc.applyUpdate('/nonexistent', { skipHealthCheck: true });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/OTA_TEST_HOOK_FORBIDDEN/);
      });
    });

    it('rejects mockHealthCheck outside tests', async () => {
      await withNodeEnv('production', async () => {
        const svc = new OtaUpdateService({} as any);
        await expect(
          svc.verifyOtaHealthOrRollback({} as any, {
            mockHealthCheck: async () => ({ healthy: true, apiUp: true, camerasExpected: 0, failedCameraIds: [] }),
          })
        ).rejects.toThrow(/OTA_TEST_HOOK_FORBIDDEN/);
      });
    });
  });
});
