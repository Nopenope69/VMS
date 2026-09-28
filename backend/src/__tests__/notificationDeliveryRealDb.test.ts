/**
 * P3.3 notification delivery on the real database and the real Express app:
 * channel config validation and secret redaction, SMTP delivery through the notification queue
 * (in-process SMTP test double), WhatsApp Cloud API delivery against a clearly-labelled local
 * TEST DOUBLE (WHATSAPP_API_BASE_URL, honoured only under NODE_ENV=test), signed delivery
 * receipts, permanent failures to dead letter, retry from dead letter, air-gapped mode and the
 * per-dispatch audit trail.
 */
jest.mock('../config/licenseKeys', () => {
  // Test-only trust anchor: the vendor private key is never available to tests.
  const c = require('crypto');
  const kp = c.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { VENDOR_LICENSE_PUBLIC_KEY: kp.publicKey, TEST_LICENSE_PRIVATE_KEY: kp.privateKey };
});

import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { startSmtpTestServer } from './helpers/smtpTestServer';
import { signLicensePayload } from '../utils/license';
import { NotificationAdapter } from '../services/incident/orchestrator/adapters/notificationAdapter';
import { AuditChainService } from '../services/audit/auditChain.service';
import { MetricsService } from '../services/observability/metrics.service';

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();
const adapter = new NotificationAdapter(prisma);

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let token = '';

// ---- WhatsApp Cloud API TEST DOUBLE (never a real Meta endpoint) ----
const waRequests: Array<{ path: string; auth: string | undefined; body: any }> = [];
const waFailOnce = new Set<string>(['919800000003']);
let wa: http.Server;
let waSeq = 0;

function startWhatsAppDouble(): Promise<string> {
  wa = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      waRequests.push({ path: req.url || '', auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== 'Bearer EAAtest-access-token-000000') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }));
      }
      if (body.to === '919800000002') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: '(#131026) Message undeliverable', code: 131026 } }));
      }
      if (waFailOnce.has(body.to)) {
        waFailOnce.delete(body.to);
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }));
      }
      res.end(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.TESTDOUBLE${++waSeq}` }] }));
    });
  });
  return new Promise((r) => wa.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(wa.address() as net.AddressInfo).port}`)));
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.url}/api/v1/notifications${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* plain text (webhook challenge) */
  }
  return { status: res.status, json };
}

async function newAlarm(severity: 'WARNING' | 'CRITICAL' = 'CRITICAL') {
  return prisma.alarm.create({ data: { tenantId, cameraId, title: 'Intrusion at gate 2', description: 'Person crossed tripwire', severity } });
}

/** Runs the queue until the given jobs leave PENDING/PROCESSING or the budget is spent. */
async function drain(jobIds: string[], rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await adapter.processQueue();
    const left = await prisma.notificationJob.count({ where: { id: { in: jobIds }, status: { in: ['PENDING', 'PROCESSING'] }, OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] } });
    if (left === 0) return;
  }
}

beforeAll(async () => {
  process.env.WHATSAPP_API_BASE_URL = await startWhatsAppDouble();
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'notif'));
  ({ token } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  const claims = {
    licenseId: `lic_notif_${crypto.randomBytes(4).toString('hex')}`,
    tenantId,
    tier: 'ENTERPRISE',
    maxCameras: 16,
    features: ['NOTIFICATIONS'],
    issuedAt: new Date().toISOString(),
    expiresAt: null,
    kid: 'test-authority',
  } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({
    data: { tenantId, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['NOTIFICATIONS'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 },
  });
  app = await startApp();
});

afterAll(async () => {
  delete process.env.WHATSAPP_API_BASE_URL;
  delete process.env.VIGILONE_AIR_GAPPED;
  await app?.close();
  await new Promise<void>((r) => wa.close(() => r()));
  await prisma.$disconnect();
});

describe('channel configuration', () => {
  it('validates targets and config, stores secrets encrypted and never returns them', async () => {
    const bad = await api('POST', '/channels', { name: 'wa', type: 'WHATSAPP', targetUrl: '9800000001', configJson: {} });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/E\.164/);

    const badCfg = await api('POST', '/channels', { name: 'wa', type: 'WHATSAPP', targetUrl: '+919800000001', configJson: { phoneNumberId: '123456', accessToken: 'short', templateName: 'alarm_alert' } });
    expect(badCfg.status).toBe(400);
    expect(badCfg.json.error).toMatch(/accessToken/);

    const plainAuth = await api('POST', '/channels', {
      name: 'mail', type: 'EMAIL', targetUrl: 'ops@site.test',
      configJson: { smtpHost: 'mail.site.test', smtpPort: 25, security: 'none', username: 'u', password: 'p', from: 'a@site.test' },
    });
    expect(plainAuth.status).toBe(400);

    const ok = await api('POST', '/channels', {
      name: 'wa-ok', type: 'WHATSAPP', targetUrl: '+919800000001',
      configJson: { phoneNumberId: '1098765432', accessToken: 'EAAtest-access-token-000000', templateName: 'alarm_alert', appSecret: 'app-secret-0123456789', verifyToken: 'verify-token-0123456789' },
    });
    expect(ok.status).toBe(200);
    const text = JSON.stringify(ok.json);
    expect(text).not.toContain('EAAtest-access-token');
    expect(text).not.toContain('app-secret-0123456789');
    expect(ok.json.channel.configJson.accessTokenSet).toBe(true);

    const row = await prisma.notificationChannel.findUniqueOrThrow({ where: { id: ok.json.channel.id } });
    expect(JSON.stringify(row.configJson)).not.toContain('EAAtest-access-token');
    expect((row.configJson as any).accessTokenEncrypted).toBeDefined();

    // PATCH without the secret keeps the stored one; the audit entry names fields, not values.
    const patched = await api('PATCH', `/channels/${row.id}`, { configJson: { phoneNumberId: '1098765432', templateName: 'alarm_alert_v2' } });
    expect(patched.status).toBe(200);
    expect(patched.json.channel.configJson.templateName).toBe('alarm_alert_v2');
    expect(patched.json.channel.configJson.accessTokenSet).toBe(true);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'NOTIFICATION_CHANNEL_UPDATE', resourceId: row.id } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain('EAAtest');

    const list = await api('GET', '/channels');
    expect(JSON.stringify(list.json)).not.toContain('EAAtest-access-token');
    await prisma.notificationChannel.delete({ where: { id: row.id } });
  });
});

describe('email delivery through the queue', () => {
  it('delivers over SMTP, records the relay queue id as the receipt and audits the dispatch', async () => {
    const smtp = await startSmtpTestServer({ queueId: 'Q-REAL-42' });
    try {
      const ch = await api('POST', '/channels', {
        name: 'mail', type: 'EMAIL', targetUrl: 'ops@site.test, guard@site.test', minSeverity: 'WARNING',
        configJson: { smtpHost: '127.0.0.1', smtpPort: smtp.port, security: 'none', from: 'VigilOne <alerts@site.test>' },
      });
      expect(ch.status).toBe(200);
      const alarm = await newAlarm();
      const queued = await adapter.enqueueAlarmNotifications({ tenantId, alarmId: alarm.id, title: alarm.title, severity: 'CRITICAL', cameraName: 'Gate 2', channelIds: [ch.json.channel.id] });
      expect(queued).toBe(1);
      const job = await prisma.notificationJob.findFirstOrThrow({ where: { alarmId: alarm.id } });
      await drain([job.id]);

      const done = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(done.status).toBe('DELIVERED');
      expect(done.providerMessageId).toBe('Q-REAL-42');
      expect(smtp.mails).toHaveLength(1);
      expect(smtp.mails[0].to).toEqual(['ops@site.test', 'guard@site.test']);
      expect(smtp.mails[0].data).toContain(`X-VigilOne-Alarm: ${alarm.id}`);
      expect(smtp.mails[0].data).toContain('Subject: [VigilOne CRITICAL] Intrusion at gate 2');

      const log = await prisma.notificationLog.findFirstOrThrow({ where: { alarmId: alarm.id } });
      expect(log.providerMessageId).toBe('Q-REAL-42');
      expect(log.deliveryStatus).toBe('SENT');

      const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'NOTIFICATION_DISPATCH', resourceId: job.id } });
      expect(audit.userId).toBeNull();
      expect(MetricsService.getValue('vigilone_notification_dispatch_total', { channel_type: 'EMAIL', outcome: 'delivered' })).toBeGreaterThanOrEqual(1);
      await prisma.notificationChannel.update({ where: { id: ch.json.channel.id }, data: { enabled: false } });
    } finally {
      await smtp.close();
    }
  });

  it('the test endpoint reports the real SMTP failure instead of a 501', async () => {
    const ch = await api('POST', '/channels', {
      name: 'mail-dead', type: 'EMAIL', targetUrl: 'ops@site.test',
      configJson: { smtpHost: '127.0.0.1', smtpPort: 1, security: 'none', from: 'alerts@site.test' },
    });
    const r = await api('POST', `/channels/${ch.json.channel.id}/test`);
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(false);
    expect(r.json.error).toMatch(/SMTP connect/);
    expect(r.json.error).not.toMatch(/NOT_CONFIGURED/);
    await prisma.notificationChannel.update({ where: { id: ch.json.channel.id }, data: { enabled: false } });
  });
});

describe('WhatsApp delivery against the test double', () => {
  let channelId = '';
  const appSecret = 'app-secret-0123456789';

  beforeAll(async () => {
    const ch = await api('POST', '/channels', {
      name: 'wa', type: 'WHATSAPP', targetUrl: '+919800000001,+919800000003', minSeverity: 'WARNING',
      configJson: { phoneNumberId: '1098765432', accessToken: 'EAAtest-access-token-000000', templateName: 'alarm_alert', languageCode: 'en_US', appSecret, verifyToken: 'verify-token-0123456789' },
    });
    expect(ch.status).toBe(200);
    channelId = ch.json.channel.id;
  });

  it('sends one template per recipient, retries only the failed recipient and stores each wamid', async () => {
    const alarm = await newAlarm();
    await adapter.enqueueAlarmNotifications({ tenantId, alarmId: alarm.id, title: alarm.title, severity: 'CRITICAL', cameraName: 'Gate 2', channelIds: [channelId] });
    const job = await prisma.notificationJob.findFirstOrThrow({ where: { alarmId: alarm.id } });
    await adapter.processQueue();
    const afterFirst = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(afterFirst.status).toBe('PENDING'); // +919800000003 got a 503
    expect(afterFirst.attempts).toBe(1);
    await prisma.notificationJob.update({ where: { id: job.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
    await drain([job.id]);

    const done = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe('DELIVERED');
    const sentTo = waRequests.filter((r) => r.path === '/v21.0/1098765432/messages').map((r) => r.body.to);
    // 1st attempt: ...001 ok, ...003 503. Retry: only ...003 again. ...001 was never messaged twice.
    expect(sentTo.filter((t) => t === '919800000001')).toHaveLength(1);
    expect(sentTo.filter((t) => t === '919800000003')).toHaveLength(2);
    const req = waRequests.find((r) => r.body.to === '919800000001')!;
    expect(req.body.type).toBe('template');
    expect(req.body.template.name).toBe('alarm_alert');
    expect(req.body.template.language.code).toBe('en_US');
    expect(req.body.template.components[0].parameters.map((p: any) => p.text).slice(0, 3)).toEqual(['CRITICAL', 'Intrusion at gate 2', 'Gate 2']);

    const logs = await prisma.notificationLog.findMany({ where: { alarmId: alarm.id, status: 'DELIVERED' } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => /^wamid\.TESTDOUBLE\d+$/.test(l.providerMessageId || ''))).toBe(true);
  });

  it('verifies the webhook subscription token', async () => {
    const good = await fetch(`${app.url}/api/v1/notifications/whatsapp/webhook/${channelId}?hub.mode=subscribe&hub.verify_token=verify-token-0123456789&hub.challenge=12345`);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe('12345');
    const bad = await fetch(`${app.url}/api/v1/notifications/whatsapp/webhook/${channelId}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345`);
    expect(bad.status).toBe(403);
  });

  it('applies signed delivery receipts, rejects unsigned ones and never moves a receipt backwards', async () => {
    const log = await prisma.notificationLog.findFirstOrThrow({ where: { channelId, status: 'DELIVERED' } });
    const payload = (status: string, ts: number) => ({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { statuses: [{ id: log.providerMessageId, status, timestamp: String(ts), recipient_id: '919800000001' }] } }] }],
    });
    const post = (body: any, secret = appSecret) => {
      const raw = JSON.stringify(body);
      const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
      return fetch(`${app.url}/api/v1/notifications/whatsapp/webhook/${channelId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
    };
    const t = Math.floor(Date.now() / 1000);

    const forged = await post(payload('read', t), 'wrong-secret-000000000');
    expect(forged.status).toBe(401);
    expect((await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } })).deliveryStatus).toBe('SENT');

    expect((await post(payload('read', t + 5))).status).toBe(200);
    const stale = await post(payload('delivered', t + 2)); // arrives late
    expect(((await stale.json()) as any).applied).toBe(0);
    const after = await prisma.notificationLog.findUniqueOrThrow({ where: { id: log.id } });
    expect(after.deliveryStatus).toBe('READ');
    expect(after.deliveryUpdatedAt!.getTime()).toBe((t + 5) * 1000);
  });

  it('a permanent provider rejection goes straight to dead letter and can be retried by an admin', async () => {
    const ch = await api('POST', '/channels', {
      name: 'wa-bad', type: 'WHATSAPP', targetUrl: '+919800000002',
      configJson: { phoneNumberId: '1098765432', accessToken: 'EAAtest-access-token-000000', templateName: 'alarm_alert' },
    });
    const alarm = await newAlarm();
    await adapter.enqueueAlarmNotifications({ tenantId, alarmId: alarm.id, title: alarm.title, severity: 'CRITICAL', channelIds: [ch.json.channel.id] });
    const job = await prisma.notificationJob.findFirstOrThrow({ where: { alarmId: alarm.id } });
    await drain([job.id]);
    const dead = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(dead.status).toBe('DEAD_LETTER');
    expect(dead.attempts).toBe(1); // no retries for a 4xx
    expect(dead.error).toMatch(/131026/);

    const view = await api('GET', '/dead-letters');
    expect(view.json.jobs.map((j: any) => j.id)).toContain(job.id);

    const retry = await api('POST', `/jobs/${job.id}/retry`);
    expect(retry.status).toBe(200);
    const again = await api('POST', `/jobs/${job.id}/retry`);
    expect(again.status).toBe(409);
    const requeued = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(requeued.status).toBe('PENDING');
    expect(requeued.attempts).toBe(0);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'NOTIFICATION_JOB_RETRY', resourceId: job.id } });
    await prisma.notificationChannel.update({ where: { id: ch.json.channel.id }, data: { enabled: false } });
    await prisma.notificationJob.delete({ where: { id: job.id } });
  });

  it('air-gapped mode blocks internet channels and dead-letters them without calling out', async () => {
    const before = waRequests.length;
    process.env.VIGILONE_AIR_GAPPED = 'true';
    try {
      const alarm = await newAlarm();
      await adapter.enqueueAlarmNotifications({ tenantId, alarmId: alarm.id, title: alarm.title, severity: 'CRITICAL', channelIds: [channelId] });
      const job = await prisma.notificationJob.findFirstOrThrow({ where: { alarmId: alarm.id } });
      await drain([job.id]);
      const dead = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(dead.status).toBe('DEAD_LETTER');
      expect(dead.error).toMatch(/AIR_GAPPED_CHANNEL_BLOCKED/);
      expect(waRequests.length).toBe(before);
    } finally {
      delete process.env.VIGILONE_AIR_GAPPED;
    }
  });

  it('the tenant audit chain still verifies after all dispatches', async () => {
    const result: any = await AuditChainService.verifyChain(prisma as any, tenantId);
    expect(result.valid).toBe(true);
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'NOTIFICATION_DISPATCH' } })).toBeGreaterThanOrEqual(4);
  });
});
