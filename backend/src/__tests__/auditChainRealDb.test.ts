import { PrismaClient } from '@prisma/client';
import { AuditChainService } from '../services/audit/auditChain.service';
import { createTenantWithCamera } from './helpers/realDb';

/**
 * Regression (found by the Phase 2 model-registry test): metadata containing undefined values or
 * Date objects was hashed differently from what JSONB stores, so the chain could never re-verify
 * and a legitimate log read as tampered.
 */
describe('audit chain on the real database', () => {
  const prisma = new PrismaClient();
  let tenantId = '';
  beforeAll(async () => {
    ({ tenantId } = await createTenantWithCamera(prisma, 'auditrt'));
  });
  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('entries whose metadata holds undefined values and Dates still verify', async () => {
    await AuditChainService.record(prisma, {
      tenantId, action: 'TEST_A', resourceType: 'Test', ipAddress: '127.0.0.1',
      metadata: { reason: 'x', runtimeVersion: undefined, at: new Date('2026-09-27T10:00:00Z'), nested: { a: undefined, b: 1 } },
    });
    await AuditChainService.record(prisma, { tenantId, action: 'TEST_B', resourceType: 'Test', ipAddress: '127.0.0.1' });
    const v = await AuditChainService.verifyChain(prisma, tenantId);
    expect(v).toMatchObject({ valid: true, verifiedCount: 2 });
    const stored = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'TEST_A' } });
    expect(stored!.metadataJson).toEqual({ reason: 'x', at: '2026-09-27T10:00:00.000Z', nested: { b: 1 } });
  });

  it('tampering with a stored entry is still detected', async () => {
    const e = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'TEST_A' } });
    await prisma.auditEvent.update({ where: { id: e!.id }, data: { metadataJson: { reason: 'edited' } } });
    expect((await AuditChainService.verifyChain(prisma, tenantId)).valid).toBe(false);
  });
});
