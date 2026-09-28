/**
 * P3.4 incident workflow on the real database and the real Express app: assignment, SLA
 * deadlines and breaches, escalation steps (queued through the real notification queue to an
 * in-process SMTP test double), automatic INCIDENT_HOLD pins for CRITICAL alarms and the
 * one-click export built from real ffmpeg-generated segments.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

// Exports and recordings go to a throwaway directory (config/env reads these on first import).
const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-workflow-'));
process.env.RECORDINGS_DIR = path.join(mediaDir, 'recordings');
process.env.EXPORTS_DIR = path.join(mediaDir, 'exports');
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { startSmtpTestServer } from './helpers/smtpTestServer';

const prisma = new PrismaClient();
let app: { url: string; close: () => Promise<void> };
let workflow: any;
let adapter: any;
let tenantId = '';
let cameraId = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
let viewer = { userId: '', token: '' };
let smtp: Awaited<ReturnType<typeof startSmtpTestServer>>;
const cleanupTenants: string[] = [];
const MIN = 60_000;

async function api(method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(`${app.url}/api/v1/alarms${p}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function alarm(severity: 'WARNING' | 'CRITICAL', over: Record<string, any> = {}) {
  return prisma.alarm.create({ data: { tenantId, cameraId, title: `wf ${severity}`, severity, ...over } });
}

beforeAll(async () => {
  const { AlarmWorkflowService } = require('../services/incident/workflow/alarmWorkflow.service');
  const { NotificationAdapter } = require('../services/incident/orchestrator/adapters/notificationAdapter');
  adapter = new NotificationAdapter(prisma);
  workflow = new AlarmWorkflowService(prisma, adapter, undefined, {
    holdPreSeconds: 5, holdPostSeconds: 5, holdDays: 30, holdFinalizeGraceSeconds: 10, holdLookbackHours: 24,
  });
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'wf'));
  cleanupTenants.push(tenantId);
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  viewer = await createUserWithToken(prisma, tenantId, 'VIEWER');
  smtp = await startSmtpTestServer();
  app = await startApp();
});

afterAll(async () => {
  // Pinned segments count against appliance-wide export admission control: never leave them behind.
  for (const id of cleanupTenants) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await smtp?.close();
  await prisma.$disconnect();
  fs.rmSync(mediaDir, { recursive: true, force: true });
});

describe('assignment', () => {
  it('assigns to an operator, refuses viewers and other tenants, and audits both ways', async () => {
    const a = await alarm('WARNING');
    const bad = await api('POST', `/${a.id}/assign`, admin.token, { userId: viewer.userId });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/cannot manage alarms/);

    const other = await createTenantWithCamera(prisma, 'wf-other');
    cleanupTenants.push(other.tenantId);
    const stranger = await createUserWithToken(prisma, other.tenantId, 'OPERATOR');
    expect((await api('POST', `/${a.id}/assign`, admin.token, { userId: stranger.userId })).status).toBe(400);
    expect((await api('POST', `/${a.id}/assign`, stranger.token, { userId: stranger.userId })).status).toBe(404);

    const ok = await api('POST', `/${a.id}/assign`, admin.token, { userId: operator.userId });
    expect(ok.status).toBe(200);
    expect(ok.json.alarm.assignedToUserId).toBe(operator.userId);
    expect((await api('POST', `/${a.id}/assign`, operator.token, { userId: null })).json.alarm.assignedToUserId).toBeNull();
    const actions = (await prisma.auditEvent.findMany({ where: { tenantId, resourceId: a.id }, orderBy: { sequenceNumber: 'asc' } })).map((e) => e.action);
    expect(actions).toEqual(['ALARM_ASSIGN', 'ALARM_UNASSIGN']);
  });
});

describe('SLA', () => {
  it('stamps deadlines from the policy (not retroactively) and records each breach once', async () => {
    const before = await alarm('CRITICAL');
    expect((await api('PUT', '/policies/sla', operator.token, { severity: 'CRITICAL', ackWithinMinutes: 5 })).status).toBe(403);
    expect((await api('PUT', '/policies/sla', admin.token, { severity: 'CRITICAL', ackWithinMinutes: 0 })).status).toBe(400);
    const put = await api('PUT', '/policies/sla', admin.token, { severity: 'CRITICAL', ackWithinMinutes: 5, resolveWithinMinutes: 30 });
    expect(put.status).toBe(200);

    const a = await alarm('CRITICAL');
    await workflow.sweep(new Date());
    const stamped = await prisma.alarm.findUniqueOrThrow({ where: { id: a.id } });
    expect(stamped.ackDueAt!.getTime()).toBe(a.triggeredAt.getTime() + 5 * MIN);
    expect(stamped.resolveDueAt!.getTime()).toBe(a.triggeredAt.getTime() + 30 * MIN);
    expect((await prisma.alarm.findUniqueOrThrow({ where: { id: before.id } })).ackDueAt).toBeNull();

    const late = new Date(a.triggeredAt.getTime() + 6 * MIN);
    await workflow.sweep(late);
    await workflow.sweep(late);
    const breached = await prisma.alarm.findUniqueOrThrow({ where: { id: a.id } });
    expect(breached.ackSlaBreachedAt!.getTime()).toBe(late.getTime());
    expect(breached.resolveSlaBreachedAt).toBeNull();
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'ALARM_SLA_BREACHED', resourceId: a.id } })).toBe(1);
  });
});

describe('escalation', () => {
  let ch1 = '';
  let ch2 = '';
  beforeAll(async () => {
    const mk = (name: string, to: string) =>
      prisma.notificationChannel.create({
        data: { tenantId, name, type: 'EMAIL', targetUrl: to, minSeverity: 'INFO', configJson: { smtpHost: '127.0.0.1', smtpPort: smtp.port, security: 'none', from: 'alerts@site.test' } },
      });
    ch1 = (await mk('shift lead', 'lead@site.test')).id;
    ch2 = (await mk('site manager', 'manager@site.test')).id;
  });

  it('validates policies', async () => {
    const bad1 = await api('POST', '/policies/escalation', admin.token, { name: 'p', steps: [{ afterMinutes: 10, channelIds: [ch1] }, { afterMinutes: 5, channelIds: [ch2] }] });
    expect(bad1.status).toBe(400);
    const bad2 = await api('POST', '/policies/escalation', admin.token, { name: 'p', steps: [{ afterMinutes: 0, channelIds: [crypto.randomUUID()] }] });
    expect(bad2.status).toBe(400);
    expect(bad2.json.error).toMatch(/this tenant/);
  });

  it('fires each step once, in time, through the notification queue; acknowledging stops it', async () => {
    const created = await api('POST', '/policies/escalation', admin.token, {
      name: 'night shift', minSeverity: 'CRITICAL', steps: [{ afterMinutes: 0, channelIds: [ch1] }, { afterMinutes: 10, channelIds: [ch2] }],
    });
    expect(created.status).toBe(201);
    const a = await alarm('CRITICAL');
    const acked = await alarm('CRITICAL');
    const warning = await alarm('WARNING');

    await workflow.sweep(new Date(a.triggeredAt.getTime() + 1000));
    await workflow.sweep(new Date(a.triggeredAt.getTime() + 2000));
    let esc = await prisma.alarmEscalation.findMany({ where: { alarmId: a.id } });
    expect(esc.map((e) => e.stepIndex)).toEqual([0]);
    expect(esc[0].notificationsQueued).toBe(1);
    expect(await prisma.alarmEscalation.count({ where: { alarmId: warning.id } })).toBe(0);

    await prisma.alarm.update({ where: { id: acked.id }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: new Date() } });
    await workflow.sweep(new Date(a.triggeredAt.getTime() + 11 * MIN));
    esc = await prisma.alarmEscalation.findMany({ where: { alarmId: a.id }, orderBy: { stepIndex: 'asc' } });
    expect(esc.map((e) => e.stepIndex)).toEqual([0, 1]);
    expect((await prisma.alarmEscalation.findMany({ where: { alarmId: acked.id } })).map((e) => e.stepIndex)).toEqual([0]);

    const jobs = await prisma.notificationJob.findMany({ where: { alarmId: a.id }, orderBy: { escalationStep: 'asc' } });
    expect(jobs.map((j) => [j.channelId, j.escalationStep])).toEqual([[ch1, 0], [ch2, 1]]);
    for (let i = 0; i < 3; i++) await adapter.processQueue();
    const delivered = await prisma.notificationJob.findMany({ where: { alarmId: a.id } });
    expect(delivered.every((j) => j.status === 'DELIVERED')).toBe(true);
    const sent = smtp.mails.filter((m) => m.data.includes(`X-VigilOne-Alarm: ${a.id}`));
    expect(sent.map((m) => m.to[0]).sort()).toEqual(['lead@site.test', 'manager@site.test']);
    expect(sent.some((m) => Buffer.from(m.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString().includes('Escalation step: 1'))).toBe(true);
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'ALARM_ESCALATED', resourceId: a.id } })).toBe(2);
    await prisma.escalationPolicy.update({ where: { id: created.json.policy.id }, data: { enabled: false } });
  });
});

describe('evidence holds and one-click export', () => {
  function makeSegment(name: string): { file: string; sha: string; size: number } {
    const file = path.join(process.env.RECORDINGS_DIR!, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '4', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p', '-f', 'mp4', file]);
    const buf = fs.readFileSync(file);
    return { file, sha: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }

  it('pins every segment in the window of a CRITICAL alarm with INCIDENT_HOLD and closes the hold', async () => {
    const t0 = Date.now();
    const a = await alarm('CRITICAL', { triggeredAt: new Date(t0) });
    const segs = [];
    for (const [i, off] of [[0, -6000], [1, -2000], [2, 2000]] as const) {
      const s = makeSegment(`wf_${a.id}_${i}.mp4`);
      segs.push(
        await prisma.recordingSegment.create({
          data: { tenantId, cameraId, filePath: s.file, startTime: new Date(t0 + off), endTime: new Date(t0 + off + 4000), durationMs: 4000, sizeBytes: BigInt(s.size), sha256Hash: s.sha },
        })
      );
    }
    // Outside the [-5 s, +5 s] window: must not be pinned.
    const outside = await prisma.recordingSegment.create({
      data: { tenantId, cameraId, filePath: path.join(mediaDir, `outside_${a.id}.mp4`), startTime: new Date(t0 + 60000), endTime: new Date(t0 + 64000), durationMs: 4000, sizeBytes: BigInt(1) },
    });
    const warn = await alarm('WARNING', { triggeredAt: new Date(t0) });

    const r1 = await workflow.sweep(new Date(t0 + 1000));
    expect(r1.holdsCreated).toBeGreaterThanOrEqual(1);
    const hold = await prisma.incidentEvidenceHold.findUniqueOrThrow({ where: { alarmId_cameraId: { alarmId: a.id, cameraId } } });
    expect(hold.status).toBe('PENDING'); // window still open
    expect(hold.windowStart.getTime()).toBe(t0 - 5000);
    expect(await prisma.incidentEvidenceHold.count({ where: { alarmId: warn.id } })).toBe(0);

    await workflow.sweep(new Date(t0 + 16000));
    const done = await prisma.incidentEvidenceHold.findUniqueOrThrow({ where: { id: hold.id } });
    expect(done.status).toBe('COMPLETE');
    expect(done.segmentsPinned).toBe(3);
    const pins = await prisma.evidencePin.findMany({ where: { exportJobId: `incident-hold:${hold.id}` } });
    expect(pins.map((p) => p.segmentId).sort()).toEqual(segs.map((s) => s.id).sort());
    expect(pins.every((p) => p.pinType === 'INCIDENT_HOLD' && p.releasedAt === null)).toBe(true);
    expect(await prisma.evidencePin.count({ where: { segmentId: outside.id } })).toBe(0);
    await workflow.sweep(new Date(t0 + 17000));
    expect(await prisma.evidencePin.count({ where: { exportJobId: `incident-hold:${hold.id}` } })).toBe(3);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'INCIDENT_HOLD_APPLIED', resourceId: a.id } });

    const { EvidencePinRegistry } = require('../services/recording/catalog/evidencePinRegistry');
    expect(await new EvidencePinRegistry(prisma).isPinned(segs[0].id)).toBe(true);

    const holds = await api('GET', `/${a.id}/holds`, viewer.token);
    expect(holds.json.holds[0].status).toBe('COMPLETE');

    // One-click export over the hold window, from real segments, through the signed package path.
    expect((await api('POST', `/${a.id}/export`, viewer.token)).status).toBe(403);
    const exp = await api('POST', `/${a.id}/export`, operator.token);
    expect(exp.status).toBe(201);
    expect(exp.json.window.source).toBe('INCIDENT_HOLD');
    expect(fs.existsSync(path.join(process.env.EXPORTS_DIR!, exp.json.filename))).toBe(true);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'ALARM_EVIDENCE_EXPORT', resourceId: a.id } });
    expect((audit.metadataJson as any).holdId).toBe(hold.id);
  }, 60000);

  it('a hold whose window has no recording fails visibly instead of claiming success', async () => {
    const t0 = Date.now() - 3600_000;
    const a = await alarm('CRITICAL', { triggeredAt: new Date(t0) });
    await workflow.sweep(new Date());
    const hold = await prisma.incidentEvidenceHold.findUniqueOrThrow({ where: { alarmId_cameraId: { alarmId: a.id, cameraId } } });
    expect(hold.status).toBe('FAILED');
    expect(hold.lastError).toMatch(/NO_RECORDING_SEGMENTS_IN_WINDOW/);
    const exp = await api('POST', `/${a.id}/export`, operator.token);
    expect(exp.status).toBe(404);
    expect(exp.json.code).toBe('NO_RECORDING_SEGMENTS_FOUND');
  });

  it('an alarm without a camera cannot be exported', async () => {
    const a = await prisma.alarm.create({ data: { tenantId, title: 'storage', severity: 'CRITICAL' } });
    const exp = await api('POST', `/${a.id}/export`, operator.token);
    expect(exp.status).toBe(409);
    expect(exp.json.code).toBe('ALARM_HAS_NO_CAMERA');
  });

  it('the audit chain verifies', async () => {
    const { AuditChainService } = require('../services/audit/auditChain.service');
    expect((await AuditChainService.verifyChain(prisma, tenantId)).valid).toBe(true);
  });
});
