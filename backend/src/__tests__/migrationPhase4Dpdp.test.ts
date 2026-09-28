/** Migration test for 20261001000000_dpdp_controls: defaults (face off) and CHECK constraints. */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';

const prisma = new PrismaClient();
let tenantId = '';
beforeAll(async () => {
  ({ tenantId } = await createTenantWithCamera(prisma, 'mig4dpdp'));
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('P4.6 DPDP migration', () => {
  it('defaults: face processing off, 30-day retention, every purpose allowed; removed with the tenant', async () => {
    const s = await prisma.dataProtectionSettings.create({ data: { tenantId } });
    expect(s).toMatchObject({ faceProcessingEnabled: false, plateRetentionDays: 30, detectionSnapshotRetentionDays: 30, lastPurgeAt: null });
    expect(s.allowedPurposes).toHaveLength(6);
    await expect(prisma.dataProtectionSettings.update({ where: { tenantId }, data: { plateRetentionDays: 0 } })).rejects.toThrow();
    await expect(prisma.dataProtectionSettings.update({ where: { tenantId }, data: { detectionSnapshotRetentionDays: 4000 } })).rejects.toThrow();
    await expect(prisma.dataProtectionSettings.update({ where: { tenantId }, data: { allowedPurposes: ['MARKETING'] } })).rejects.toThrow();
    await prisma.dataProtectionSettings.update({ where: { tenantId }, data: { allowedPurposes: ['AUDIT_REVIEW'] } });
  });
});
