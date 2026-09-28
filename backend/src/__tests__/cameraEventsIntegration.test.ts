/**
 * P3.1 / P3.2 end to end over real HTTP against local protocol TEST DOUBLES
 * (helpers/cameraStubs.ts): Digest-authenticated Hikvision and Dahua multipart streams, the ONVIF
 * PullPoint exchange with WS-Security against an offset camera clock, then the
 * CameraEventManager on the real database feeding the rule engine, and the flag-gated routes.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { startMultipartCameraStub, startOnvifStub } from './helpers/cameraStubs';
import { HikvisionAlertStream } from '../services/cameraEvents/hikvision';
import { DahuaEventStream } from '../services/cameraEvents/dahua';
import { OnvifPullPointClient } from '../services/cameraEvents/onvif/pullPoint';
import { OnvifFault } from '../services/cameraEvents/onvif/soap';
import { CameraHttpError } from '../services/cameraEvents/httpDigest';
import { CameraEventManager } from '../services/cameraEvents/cameraEventManager.service';
import { IncidentOrchestrator } from '../services/incident/orchestrator/incidentOrchestrator.service';
import { markAutomationRulesChanged } from '../services/automation/ruleCache';
import { encryptCredential } from '../utils/crypto';
import fs from 'fs';
import path from 'path';

const fx = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'camera-events', f), 'utf8');
const prisma = new PrismaClient();
jest.setTimeout(20000);
const waitFor = async (cond: () => Promise<boolean> | boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
};

const hikParts = [
  { contentType: 'application/xml; charset="UTF-8"', body: fx('hikvision-videoloss-heartbeat.xml') },
  { contentType: 'application/xml; charset="UTF-8"', body: fx('hikvision-fielddetection-active.xml') },
  { contentType: 'application/xml; charset="UTF-8"', body: fx('hikvision-fielddetection-active.xml').replace('<activePostCount>1', '<activePostCount>2') },
  { contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0d, 0x0a]) },
  { contentType: 'application/xml; charset="UTF-8"', body: fx('hikvision-fielddetection-inactive.xml') },
];

afterAll(async () => {
  await prisma.$disconnect();
});

describe('protocol clients against test doubles', () => {
  it('Hikvision: Digest auth, heartbeats, events and skipped image parts', async () => {
    const stub = await startMultipartCameraStub({ path: '/ISAPI/Event/notification/alertStream', user: 'admin', pass: 'hik-pass-1', contentType: 'multipart/mixed; boundary=boundary', boundary: 'boundary', parts: hikParts });
    const c = new HikvisionAlertStream({ baseUrl: `http://127.0.0.1:${stub.port}`, credentials: { username: 'admin', password: 'hik-pass-1' } });
    const events: any[] = [];
    let heartbeats = 0;
    c.on('event', (e) => events.push(e));
    c.on('heartbeat', () => heartbeats++);
    const run = c.start();
    run.catch(() => undefined);
    try {
      await waitFor(() => events.length === 3);
    } finally {
      c.stop();
      await run.catch(() => undefined);
      await stub.close();
    }
    expect(heartbeats).toBe(1);
    expect(events.map((e) => [e.analyticType, e.state])).toEqual([['INTRUSION', true], ['INTRUSION', true], ['INTRUSION', false]]);
    expect(stub.requests).toEqual([expect.stringContaining('auth=no'), expect.stringContaining('auth=yes')]);
  });

  it('Hikvision: a wrong password is a permanent 401', async () => {
    const stub = await startMultipartCameraStub({ path: '/ISAPI', user: 'admin', pass: 'right', contentType: 'multipart/mixed; boundary=b', boundary: 'b', parts: [] });
    const err = await new HikvisionAlertStream({ baseUrl: `http://127.0.0.1:${stub.port}`, credentials: { username: 'admin', password: 'wrong' } }).start().catch((e) => e);
    await stub.close();
    expect(err).toBeInstanceOf(CameraHttpError);
    expect(err.statusCode).toBe(401);
    expect(err.permanent).toBe(true);
  });

  it('Dahua: x-mixed-replace parts without Content-Length', async () => {
    const stub = await startMultipartCameraStub({
      path: '/cgi-bin/eventManager.cgi', user: 'admin', pass: 'dh-pass', contentType: 'multipart/x-mixed-replace; boundary=myboundary', boundary: 'myboundary',
      parts: ['dahua-heartbeat.txt', 'dahua-crossline-start.txt', 'dahua-crossline-stop.txt'].map((f) => ({ contentType: 'text/plain', body: fx(f), withLength: false })),
    });
    const c = new DahuaEventStream({ baseUrl: `http://127.0.0.1:${stub.port}`, credentials: { username: 'admin', password: 'dh-pass' } });
    const events: any[] = [];
    let hb = 0;
    c.on('event', (e) => events.push(e));
    c.on('heartbeat', () => hb++);
    const run = c.start();
    run.catch(() => undefined);
    try {
      // Without Content-Length a part ends at the next delimiter; the stub keeps the stream open,
      // so the last part waits for the next delimiter, as on a device.
      await waitFor(() => events.length >= 1 && hb === 1);
    } finally {
      c.stop();
      await run.catch(() => undefined);
      await stub.close();
    }
    expect(events[0]).toMatchObject({ analyticType: 'LINE_CROSSING', state: true, ruleName: 'Gate; north' });
    expect(stub.requests[1]).toContain('codes=%5BAll%5D&heartbeat=5');
  });

  it('ONVIF: measures skew, signs tokens in camera time, rebases NAT addresses, pulls, renews and unsubscribes', async () => {
    const stub: any = await startOnvifStub({ user: 'onvif', pass: 'onvif-pass', clockOffsetMs: 5000, notifications: [] });
    const c = new OnvifPullPointClient({ deviceServiceUrl: `http://127.0.0.1:${stub.port}/onvif/device_service`, credentials: { username: 'onvif', password: 'onvif-pass' }, pullTimeoutSeconds: 1 });
    const events: any[] = [];
    let skew: any = null;
    c.on('event', (e) => events.push(e));
    c.on('skew', (s) => (skew = s));
    let connected = false;
    c.on('connected', () => (connected = true));
    const run = c.start();
    run.catch(() => undefined);
    try {
      await waitFor(() => connected);
      const msgs = fx('onvif-pullmessages-response.xml').match(/<wsnt:NotificationMessage>[\s\S]*?<\/wsnt:NotificationMessage>/g)!;
      msgs.forEach((m: string) => stub.push(m));
      await waitFor(() => events.length === 3);
      c.stop();
      await run;
    } finally {
      c.stop();
      await stub.close();
    }
    expect(skew.verdict).toBe('DRIFT');
    expect(skew.lowerMs).toBeGreaterThan(3900);
    expect(skew.upperMs).toBeLessThan(6200);
    expect(events.map((e) => e.analyticType)).toEqual(['INTRUSION', 'LINE_CROSSING', 'DIGITAL_INPUT']);
    // Requests reached the configured host even though the camera advertised 192.168.1.64.
    expect(stub.requests).toEqual(expect.arrayContaining(['/onvif/device_service GetSystemDateAndTime', '/onvif/event_service CreatePullPointSubscription', '/onvif/subscription/1 PullMessages', '/onvif/subscription/1 Renew']));
    expect(stub.unsubscribed).toBe(true);
  });

  it('ONVIF: without the skew correction the same camera rejects the token (NOT_AUTHORIZED, permanent)', async () => {
    const stub: any = await startOnvifStub({ user: 'onvif', pass: 'onvif-pass', clockOffsetMs: 5000, notifications: [] });
    const c = new OnvifPullPointClient({ deviceServiceUrl: `http://127.0.0.1:${stub.port}/onvif/device_service`, credentials: { username: 'onvif', password: 'onvif-pass' } });
    const err = await c.eventServiceUrl().catch((e) => e);
    await stub.close();
    expect(err).toBeInstanceOf(OnvifFault);
    expect(err.code).toBe('NOT_AUTHORIZED');
    expect(err.permanent).toBe(true);
  });
});

describe('CameraEventManager on the real database', () => {
  let tenantId = '';
  let cameraId = '';
  let app: { url: string; close: () => Promise<void> };
  let token = '';
  const orchestrator = new IncidentOrchestrator(prisma);

  beforeAll(async () => {
    ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'camev'));
    ({ token } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
    app = await startApp();
  });
  afterAll(async () => {
    delete process.env.VIGILONE_FEATURE_CAMERA_EVENTS;
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    await app.close();
  });

  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`${app.url}/api/v1/camera-events${p}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };

  it('routes are 501 FEATURE_DISABLED while the flag is off', async () => {
    delete process.env.VIGILONE_FEATURE_CAMERA_EVENTS;
    const r = await api('GET', '/sources');
    expect(r.status).toBe(501);
    expect(r.json.code).toBe('FEATURE_DISABLED');
  });

  it('streams a Hikvision camera into CAMERA_ANALYTIC events, one per transition, and fires the rule once', async () => {
    process.env.VIGILONE_FEATURE_CAMERA_EVENTS = 'true';
    const stub = await startMultipartCameraStub({ path: '/ISAPI/Event/notification/alertStream', user: 'admin', pass: 'hik-pass-1', contentType: 'multipart/mixed; boundary=boundary', boundary: 'boundary', parts: hikParts });
    await prisma.camera.update({ where: { id: cameraId }, data: { onvifPort: stub.port, encryptedAuth: encryptCredential(JSON.stringify({ username: 'admin', password: 'hik-pass-1' })) } });
    await prisma.automationRule.create({
      data: { tenantId, name: 'cam intrusion', triggerType: 'CAMERA_ANALYTIC', triggerConfigJson: { analyticTypes: ['INTRUSION'] }, conditionsJson: [], actionsJson: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }], cooldownSeconds: 0 },
    });
    markAutomationRulesChanged();

    const created = await api('POST', '/sources', { cameraId, protocol: 'HIKVISION_ISAPI' });
    expect(created.status).toBe(201);
    expect((await api('POST', '/sources', { cameraId, protocol: 'HIKVISION_ISAPI' })).status).toBe(409);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'CAMERA_EVENT_SOURCE_CREATE' } });

    const manager = new CameraEventManager(prisma, (ev) => orchestrator.ingestEvent(ev), undefined, 50);
    await manager.reconcile();
    try {
      await waitFor(async () => (await prisma.canonicalEvent.count({ where: { cameraId, type: 'CAMERA_ANALYTIC' } })) === 2);
      await new Promise((r) => setTimeout(r, 300)); // nothing more may arrive
      const evs = await prisma.canonicalEvent.findMany({ where: { cameraId, type: 'CAMERA_ANALYTIC' }, orderBy: { timestampUtc: 'asc' } });
      expect(evs.map((e) => [(e.payloadJson as any).payload.analyticType, (e.payloadJson as any).payload.state])).toEqual([['INTRUSION', true], ['INTRUSION', false]]);
      expect((evs[0].payloadJson as any).payload.cameraTimeUtc).toBe('2026-09-27T10:00:12.000Z');
      expect(evs[0].source).toBe('CAMERA_ANALYTICS');
      expect(await prisma.ruleExecutionRecord.count({ where: { tenantId } })).toBe(1);
      const src = await prisma.cameraEventSource.findUniqueOrThrow({ where: { id: created.json.source.id } });
      expect(src.status).toBe('RUNNING');
      expect(src.lastEventAt).not.toBeNull();
    } finally {
      await manager.stop();
      await stub.close();
    }
  });

  it('bad credentials put the source in FAILED without retry storms; re-enabling retries it', async () => {
    const stub = await startMultipartCameraStub({ path: '/cgi-bin/eventManager.cgi', user: 'admin', pass: 'other', contentType: 'multipart/x-mixed-replace; boundary=myboundary', boundary: 'myboundary', parts: [] });
    await prisma.cameraEventSource.deleteMany({ where: { cameraId } });
    await prisma.camera.update({ where: { id: cameraId }, data: { onvifPort: stub.port } });
    const created = await api('POST', '/sources', { cameraId, protocol: 'DAHUA_EVENT_MANAGER' });
    const manager = new CameraEventManager(prisma, (ev) => orchestrator.ingestEvent(ev), undefined, 50);
    await manager.reconcile();
    try {
      await waitFor(async () => (await prisma.cameraEventSource.findUniqueOrThrow({ where: { id: created.json.source.id } })).status === 'FAILED');
      const src = await prisma.cameraEventSource.findUniqueOrThrow({ where: { id: created.json.source.id } });
      expect(src.lastError).toMatch(/401/);
      const n = stub.requests.length;
      await manager.reconcile();
      await new Promise((r) => setTimeout(r, 300));
      expect(stub.requests.length).toBe(n);
      const listed = await api('GET', '/sources');
      expect(listed.json.sources[0]).toMatchObject({ status: 'FAILED', protocol: 'DAHUA_EVENT_MANAGER' });
      const patched = await api('PATCH', `/sources/${created.json.source.id}`, { enabled: true });
      expect(patched.json.source.status).toBe('STOPPED');
      await manager.reconcile();
      await waitFor(() => stub.requests.length > n);
    } finally {
      await manager.stop();
      await stub.close();
    }
  });
});
