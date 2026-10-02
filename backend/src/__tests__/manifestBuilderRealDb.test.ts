/**
 * A multi-camera evidence manifest on the real database when one camera has no recording in the window (found by the
 * investigation workspace browser test): the manifest is built, the empty camera is recorded with zero segments, and
 * no other camera's segments are mixed in. Before the fix, an empty first lookup retried the catalog with an old
 * four-argument call shape, which put a camera id where a date belongs and failed with a database error.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken } from './helpers/realDb';
import { ManifestBuilder } from '../services/evidence/archive/manifestBuilder';

const prisma = new PrismaClient();
let tenantId = '';
let camA = '';
let camB = '';
let userId = '';
const t0 = Date.parse('2026-09-30T20:00:00Z');

beforeAll(async () => {
  let siteId: string;
  ({ tenantId, siteId, cameraId: camA } = await createTenantWithCamera(prisma, 'mfb'));
  camB = (await prisma.camera.create({ data: { tenantId, siteId, name: 'B', streamPath: `mfb_b_${crypto.randomBytes(3).toString('hex')}`, ipAddress: '127.0.0.1', mainRtspUri: 'rtsp://127.0.0.1:8554/b' } })).id;
  ({ userId } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  await prisma.recordingSegment.create({
    data: { tenantId, cameraId: camA, filePath: `/recordings/${camA}/a.mp4`, startTime: new Date(t0), endTime: new Date(t0 + 60_000), durationMs: 60_000, sizeBytes: BigInt(1000), sha256Hash: 'a'.repeat(64) },
  });
});

afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('evidence manifest when a camera has no recording', () => {
  it('builds a manifest over two cameras when one has no recording in the window', async () => {
    const m: any = await new ManifestBuilder(prisma).createManifest({
      tenantId,
      createdByUserId: userId,
      cameraIds: [camB, camA],
      startUtc: new Date(t0 - 30_000),
      endUtc: new Date(t0 + 90_000),
      legalHold: false,
    } as any);
    expect(m.id).toBeTruthy();
    const stored = await prisma.evidenceManifest.findUniqueOrThrow({ where: { id: m.id } });
    const segments = stored.segmentManifestJson as any[];
    expect(segments).toHaveLength(1);
    expect(segments[0].cameraId).toBe(camA);
  });

  it('builds a manifest when no camera has a recording in the window', async () => {
    const m: any = await new ManifestBuilder(prisma).createManifest({
      tenantId,
      createdByUserId: userId,
      cameraIds: [camB],
      startUtc: new Date(t0 - 30_000),
      endUtc: new Date(t0 + 90_000),
      legalHold: false,
    } as any);
    const stored = await prisma.evidenceManifest.findUniqueOrThrow({ where: { id: m.id } });
    expect(stored.segmentManifestJson as any[]).toHaveLength(0);
  });
});
