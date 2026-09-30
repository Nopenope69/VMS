/**
 * Migration test for 20261002000000_phase5_explanations_crops: the database itself refuses
 * malformed explanation hashes, unknown crop classes, person crops enabled without a recorded
 * purpose, and out-of-range retention; rows follow their parents on delete.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';

const prisma = new PrismaClient();
const hex = () => crypto.randomBytes(32).toString('hex');
let tenantId = '';
let cameraId = '';
let siteId = '';

beforeAll(async () => {
  ({ tenantId, cameraId, siteId } = await createTenantWithCamera(prisma, 'mig5wave'));
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('Phase 5 Wave A migration', () => {
  it('Explanation: one per alarm and template, hashes must be SHA-256 hex, removed with the alarm', async () => {
    const alarm = await prisma.alarm.create({ data: { tenantId, cameraId, title: 'mig5 alarm' } });
    const base = { tenantId, alarmId: alarm.id, cameraId, alarmTriggeredAt: alarm.triggeredAt, templateVersion: 'explain-template.v1', recordSha256: hex(), recordJson: { any: 'thing' }, generatedAt: new Date() };
    await expect(prisma.explanation.create({ data: { ...base, explanationId: 'not-a-hash' } })).rejects.toThrow();
    await expect(prisma.explanation.create({ data: { ...base, explanationId: hex(), recordSha256: 'ABC' } })).rejects.toThrow();
    await prisma.explanation.create({ data: { ...base, explanationId: hex() } });
    await expect(prisma.explanation.create({ data: { ...base, explanationId: hex() } })).rejects.toThrow(); // same alarm + template
    await prisma.explanation.create({ data: { ...base, explanationId: hex(), templateVersion: 'explain-template.v2' } });
    await prisma.alarm.delete({ where: { id: alarm.id } });
    expect(await prisma.explanation.count({ where: { alarmId: alarm.id } })).toBe(0);
  });

  it('ObjectCrop: class, hash, size and expiry are checked; the row survives its detection with the link cleared', async () => {
    const det = await prisma.detectionEvent.create({ data: { tenantId, cameraId, type: 'PERSON_DETECTED', confidence: 0.9 } });
    const now = new Date();
    const base = { tenantId, cameraId, objectClass: 'car', byteLength: 10, capturedAt: now, expiresAt: new Date(now.getTime() + 86_400_000) };
    await expect(prisma.objectCrop.create({ data: { ...base, cropClass: 'ANIMAL', relativePath: `a/${hex()}.jpg`, sha256: hex() } })).rejects.toThrow();
    await expect(prisma.objectCrop.create({ data: { ...base, cropClass: 'NON_PERSON', relativePath: `a/${hex()}.jpg`, sha256: 'xyz' } })).rejects.toThrow();
    await expect(prisma.objectCrop.create({ data: { ...base, cropClass: 'NON_PERSON', relativePath: `a/${hex()}.jpg`, sha256: hex(), byteLength: 0 } })).rejects.toThrow();
    await expect(prisma.objectCrop.create({ data: { ...base, cropClass: 'NON_PERSON', relativePath: `a/${hex()}.jpg`, sha256: hex(), expiresAt: now } })).rejects.toThrow();
    const ok = await prisma.objectCrop.create({ data: { ...base, cropClass: 'NON_PERSON', relativePath: `a/${hex()}.jpg`, sha256: hex(), detectionEventId: det.id } });
    await expect(prisma.objectCrop.create({ data: { ...base, cropClass: 'NON_PERSON', relativePath: `a/${hex()}.jpg`, sha256: hex(), detectionEventId: det.id } })).rejects.toThrow(); // one crop per detection
    await prisma.detectionEvent.delete({ where: { id: det.id } });
    expect((await prisma.objectCrop.findUniqueOrThrow({ where: { id: ok.id } })).detectionEventId).toBeNull();
  });

  it('SiteCropPolicy: person crops default to off, cannot be enabled without a purpose and who acknowledged it, retention is bounded', async () => {
    const p = await prisma.siteCropPolicy.create({ data: { siteId } });
    expect(p).toMatchObject({ personCropsEnabled: false, acknowledgedPurpose: null, nonPersonRetentionDays: null, personRetentionDays: null });
    await expect(prisma.siteCropPolicy.update({ where: { siteId }, data: { personCropsEnabled: true } })).rejects.toThrow();
    await expect(prisma.siteCropPolicy.update({ where: { siteId }, data: { personCropsEnabled: true, acknowledgedPurpose: '   ', acknowledgedByUserId: 'u1', acknowledgedAt: new Date() } })).rejects.toThrow();
    await expect(prisma.siteCropPolicy.update({ where: { siteId }, data: { personCropsEnabled: true, acknowledgedPurpose: 'SECURITY_INCIDENT_INVESTIGATION' } })).rejects.toThrow();
    await expect(prisma.siteCropPolicy.update({ where: { siteId }, data: { personRetentionDays: 0 } })).rejects.toThrow();
    await expect(prisma.siteCropPolicy.update({ where: { siteId }, data: { nonPersonRetentionDays: 4000 } })).rejects.toThrow();
    const on = await prisma.siteCropPolicy.update({ where: { siteId }, data: { personCropsEnabled: true, acknowledgedPurpose: 'SECURITY_INCIDENT_INVESTIGATION', acknowledgedByUserId: 'u1', acknowledgedAt: new Date(), personRetentionDays: 3 } });
    expect(on.personCropsEnabled).toBe(true);
  });
});
