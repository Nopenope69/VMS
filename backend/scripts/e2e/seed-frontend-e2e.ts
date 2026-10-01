/**
 * Seeds a scratch database for the frontend browser tests (frontend/e2e). Never point it at real data: it
 * marks the appliance bootstrapped and creates a tenant with a known admin password.
 *
 *   DATABASE_URL=... EXPORTS_DIR=... npx ts-node scripts/e2e/seed-frontend-e2e.ts > seed.json
 *
 * Creates, all real rows: one tenant, site and camera; an admin (TENANT_ADMIN) with a bcrypt password; a sealed
 * evidence export with its manifest; a COMPLETED redaction job whose derivative file exists in EXPORTS_DIR with
 * its true SHA-256; one plate read past its retention period and one within it.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

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

  process.stdout.write(
    JSON.stringify({
      tenantId: tenant.id,
      email,
      password,
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
