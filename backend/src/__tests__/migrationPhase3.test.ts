/**
 * Migration test for 20260928000000_incident_workflow_notifications_camera_events on the real
 * database: new enum values, alarm workflow columns, uniqueness that makes the sweepers
 * idempotent, CHECK constraints on string-typed state columns and cascade behaviour.
 * (Schema/migration drift for the whole history is checked in migrationPhase2.test.ts.)
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera } from './helpers/realDb';

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';

async function alarm() {
  return prisma.alarm.create({ data: { tenantId, cameraId, title: 'mig3', severity: 'CRITICAL' } });
}
const violates = (p: Promise<unknown>) => expect(p).rejects.toThrow();

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'mig3'));
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('Phase 3 migration', () => {
  it('adds WHATSAPP/SMS channel types, CAMERA_ANALYTIC triggers and delivery-receipt columns', async () => {
    const ch = await prisma.notificationChannel.create({ data: { tenantId, name: 'wa', type: 'WHATSAPP', targetUrl: '+919800000001' } });
    await prisma.notificationChannel.create({ data: { tenantId, name: 'sms', type: 'SMS', targetUrl: '+919800000001' } });
    const a = await alarm();
    const job = await prisma.notificationJob.create({
      data: { tenantId, channelId: ch.id, alarmId: a.id, idempotencyKey: crypto.randomUUID(), payloadJson: {}, providerMessageId: 'wamid.X', escalationStep: 1 },
    });
    expect(job.escalationStep).toBe(1);
    const log = await prisma.notificationLog.create({
      data: { tenantId, channelId: ch.id, alarmId: a.id, status: 'DELIVERED', providerMessageId: 'wamid.X', deliveryStatus: 'SENT', deliveryUpdatedAt: new Date() },
    });
    expect(log.deliveryStatus).toBe('SENT');
    const rule = await prisma.automationRule.create({
      data: { tenantId, name: 'cam analytic', triggerType: 'CAMERA_ANALYTIC', triggerConfigJson: {}, conditionsJson: [], actionsJson: [] },
    });
    expect(rule.triggerType).toBe('CAMERA_ANALYTIC');
  });

  it('alarm workflow columns default to NULL', async () => {
    const a = await alarm();
    expect([a.assignedToUserId, a.ackDueAt, a.resolveDueAt, a.ackSlaBreachedAt, a.resolveSlaBreachedAt]).toEqual([null, null, null, null, null]);
  });

  it('one SLA policy per severity, positive minutes only', async () => {
    await prisma.alarmSlaPolicy.create({ data: { tenantId, severity: 'CRITICAL', ackWithinMinutes: 5, resolveWithinMinutes: 60 } });
    await violates(prisma.alarmSlaPolicy.create({ data: { tenantId, severity: 'CRITICAL', ackWithinMinutes: 10 } }));
    await violates(prisma.alarmSlaPolicy.create({ data: { tenantId, severity: 'WARNING', ackWithinMinutes: 0 } }));
  });

  it('an escalation step fires at most once per alarm (sweeper idempotency)', async () => {
    const pol = await prisma.escalationPolicy.create({ data: { tenantId, name: 'p', stepsJson: [{ afterMinutes: 0, channelIds: [] }] } });
    const a = await alarm();
    await prisma.alarmEscalation.create({ data: { alarmId: a.id, policyId: pol.id, stepIndex: 0, channelIds: [] } });
    await violates(prisma.alarmEscalation.create({ data: { alarmId: a.id, policyId: pol.id, stepIndex: 0, channelIds: [] } }));
    await violates(prisma.alarmEscalation.create({ data: { alarmId: a.id, policyId: pol.id, stepIndex: -1, channelIds: [] } }));
  });

  it('feedback: one verdict per alarm, only FALSE_ALARM or TRUE_ALARM, removed with the alarm', async () => {
    const a = await alarm();
    await violates(prisma.alarmFeedback.create({ data: { tenantId, alarmId: a.id, verdict: 'MAYBE', userId: 'u' } }));
    await prisma.alarmFeedback.create({ data: { tenantId, alarmId: a.id, verdict: 'FALSE_ALARM', userId: 'u' } });
    await violates(prisma.alarmFeedback.create({ data: { tenantId, alarmId: a.id, verdict: 'TRUE_ALARM', userId: 'u' } }));
    await prisma.alarm.delete({ where: { id: a.id } });
    expect(await prisma.alarmFeedback.count({ where: { alarmId: a.id } })).toBe(0);
  });

  it('evidence holds: one per alarm and camera, valid status and window', async () => {
    const a = await alarm();
    const t = Date.now();
    const base = { tenantId, alarmId: a.id, cameraId, windowStart: new Date(t - 60000), windowEnd: new Date(t + 60000), expiresAt: new Date(t + 86400000) };
    await prisma.incidentEvidenceHold.create({ data: base });
    await violates(prisma.incidentEvidenceHold.create({ data: base }));
    const a2 = await alarm();
    await violates(prisma.incidentEvidenceHold.create({ data: { ...base, alarmId: a2.id, status: 'DONE' } }));
    await violates(prisma.incidentEvidenceHold.create({ data: { ...base, alarmId: a2.id, windowEnd: base.windowStart } }));
  });

  it('camera event sources: one per camera and protocol, known protocols and states only', async () => {
    await prisma.cameraEventSource.create({ data: { tenantId, cameraId, protocol: 'ONVIF_PULLPOINT' } });
    await violates(prisma.cameraEventSource.create({ data: { tenantId, cameraId, protocol: 'ONVIF_PULLPOINT' } }));
    await violates(prisma.cameraEventSource.create({ data: { tenantId, cameraId, protocol: 'RTSP_METADATA' } }));
    await violates(prisma.cameraEventSource.create({ data: { tenantId, cameraId, protocol: 'HIKVISION_ISAPI', status: 'WEIRD' } }));
    await prisma.camera.delete({ where: { id: cameraId } });
    expect(await prisma.cameraEventSource.count({ where: { cameraId } })).toBe(0);
  });
});
