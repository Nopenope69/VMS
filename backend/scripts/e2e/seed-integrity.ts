/**
 * Footage integrity data for frontend/e2e/footage-integrity.spec.ts (ADR 0018 and 0019), in a tenant of its own:
 *   - "Gate camera": three recordings sealed with the test appliance key (an intact chain), an open "covered"
 *     condition and an earlier "out of focus" condition that ended (restored);
 *   - "Yard camera": two sealed recordings, the second one's stored hash changed afterwards (the chain check must
 *     report it), and one recording held by an integrity finding (HASH_MISMATCH).
 * The user is an OPERATOR: the page is meant for the control room, not only administrators.
 *
 * Seals are signed with the key the test backend uses (NODE_ENV=test keeps it in /tmp/vigilone_test_keys), so the
 * backend's chain check verifies them for real.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { LicenseClaims, signLicensePayload } from '../../src/utils/license';
import { SegmentSealer } from '../../src/services/recording/catalog/segmentSeal';

const TEST_KEY_DIR = '/tmp/vigilone_test_keys';

/** Same files and format as getOrCreateApplianceEd25519Keys() under NODE_ENV=test. */
function testApplianceKeys(): { publicKeyPem: string; privateKeyPem: string } {
  const priv = path.join(TEST_KEY_DIR, 'appliance_ed25519.key');
  const pub = path.join(TEST_KEY_DIR, 'appliance_ed25519.pub');
  if (fs.existsSync(priv) && fs.existsSync(pub)) return { privateKeyPem: fs.readFileSync(priv, 'utf8'), publicKeyPem: fs.readFileSync(pub, 'utf8') };
  fs.mkdirSync(TEST_KEY_DIR, { recursive: true });
  const kp = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  fs.writeFileSync(priv, kp.privateKey, { mode: 0o600 });
  fs.writeFileSync(pub, kp.publicKey, { mode: 0o644 });
  return { privateKeyPem: kp.privateKey, publicKeyPem: kp.publicKey };
}

export async function seedIntegrity(prisma: PrismaClient, opts: { password: string; licencePrivateKey: string }) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Integrity ${suffix}`, slug: `integrity-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'Integrity site', timezone: 'UTC' } });
  const camera = (name: string, key: string) =>
    prisma.camera.create({
      data: { tenantId: tenant.id, siteId: site.id, name, streamPath: `${key}_${suffix}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/${key}_${suffix}` },
    });
  const gate = await camera('Gate camera', 'integrity_gate');
  const yard = await camera('Yard camera', 'integrity_yard');
  const email = `integrity-${suffix}@e2e.invalid`;
  await prisma.user.create({
    data: { tenantId: tenant.id, email, name: 'Integrity Operator', role: 'OPERATOR', passwordHash: await bcrypt.hash(opts.password, 10) },
  });

  const now = new Date();
  const licence: LicenseClaims = {
    licenseId: `lic_integrity_${suffix}`,
    tenantId: tenant.id,
    tier: 'PROFESSIONAL',
    maxCameras: 4,
    features: ['EVIDENCE_EXPORT'],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
  };
  await prisma.license.create({
    data: {
      tenantId: tenant.id,
      licenseId: licence.licenseId,
      tier: licence.tier,
      maxCameras: licence.maxCameras,
      features: licence.features,
      expiresAt: new Date(licence.expiresAt!),
      ...signLicensePayload(licence, opts.licencePrivateKey),
    },
  });

  const sealer = new SegmentSealer(prisma, testApplianceKeys);
  const segment = async (cameraId: string, i: number, extra: Record<string, unknown> = {}) => {
    const start = new Date(now.getTime() - (60 - i) * 60_000);
    return prisma.recordingSegment.create({
      data: {
        tenantId: tenant.id,
        cameraId,
        filePath: `/tmp/e2e-integrity-${suffix}/${cameraId}/${i}.mp4`,
        startTime: start,
        endTime: new Date(start.getTime() + 60_000),
        durationMs: 60_000,
        sizeBytes: BigInt(1_000_000 + i),
        sha256Hash: crypto.createHash('sha256').update(`${cameraId}-${i}`).digest('hex'),
        status: 'FINALIZED',
        ...extra,
      },
    });
  };
  const sealed = async (cameraId: string, i: number) => {
    const s = await segment(cameraId, i);
    const result = await sealer.sealSegment(s);
    if (result.outcome !== 'SEALED') throw new Error(`seed: sealing failed: ${JSON.stringify(result)}`);
    return s;
  };
  for (let i = 0; i < 3; i++) await sealed(gate.id, i);
  await sealed(yard.id, 0);
  const edited = await sealed(yard.id, 1);
  await prisma.recordingSegment.update({ where: { id: edited.id }, data: { sha256Hash: 'f'.repeat(64) } });
  await segment(yard.id, 2, { status: 'CORRUPTED', quarantineReason: 'HASH_MISMATCH' });

  const condition = (changeType: string, startedMinAgo: number, clearedMinAgo: number | null) => {
    const startedAt = new Date(now.getTime() - startedMinAgo * 60_000);
    return prisma.cameraSabotageCondition.create({
      data: {
        tenantId: tenant.id,
        cameraId: gate.id,
        changeType,
        startedAt,
        confirmedAt: new Date(startedAt.getTime() + 10_000),
        clearedAt: clearedMinAgo === null ? null : new Date(now.getTime() - clearedMinAgo * 60_000),
        clearReason: clearedMinAgo === null ? null : 'RESTORED',
        score: 0.9,
        method: 'classical-v1',
        measurementsJson: { meanLuma: 128, stdLuma: 3, darkFraction: 0, brightFraction: 0, sharpness: 0.2, referenceSharpness: 0.6, similarity: 0.05 },
        eventId: `ev_sabotage_e2e_${changeType}_${suffix}`,
      },
    });
  };
  await condition('OCCLUSION', 5, null);
  await condition('DEFOCUS', 180, 170);

  return { email, gateCamera: gate.name, yardCamera: yard.name };
}
