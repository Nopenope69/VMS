/**
 * Camera registry on the real database and the real API.
 *
 *  - Tenant boundary: another tenant's camera, zone, preset or guard tour is "not found" on every route.
 *    Before the registry, zone update/delete/test, tour stop/delete and the diagnostic probe never checked the
 *    tenant, and tour start never checked that the tour belonged to the camera.
 *  - Onboarding is all-or-nothing: when the media engine refuses the stream, no camera row is left behind.
 *  - Nothing is invented: no diagnostic measurement means `diagnostic: null`; a preset the camera did not save
 *    is an error, not a preset with a made-up token.
 */
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { CameraRegistry, CameraNotFoundError } from '../services/camera/cameraRegistry';

jest.setTimeout(60000);

describe('camera registry (real database, real API)', () => {
  const prisma = new PrismaClient();
  let app: { url: string; close: () => Promise<void> };
  let a: { tenantId: string; cameraId: string };
  let a2CameraId = '';
  let b: { tenantId: string; cameraId: string };
  let adminA = '';
  let adminB = '';
  let zoneA = '';
  let presetA = '';
  let tourA = '';

  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(`${app.url}/api/v1/cameras${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };

  beforeAll(async () => {
    app = await startApp();
    a = await createTenantWithCamera(prisma, 'camreg-a');
    b = await createTenantWithCamera(prisma, 'camreg-b');
    const site = await prisma.site.findFirstOrThrow({ where: { tenantId: a.tenantId } });
    a2CameraId = (await prisma.camera.create({ data: { tenantId: a.tenantId, siteId: site.id, name: 'a second', streamPath: `a2_${Date.now()}`, ipAddress: '127.0.0.1', mainRtspUri: 'rtsp://127.0.0.1:8554/a2' } })).id;
    adminA = (await createUserWithToken(prisma, a.tenantId, 'TENANT_ADMIN')).token;
    adminB = (await createUserWithToken(prisma, b.tenantId, 'TENANT_ADMIN')).token;
    zoneA = (await prisma.detectionZone.create({ data: { tenantId: a.tenantId, cameraId: a.cameraId, name: 'gate', type: 'INCLUSION', priority: 1, polygonCoordinates: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] } })).id;
    presetA = (await prisma.ptzPreset.create({ data: { tenantId: a.tenantId, cameraId: a.cameraId, name: 'door', presetToken: 'tok-1' } })).id;
    tourA = (await prisma.ptzTour.create({ data: { tenantId: a.tenantId, cameraId: a.cameraId, name: 'night', state: 'RUNNING', stepsJson: [{ presetId: presetA, dwellSeconds: 5 }] } })).id;
  });

  afterAll(async () => {
    await app.close();
    for (const t of [a.tenantId, b.tenantId]) await prisma.tenant.delete({ where: { id: t } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it("refuses another tenant's camera, zone, preset and tour on every route, and changes nothing", async () => {
    const c = a.cameraId;
    const attempts: Array<[string, string, unknown?]> = [
      ['POST', `/${c}/media-token`],
      ['GET', `/${c}/zones`],
      ['PUT', `/${c}/zones/${zoneA}`, { name: 'hijacked' }],
      ['DELETE', `/${c}/zones/${zoneA}`],
      ['POST', `/${c}/zones/test`, { point: { x: 0.5, y: 0.5 } }],
      ['GET', `/${c}/ptz/presets`],
      ['DELETE', `/${c}/ptz/presets/${presetA}`],
      ['POST', `/${c}/ptz/tours/${tourA}/stop`],
      ['DELETE', `/${c}/ptz/tours/${tourA}`],
      ['GET', `/${c}/schedule`],
      ['GET', `/${c}/diagnostic`],
      ['POST', `/${c}/diagnostic/probe`],
      ['DELETE', `/${c}`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await call(adminB, method, path, body);
      expect([method, path, r.status]).toEqual([method, path, 404]);
    }
    expect((await prisma.detectionZone.findUnique({ where: { id: zoneA } }))?.name).toBe('gate');
    expect(await prisma.ptzPreset.count({ where: { id: presetA } })).toBe(1);
    expect(await prisma.ptzTour.findUnique({ where: { id: tourA } })).toMatchObject({ name: 'night', state: 'RUNNING' });
    expect(await prisma.camera.count({ where: { id: c } })).toBe(1);
  });

  it("does not reach another tenant's zone through the caller's own camera id", async () => {
    const r = await call(adminB, 'PUT', `/${b.cameraId}/zones/${zoneA}`, { name: 'hijacked' });
    expect(r.status).toBe(404);
    expect((await prisma.detectionZone.findUnique({ where: { id: zoneA } }))?.name).toBe('gate');
  });

  it('refuses a tour or preset through a different camera of the same tenant', async () => {
    expect((await call(adminA, 'POST', `/${a2CameraId}/ptz/tours/${tourA}/start`)).status).toBe(404);
    expect((await call(adminA, 'DELETE', `/${a2CameraId}/ptz/presets/${presetA}`)).status).toBe(404);
    expect(await prisma.ptzPreset.count({ where: { id: presetA } })).toBe(1);
  });

  it('serves the owner normally', async () => {
    const zones = await call(adminA, 'GET', `/${a.cameraId}/zones`);
    expect(zones.status).toBe(200);
    expect(zones.json.zones.map((z: any) => z.id)).toEqual([zoneA]);
    const upd = await call(adminA, 'PUT', `/${a.cameraId}/zones/${zoneA}`, { name: 'main gate' });
    expect(upd.status).toBe(200);
    expect(upd.json.zone).toMatchObject({ name: 'main gate', version: 2 });
    const list = await call(adminA, 'GET', '');
    expect(list.json.cameras.map((x: any) => x.id).sort()).toEqual([a.cameraId, a2CameraId].sort());
  });

  it('shows a camera online only while the stream watchdog keeps seeing its stream', async () => {
    const online = async () => (await call(adminA, 'GET', '')).json.cameras.find((x: any) => x.id === a.cameraId).isOnline;
    await prisma.camera.update({ where: { id: a.cameraId }, data: { lastSeenAt: null } });
    expect(await online()).toBe(false); // never seen
    await prisma.camera.update({ where: { id: a.cameraId }, data: { lastSeenAt: new Date() } });
    expect(await online()).toBe(true);
    await prisma.camera.update({ where: { id: a.cameraId }, data: { lastSeenAt: new Date(Date.now() - 5 * 60_000) } });
    expect(await online()).toBe(false); // seen five minutes ago, not since
  });

  it('reports no diagnostic measurement as null instead of an invented healthy stream', async () => {
    const r = await call(adminA, 'GET', `/${a.cameraId}/diagnostic`);
    expect(r.status).toBe(200);
    expect(r.json.diagnostic).toBeNull();
  });

  it('refuses to save a preset the camera did not store (no invented token)', async () => {
    const before = await prisma.ptzPreset.count({ where: { cameraId: a.cameraId } });
    // The test camera at 127.0.0.1:80 has no ONVIF service, so SetPreset fails.
    const r = await call(adminA, 'POST', `/${a.cameraId}/ptz/presets`, { name: 'phantom' });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/did not save the preset/);
    expect(await prisma.ptzPreset.count({ where: { cameraId: a.cameraId } })).toBe(before);
  });

  it('onboarding leaves no camera behind when the media engine refuses the stream', async () => {
    const registry = new CameraRegistry(prisma);
    const before = await prisma.camera.count({ where: { tenantId: a.tenantId } });
    // MEDIAMTX_API_URL points at a host that does not exist in the test environment, so path creation fails.
    await expect(
      registry.onboard({ tenantId: a.tenantId, userId: 'u', ipAddress: '127.0.0.1' }, { name: 'refused', ipAddress: '10.0.0.9', manualRtspUri: 'rtsp://10.0.0.9/live' })
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/media engine refused the stream/) });
    expect(await prisma.camera.count({ where: { tenantId: a.tenantId } })).toBe(before);
  });

  it("onboarding refuses another tenant's site", async () => {
    const registry = new CameraRegistry(prisma);
    const siteB = await prisma.site.findFirstOrThrow({ where: { tenantId: b.tenantId } });
    await expect(
      registry.onboard({ tenantId: a.tenantId, userId: 'u', ipAddress: '127.0.0.1' }, { name: 'x', ipAddress: '10.0.0.9', siteId: siteB.id, manualRtspUri: 'rtsp://10.0.0.9/live' })
    ).rejects.toBeInstanceOf(CameraNotFoundError);
  });
});
