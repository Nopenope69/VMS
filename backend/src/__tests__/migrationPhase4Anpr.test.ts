/**
 * Migration test for 20260929000000_anpr_lpr_mode_watchlist_patterns on the real database:
 * LPR camera mode defaults, watchlist matchType values and the two-line CHECK on observations.
 * (Schema/migration drift for the whole history is checked in migrationPhase2.test.ts.)
 */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';
const violates = (p: Promise<unknown>) => expect(p).rejects.toThrow();

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'mig4anpr'));
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('P4.1 ANPR migration', () => {
  it('cameras are not in LPR mode by default and carry an optional config', async () => {
    const cam = await prisma.camera.findUniqueOrThrow({ where: { id: cameraId } });
    expect(cam.lprMode).toBe(false);
    expect(cam.lprConfigJson).toBeNull();
    const upd = await prisma.camera.update({ where: { id: cameraId }, data: { lprMode: true, lprConfigJson: { fps: 2 } } });
    expect(upd.lprConfigJson).toEqual({ fps: 2 });
  });

  it('watchlist matchType defaults to EXACT and only EXACT/WILDCARD/REGEX are stored', async () => {
    const wl = await prisma.vehicleWatchlist.create({ data: { tenantId, plateNumber: 'MH12AB1234', normalizedPlate: 'MH12AB1234' } });
    expect(wl.matchType).toBe('EXACT');
    await prisma.vehicleWatchlist.create({ data: { tenantId, plateNumber: 'MH12*', normalizedPlate: 'MH12*', matchType: 'WILDCARD' } });
    await prisma.vehicleWatchlist.create({ data: { tenantId, plateNumber: '^KA0[1-5]', normalizedPlate: '^KA0[1-5]', matchType: 'REGEX' } });
    await violates(prisma.vehicleWatchlist.create({ data: { tenantId, plateNumber: 'X', normalizedPlate: 'X', matchType: 'FUZZY' } }));
  });

  it('observation recognition columns are nullable and lines is 1 or 2', async () => {
    const base = { tenantId, cameraId, plateNumber: 'TN 09 BK 3301', normalizedPlate: 'TN09BK3301' };
    const legacy = await prisma.vehicleObservation.create({ data: base });
    expect([legacy.provenanceJson, legacy.plateFormat, legacy.rawText, legacy.lines]).toEqual([null, null, null, null]);
    const two = await prisma.vehicleObservation.create({
      data: { ...base, lines: 2, plateFormat: 'STANDARD', rawText: 'TN09BK33O1', provenanceJson: { modelName: 'anpr-india' } },
    });
    expect(two.lines).toBe(2);
    await violates(prisma.vehicleObservation.create({ data: { ...base, lines: 3 } }));
    await violates(prisma.vehicleObservation.create({ data: { ...base, lines: 0 } }));
  });
});
