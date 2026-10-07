/**
 * Frame-step data for frontend/e2e/frame-step.spec.ts, in a tenant of its own: two cameras with REAL recordings made by
 * ffmpeg and registered through the recording catalog (so the backend reads their real frame times), covering the
 * moment the Investigation page opens on (one hour ago). "Step A" films at 25 fps; "Step B" at a variable rate and starts
 * 137 ms later, so its frames never line up with A's. After a step both must show a real frame of their own.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { LicenseClaims, signLicensePayload } from '../../src/utils/license';
import { RecordingCatalog } from '../../src/services/recording/catalog/recordingCatalog.service';
import { FfprobeMediaAdapter } from '../../src/services/recording/catalog/mediaProbeAdapter';

/** MediaMTX's file name for a segment starting at `ms` (the catalog reads the start time from it). */
const segmentName = (ms: number) => {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '-')}-${String(ms % 1000).padStart(3, '0')}000.mp4`;
};

function encode(out: string, seconds: number, vfr: boolean) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=25:duration=${seconds}`,
    ...(vfr ? ['-vf', "select='not(mod(n,3))+not(mod(n,7))'", '-vsync', 'vfr'] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', out,
  ]);
}

export async function seedStep(prisma: PrismaClient, opts: { password: string; licencePrivateKey: string; recordingsDir: string }) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Frame step ${suffix}`, slug: `framestep-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'Frame step site', timezone: 'UTC' } });
  const email = `framestep-${suffix}@e2e.invalid`;
  await prisma.user.create({ data: { tenantId: tenant.id, email, name: 'Frame Step Operator', role: 'OPERATOR', passwordHash: await bcrypt.hash(opts.password, 10) } });
  const now = new Date();
  const licence: LicenseClaims = {
    licenseId: `lic_framestep_${suffix}`,
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

  const catalog = new RecordingCatalog(prisma, undefined, new FfprobeMediaAdapter());
  // The page opens one hour back: cover 70 to 50 minutes ago, so a slow test run still lands inside the recording.
  const start = Math.floor((now.getTime() - 70 * 60_000) / 1000) * 1000;
  const seconds = 20 * 60;
  const cameras: Array<{ name: string; startMs: number; vfr: boolean }> = [
    { name: 'Step A', startMs: start, vfr: false },
    { name: 'Step B', startMs: start + 137, vfr: true },
  ];
  for (const c of cameras) {
    const camera = await prisma.camera.create({
      data: { tenantId: tenant.id, siteId: site.id, name: c.name, streamPath: `framestep_${c.name.slice(-1)}_${suffix}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/framestep_${suffix}` },
    });
    const dir = path.join(opts.recordingsDir, `framestep_${suffix}`, camera.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, segmentName(c.startMs));
    encode(file, seconds, c.vfr);
    const old = new Date(Date.now() - 600_000); // past the catalog's grace period for files still being written
    fs.utimesSync(file, old, old);
    const seg = await catalog.registerSegment({ tenantId: tenant.id, cameraId: camera.id, filePath: file });
    if (!seg || seg.status !== 'FINALIZED') throw new Error(`seed-step: ${c.name} was not registered as footage: ${JSON.stringify(seg)}`);
  }
  return { email };
}
