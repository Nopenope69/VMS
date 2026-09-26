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
    const prismaMock: any = {
      archiveJob: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'job-1',
          objectKey: 'k',
          sha256Checksum: 'a'.repeat(64),
          sizeBytes: 1,
          priority: true,
          tenant: { objectStorageConfig: { enabled: true, offPeakStartUtc: '00:00', offPeakEndUtc: '23:59' } },
        }),
        update: jest.fn(),
      },
    };

    it.each(['development', 'production'])('refuses to mark a job COMPLETED in %s (no S3 client)', async (env) => {
      await withNodeEnv(env, async () => {
        const svc = new ObjectStorageArchiveService(prismaMock);
        await expect(svc.processArchiveJob('job-1')).rejects.toThrow(/FEATURE_DEFERRED_FOR_V1/);
        expect(prismaMock.archiveJob.update).not.toHaveBeenCalled();
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
