import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

/** Creates an isolated tenant with one site and camera in the real test database. */
export async function createTenantWithCamera(
  prisma: PrismaClient,
  label: string,
  opts: { streamPath?: string; timezone?: string } = {}
): Promise<{ tenantId: string; siteId: string; cameraId: string; streamPath: string; suffix: string }> {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `${label}-${suffix}`, slug: `${label}-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: `${label} site`, timezone: opts.timezone ?? 'UTC' } });
  const streamPath = opts.streamPath ?? `${label}_${suffix}`;
  const cam = await prisma.camera.create({
    data: {
      tenantId: tenant.id,
      siteId: site.id,
      name: `${label} camera`,
      streamPath,
      ipAddress: '127.0.0.1',
      mainRtspUri: `rtsp://127.0.0.1:8554/${streamPath}`,
    },
  });
  return { tenantId: tenant.id, siteId: site.id, cameraId: cam.id, streamPath, suffix };
}

/** Creates a user in the tenant and returns a real ACCESS token for the API. */
export async function createUserWithToken(
  prisma: PrismaClient,
  tenantId: string,
  role: 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'OPERATOR' | 'VIEWER' = 'OPERATOR'
): Promise<{ userId: string; token: string }> {
  // Imported lazily so helpers stay usable in suites that do not need JWTs.
  const jwt = require('jsonwebtoken');
  const u = await prisma.user.create({
    data: {
      tenantId,
      email: `${role.toLowerCase()}-${crypto.randomBytes(5).toString('hex')}@test.invalid`,
      passwordHash: 'not-a-real-hash',
      name: `${role} test user`,
      role,
    },
  });
  const token = jwt.sign({ id: u.id, email: u.email, role, tenantId, type: 'ACCESS' }, process.env.JWT_SECRET as string, { expiresIn: '15m' });
  return { userId: u.id, token };
}

/** Starts the real Express app on an ephemeral port. */
export async function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = require('../../app').default;
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
