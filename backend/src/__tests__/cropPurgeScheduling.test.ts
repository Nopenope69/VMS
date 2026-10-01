/**
 * P5.1 scheduling of the crop purge: the startup decision server.ts makes (flag off starts nothing,
 * a bad interval is refused before anything starts) and the real timer behaviour of CropPurger on
 * the real database (runs at start and on each tick, stops when told, never overlaps itself).
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';
import { CropPurger } from '../services/crops/cropPurge.service';
import { CropStore } from '../services/crops/cropStore';
import { cropPurgeIntervalMs, DEFAULT_CROP_PURGE_INTERVAL_MS, startCropWorkers } from '../services/crops/cropWorkers';

jest.setTimeout(60000);

const FLAG = 'VIGILONE_FEATURE_OBJECT_CROPS';
const on = { [FLAG]: 'true' } as NodeJS.ProcessEnv;

describe('P5.1 crop worker startup (what server.ts calls)', () => {
  it('flag OFF (the default): nothing is started', () => {
    const purger = { start: jest.fn(), stop: jest.fn() };
    expect(startCropWorkers(purger, {})).toBeNull();
    expect(startCropWorkers(purger, { [FLAG]: 'false' })).toBeNull();
    expect(purger.start).not.toHaveBeenCalled();
  });

  it('flag ON: starts once with the default hourly interval, or CROP_PURGE_INTERVAL_MS; the handle stops it', () => {
    const purger = { start: jest.fn(), stop: jest.fn() };
    const handle = startCropWorkers(purger, on)!;
    expect(purger.start).toHaveBeenCalledWith(DEFAULT_CROP_PURGE_INTERVAL_MS);
    expect(DEFAULT_CROP_PURGE_INTERVAL_MS).toBe(3_600_000);
    handle.stop();
    expect(purger.stop).toHaveBeenCalledTimes(1);
    startCropWorkers(purger, { ...on, CROP_PURGE_INTERVAL_MS: '5000' });
    expect(purger.start).toHaveBeenLastCalledWith(5000);
  });

  it.each(['abc', '0', '-5', '999', '1500.5', 'Infinity'])('an invalid CROP_PURGE_INTERVAL_MS (%s) is refused loudly and nothing starts', (bad) => {
    const purger = { start: jest.fn(), stop: jest.fn() };
    expect(() => startCropWorkers(purger, { ...on, CROP_PURGE_INTERVAL_MS: bad })).toThrow(/CROP_PURGE_INTERVAL_MS/);
    expect(purger.start).not.toHaveBeenCalled();
  });

  it('an empty interval means the default; the flag off ignores a bad interval (it is not read)', () => {
    expect(cropPurgeIntervalMs({ CROP_PURGE_INTERVAL_MS: '  ' })).toBe(DEFAULT_CROP_PURGE_INTERVAL_MS);
    expect(startCropWorkers({ start: jest.fn(), stop: jest.fn() }, { CROP_PURGE_INTERVAL_MS: 'abc' })).toBeNull();
  });

  it('composition.ts starts the crop worker only through startCropWorkers and stops it on shutdown (static check)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../composition.ts'), 'utf8');
    expect(src).toContain('startCropWorkers(cropPurger)');
    expect(src).not.toMatch(/cropPurger\.start\(/);
    expect(src).toMatch(/cropWorkers\?\.stop\(\)/);
  });
});

describe('P5.1 CropPurger timer on the real database', () => {
  const prisma = new PrismaClient();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cropsched-')));
  const DAY = 86_400_000;
  let tenantId = '';
  let cameraId = '';
  const purger = (p: any = prisma) => new CropPurger(p, (now) => new CropStore(tmp, undefined, undefined, () => now));

  beforeAll(async () => {
    ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'cropsched'));
  });
  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** An expired crop (captured 30 days ago, 14-day retention) with a real file. */
  async function expiredCrop() {
    const id = crypto.randomUUID();
    const capturedAt = new Date(Date.now() - 30 * DAY);
    const rel = `${tenantId}/${cameraId}/${id}.jpg`;
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), 'x');
    await prisma.objectCrop.create({ data: { id, tenantId, cameraId, cropClass: 'NON_PERSON', objectClass: 'car', relativePath: rel, sha256: 'c'.repeat(64), byteLength: 1, capturedAt, expiresAt: new Date(capturedAt.getTime() + 14 * DAY) } });
    return { id, file: path.join(tmp, rel) };
  }
  const gone = async (c: { id: string; file: string }) => !fs.existsSync(c.file) && (await prisma.objectCrop.count({ where: { id: c.id } })) === 0;
  async function until(check: () => Promise<boolean>, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('runs once at start and on each tick, and stops running after stop()', async () => {
    const p = purger();
    const runs = jest.spyOn(p, 'runOnce');
    const first = await expiredCrop();
    p.start(100);
    try {
      expect(await until(() => gone(first))).toBe(true); // the run at start
      const second = await expiredCrop(); // created after start: only a later tick can remove it
      expect(await until(() => gone(second))).toBe(true);
      expect(runs.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      p.stop();
    }
    const callsAtStop = runs.mock.calls.length;
    const third = await expiredCrop();
    await new Promise((r) => setTimeout(r, 400));
    expect(runs.mock.calls.length).toBe(callsAtStop);
    expect(await gone(third)).toBe(false); // nothing runs after stop
    await p.runOnce(); // and a manual run still works
    expect(await gone(third)).toBe(true);
    p.start(100); // start is idempotent
    p.start(100);
    p.stop();
  });

  it('a slow run is never overlapped by the next tick', async () => {
    const slow: any = new Proxy(prisma, {
      get: (t: any, k) =>
        k === 'objectCrop'
          ? { groupBy: async (a: any) => { slowCalls++; await new Promise((r) => setTimeout(r, 300)); return t.objectCrop.groupBy(a); } }
          : t[k],
    });
    let slowCalls = 0;
    const p = purger(slow);
    const [a, b] = await Promise.all([p.runOnce(), p.runOnce()]);
    expect(slowCalls).toBe(1);
    expect([a, b].filter((r) => r.length === 0).length).toBeGreaterThanOrEqual(1);
    await p.runOnce(); // and it can run again once the first finished
    expect(slowCalls).toBe(2);
  });
});
