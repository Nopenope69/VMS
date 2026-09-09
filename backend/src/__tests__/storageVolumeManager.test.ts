import fs from 'fs';
import path from 'path';
import os from 'os';
import { VolumeStatus } from '@prisma/client';
import { StorageVolumeService } from '../services/storage/storageVolume.service';

describe('Phase 2: StorageVolumeService & Mount Guard', () => {
  let tempDir: string;
  let prismaMock: any;
  let service: StorageVolumeService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-vol-test-'));

    const volumesTable = new Map<string, any>();
    const alarmsTable: any[] = [];
    const eventsTable: any[] = [];

    prismaMock = {
      storageVolume: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          for (const vol of volumesTable.values()) {
            if (where.tenantId && vol.tenantId !== where.tenantId) continue;
            if (where.isDefault !== undefined && vol.isDefault !== where.isDefault) continue;
            return Promise.resolve(vol);
          }
          return Promise.resolve(null);
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(volumesTable.get(where.id) || null);
        }),
        findMany: jest.fn().mockImplementation(({ where }) => {
          let list = Array.from(volumesTable.values());
          if (where?.tenantId) list = list.filter((v) => v.tenantId === where.tenantId);
          if (where?.status) list = list.filter((v) => v.status === where.status);
          if (where?.isReadOnly !== undefined) list = list.filter((v) => v.isReadOnly === where.isReadOnly);
          return Promise.resolve(list.map((v) => ({ ...v, _count: { cameras: 1 } })));
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const created = { id: `vol-${volumesTable.size + 1}`, ...data };
          volumesTable.set(created.id, created);
          return Promise.resolve(created);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const existing = volumesTable.get(where.id);
          if (!existing) throw new Error('Not found');
          const updated = { ...existing, ...data };
          volumesTable.set(where.id, updated);
          return Promise.resolve(updated);
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }) => {
          let count = 0;
          for (const [id, vol] of volumesTable.entries()) {
            if (where.tenantId && vol.tenantId !== where.tenantId) continue;
            if (where.isDefault !== undefined && vol.isDefault !== where.isDefault) continue;
            volumesTable.set(id, { ...vol, ...data });
            count++;
          }
          return Promise.resolve({ count });
        }),
        upsert: jest.fn().mockImplementation(({ where, update, create }) => {
          for (const [id, vol] of volumesTable.entries()) {
            if (vol.path === where.path) {
              const updated = { ...vol, ...update };
              volumesTable.set(id, updated);
              return Promise.resolve(updated);
            }
          }
          const created = { id: `vol-${volumesTable.size + 1}`, ...create };
          volumesTable.set(created.id, created);
          return Promise.resolve(created);
        }),
      },
      camera: {
        findUnique: jest.fn(),
      },
      alarm: {
        create: jest.fn().mockImplementation(({ data }) => {
          alarmsTable.push(data);
          return Promise.resolve(data);
        }),
      },
      event: {
        create: jest.fn().mockImplementation(({ data }) => {
          eventsTable.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    service = new StorageVolumeService(prismaMock);
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('verifies healthy mount using active read/write probe', async () => {
    const health = await service.verifyMountHealth(tempDir);
    expect(health.status).toBe(VolumeStatus.HEALTHY);
    expect(health.reason).toBeNull();
    // Probe file must have been cleanly removed
    expect(fs.existsSync(path.join(tempDir, '.vigilone-mount-probe'))).toBe(false);
  });

  it('detects unmounted non-existent path', async () => {
    const invalidPath = path.join(tempDir, 'does-not-exist');
    const health = await service.verifyMountHealth(invalidPath);
    expect(health.status).toBe(VolumeStatus.UNMOUNTED);
    expect(health.reason).toContain('does not exist');
  });

  it('detects EROFS read-only filesystem condition', async () => {
    // Spy on writeFileSync to simulate EROFS
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      const err: any = new Error('Read-only file system');
      err.code = 'EROFS';
      throw err;
    });

    const health = await service.verifyMountHealth(tempDir);
    expect(health.status).toBe(VolumeStatus.READ_ONLY);
    expect(health.reason).toContain('READ-ONLY');

    writeSpy.mockRestore();
  });

  it('registers a storage volume and ensures default volume initialization', async () => {
    const vol = await service.registerVolume({
      tenantId: 'tenant-1',
      name: 'Secondary Pool',
      path: tempDir,
      isDefault: true,
      maxBytes: 1000000000n,
    });

    expect(vol.id).toBeDefined();
    expect(vol.name).toBe('Secondary Pool');
    expect(vol.path).toBe(tempDir);
    expect(vol.status).toBe(VolumeStatus.HEALTHY);
  });

  it('deterministically resolves healthy fallback volume when primary volume fails', async () => {
    const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-fallback-'));

    // Register a secondary healthy fallback volume
    const fallbackVol = await service.registerVolume({
      tenantId: 'tenant-1',
      name: 'Fallback Pool',
      path: fallbackDir,
      isDefault: true,
    });

    // Primary volume that is degraded
    const badPrimaryVol = {
      id: 'vol-bad',
      tenantId: 'tenant-1',
      name: 'Failing Drive',
      path: '/non/existent/drive',
      status: VolumeStatus.DEGRADED,
      isReadOnly: false,
    };

    prismaMock.camera.findUnique.mockResolvedValueOnce({
      id: 'cam-99',
      tenantId: 'tenant-1',
      name: 'Front Gate',
      storageVolume: badPrimaryVol,
    });

    const resolution = await service.resolveActiveVolumeForCamera('cam-99');
    expect(resolution.isFallback).toBe(true);
    expect(resolution.volume.id).toBe(fallbackVol.id);
    expect(resolution.failureReason).toContain('unavailable');

    fs.rmSync(fallbackDir, { recursive: true, force: true });
  });
});
