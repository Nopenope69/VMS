/**
 * Seeds a scratch database for the frontend browser tests (frontend/e2e). Never point it at real data: it
 * marks the appliance bootstrapped and creates a tenant with a known admin password.
 *
 *   DATABASE_URL=... EXPORTS_DIR=... npx ts-node scripts/e2e/seed-frontend-e2e.ts > seed.json
 *
 * Creates, all real rows: one tenant, site and camera; an admin (TENANT_ADMIN) with a bcrypt password; a sealed
 * evidence export with its manifest; a COMPLETED redaction job whose derivative file exists in EXPORTS_DIR with
 * its true SHA-256; one plate read past its retention period and one within it; a VIEWER (no PLATE_DATA_QUERY)
 * and an OPERATOR (PLATE_DATA_QUERY, no PRIVACY_POLICY_MANAGE); a plate read for the plate search test; detections
 * inside and outside the spatial search's default region; and a licence carrying ADVANCED_SEARCH, which
 * /api/v1/search requires. The licence is signed with a key made here, whose public half goes out in the seed
 * file as licensePublicKey: the runner hands it to the backend as VIGILONE_LICENSE_TEST_PUBLIC_KEY, which the
 * backend trusts only under NODE_ENV=test (utils/license.ts). The investigation workspace data lives in a second
 * tenant (seed-workspace.ts), returned as `workspace`.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { LicenseClaims, signLicensePayload } from '../../src/utils/license';
import { seedWorkspace } from './seed-workspace';

const DAY = 86_400_000;

async function main() {
  const exportsDir = process.env.EXPORTS_DIR;
  if (!exportsDir) throw new Error('EXPORTS_DIR is required (the derivative file is written there)');
  const prisma = new PrismaClient();
  const suffix = crypto.randomBytes(4).toString('hex');
  const password = `e2e-${crypto.randomBytes(9).toString('hex')}`;

  await prisma.applianceState.upsert({
    where: { id: 'SINGLETON' },
    create: { id: 'SINGLETON', isBootstrapped: true, bootstrappedAt: new Date() },
    update: { isBootstrapped: true },
  });
  const tenant = await prisma.tenant.create({ data: { name: `E2E ${suffix}`, slug: `e2e-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'E2E site', timezone: 'UTC' } });
  const camera = await prisma.camera.create({
    data: { tenantId: tenant.id, siteId: site.id, name: 'Gate camera', streamPath: `e2e_${suffix}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/e2e_${suffix}` },
  });
  const email = `admin-${suffix}@e2e.invalid`;
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email, name: 'E2E Admin', role: 'TENANT_ADMIN', passwordHash: await bcrypt.hash(password, 10) },
  });

  const viewerEmail = `viewer-${suffix}@e2e.invalid`;
  await prisma.user.create({
    data: { tenantId: tenant.id, email: viewerEmail, name: 'E2E Viewer', role: 'VIEWER', passwordHash: await bcrypt.hash(password, 10) },
  });

  const operatorEmail = `operator-${suffix}@e2e.invalid`;
  await prisma.user.create({
    data: { tenantId: tenant.id, email: operatorEmail, name: 'E2E Operator', role: 'OPERATOR', passwordHash: await bcrypt.hash(password, 10) },
  });

  const licenceKey = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const now = new Date();
  const licence: LicenseClaims = {
    licenseId: `lic_e2e_${suffix}`,
    tenantId: tenant.id,
    tier: 'PROFESSIONAL',
    maxCameras: 4,
    features: ['EVIDENCE_EXPORT', 'ADVANCED_SEARCH'],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(),
  };
  const signed = signLicensePayload(licence, licenceKey.privateKey);
  await prisma.license.create({
    data: {
      tenantId: tenant.id,
      licenseId: licence.licenseId,
      tier: licence.tier,
      maxCameras: licence.maxCameras,
      features: licence.features,
      expiresAt: new Date(licence.expiresAt!),
      ...signed,
    },
  });

  const start = new Date(Date.now() - 2 * 3_600_000);
  const manifest = await prisma.evidenceManifest.create({
    data: {
      tenantId: tenant.id,
      createdByUserId: admin.id,
      startUtc: start,
      endUtc: new Date(start.getTime() + 60_000),
      cameraIdsJson: [camera.id],
      masterEvidenceHash: crypto.createHash('sha256').update(`manifest-${suffix}`).digest('hex'),
      sourceMetadataJson: {},
      segmentManifestJson: [],
    },
  });
  const evidenceExport = await prisma.evidenceExport.create({
    data: { tenantId: tenant.id, cameraId: camera.id, requestedById: admin.id, startTime: start, endTime: new Date(start.getTime() + 60_000), status: 'COMPLETED', manifestId: manifest.id },
  });

  // A finished redaction job with a real derivative file, so the download path is exercised end to end.
  const derivative = crypto.randomBytes(4096);
  const objectKey = `redactions/e2e-${suffix}.mp4`;
  fs.mkdirSync(path.join(exportsDir, 'redactions'), { recursive: true });
  fs.writeFileSync(path.join(exportsDir, objectKey), derivative);
  const completedJob = await prisma.redactionJob.create({
    data: {
      tenantId: tenant.id,
      sourceManifestId: manifest.id,
      status: 'COMPLETED',
      redactionMode: 'LICENSE_PLATE',
      cameraId: camera.id,
      detectKinds: ['LICENSE_PLATE'],
      createdByUserId: admin.id,
      outputObjectKey: objectKey,
      outputSha256: crypto.createHash('sha256').update(derivative).digest('hex'),
      outputBytes: BigInt(derivative.length),
      completedAt: new Date(),
    },
  });

  // Retention is 30 days by default: the 100-day-old read must be purged, the 1-day-old one kept.
  await prisma.vehicleObservation.create({
    data: { tenantId: tenant.id, cameraId: camera.id, plateNumber: 'KA01AB1111', normalizedPlate: 'KA01AB1111', firstSeenAt: new Date(Date.now() - 100 * DAY), lastSeenAt: new Date(Date.now() - 100 * DAY) },
  });
  await prisma.vehicleObservation.create({
    data: { tenantId: tenant.id, cameraId: camera.id, plateNumber: 'KA01AB2222', normalizedPlate: 'KA01AB2222', firstSeenAt: new Date(Date.now() - DAY), lastSeenAt: new Date(Date.now() - DAY) },
  });
  // The plate the search test looks for: seen an hour ago at the gate camera, inside every retention period.
  const searchPlate = 'MH12SS4321';
  await prisma.vehicleObservation.create({
    data: {
      tenantId: tenant.id,
      cameraId: camera.id,
      plateNumber: searchPlate,
      normalizedPlate: searchPlate,
      stateCode: 'MH',
      vehicleCategory: 'FOUR_WHEELER',
      observationCount: 3,
      bestConfidence: 0.93,
      firstSeenAt: new Date(Date.now() - 3_600_000),
      lastSeenAt: new Date(Date.now() - 3_600_000),
    },
  });
  // Spatial search: two PERSON_DETECTED inside the default region (0.2..0.8) ten seconds apart, one cluster;
  // one VEHICLE_DETECTED outside it. An hour ago, so a range built in UTC instead of local time misses them.
  const at = Date.now() - 3_600_000;
  for (const [type, box, ms] of [
    ['PERSON_DETECTED', { x: 0.4, y: 0.4, width: 0.1, height: 0.2 }, 0],
    ['PERSON_DETECTED', { x: 0.45, y: 0.4, width: 0.1, height: 0.2 }, 10_000],
    ['VEHICLE_DETECTED', { x: 0.9, y: 0.9, width: 0.05, height: 0.05 }, 5_000],
  ] as const) {
    await prisma.detectionEvent.create({
      data: { tenantId: tenant.id, cameraId: camera.id, type, confidence: 0.9, boundingBox: box, timestamp: new Date(at + ms) },
    });
  }

  // The investigation workspace test has a tenant of its own (seed-workspace.ts).
  const workspace = await seedWorkspace(prisma, { password, licencePrivateKey: licenceKey.privateKey, recordingsDir: process.env.RECORDINGS_DIR || path.join(exportsDir, '..', 'recordings') });

  process.stdout.write(
    JSON.stringify({
      workspace,
      tenantId: tenant.id,
      email,
      viewerEmail,
      operatorEmail,
      licensePublicKey: licenceKey.publicKey,
      password,
      searchPlate,
      cameraId: camera.id,
      manifestId: manifest.id,
      exportId: evidenceExport.id,
      completedJobId: completedJob.id,
      derivativeSha256: completedJob.outputSha256,
    }) + '\n'
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
