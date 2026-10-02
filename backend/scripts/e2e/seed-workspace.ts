/**
 * Seed for the investigation workspace browser test (frontend/e2e/investigation-workspace.spec.ts), in a tenant of
 * its own so the other browser tests keep their single camera and their counts. All real rows:
 *
 *  - cameras Gate, Lobby and Yard on one site; Gate and Lobby are neighbours (0 to 120 s) and placed on the
 *    'Ground floor' plan; Yard is on no floor plan;
 *  - person X at the Gate, X again in the Lobby 60 s later, and person Y in the Lobby at the same time;
 *  - a white car at the Gate whose plate MH12WS0001 is read again at the Yard an hour later;
 *  - crops with real JPEG files (true SHA-256) and embeddings from a registered embedding model, with controlled
 *    vectors: X's crops look alike, Y's and the car's do not look like X.
 *
 * Times are two hours ago, so a default "today" view contains them.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { LicenseClaims, signLicensePayload } from '../../src/utils/license';
import { EMBEDDING_DIM, storeEmbedding } from '../../src/services/search/cropEmbeddingStore';

const DAY = 86_400_000;
const BLUE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAIAAYAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjwGkIgAAAAAD/9k=', 'base64');
const WHITE_JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgQEBMQExYWFhYWFhoYGhsbGxoaGhobGxsdHR0iIiIdHR0bGx0dICAiIiUmJSMjIiMmJigoKDAwLi44ODpFRVP/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIACAAGAMBIgACEQADEQD/2gAMAwEAAhEDEQA/ALcAAAAAAAD/2Q==', 'base64');

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const concept = (seed: number) => unit(Array.from({ length: EMBEDDING_DIM }, rng(seed)));
const near = (v: number[], seed: number) => {
  const noise = concept(seed);
  return unit(v.map((x, i) => x + 0.25 * noise[i]));
};

export async function seedWorkspace(prisma: PrismaClient, opts: { password: string; licencePrivateKey: string; recordingsDir: string }) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `E2E workspace ${suffix}`, slug: `e2e-ws-${suffix}` } });
  const site = await prisma.site.create({ data: { tenantId: tenant.id, name: 'Workspace site', timezone: 'UTC' } });
  const cam: Record<string, string> = {};
  for (const name of ['Gate', 'Lobby', 'Yard']) {
    cam[name] = (
      await prisma.camera.create({ data: { tenantId: tenant.id, siteId: site.id, name, streamPath: `ws_${name.toLowerCase()}_${suffix}`, ipAddress: '127.0.0.1', mainRtspUri: `rtsp://127.0.0.1:8554/ws_${name}` } })
    ).id;
  }
  const [a, b] = [cam.Gate, cam.Lobby].sort();
  await prisma.cameraNeighbour.create({ data: { tenantId: tenant.id, cameraAId: a, cameraBId: b, minTransitSeconds: 0, maxTransitSeconds: 120 } });
  // Ground floor plan with Gate and Lobby placed; Yard is on no floor plan.
  const plan = await prisma.floorplan.create({ data: { tenantId: tenant.id, siteId: site.id, name: 'Ground floor', imageObjectKey: 'plans/ws-ground.png' } });
  await prisma.cameraSpatialPlacement.create({ data: { cameraId: cam.Gate, floorplanId: plan.id, x: 150, y: 600 } });
  await prisma.cameraSpatialPlacement.create({ data: { cameraId: cam.Lobby, floorplanId: plan.id, x: 500, y: 300 } });

  const email = `ws-admin-${suffix}@e2e.invalid`;
  await prisma.user.create({ data: { tenantId: tenant.id, email, name: 'Workspace Admin', role: 'TENANT_ADMIN', passwordHash: await bcrypt.hash(opts.password, 10) } });

  const now = new Date();
  const licence: LicenseClaims = {
    licenseId: `lic_e2e_ws_${suffix}`,
    tenantId: tenant.id,
    tier: 'PROFESSIONAL',
    maxCameras: 4,
    features: ['EVIDENCE_EXPORT', 'ADVANCED_SEARCH'],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * DAY).toISOString(),
  };
  await prisma.license.create({
    data: { tenantId: tenant.id, licenseId: licence.licenseId, tier: licence.tier, maxCameras: licence.maxCameras, features: licence.features, expiresAt: new Date(licence.expiresAt!), ...signLicensePayload(licence, opts.licencePrivateKey) },
  });

  const model = { name: `e2e-embedding-${suffix}`, version: '1.0.0', sha256: crypto.randomBytes(32).toString('hex') };
  await prisma.modelManifest.create({ data: { ...model, task: 'embedding', codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, isActive: true } });

  const cropsDir = path.join(opts.recordingsDir, 'crops');
  const T0 = Date.now() - 2 * 3_600_000;
  const at = (s: number) => new Date(T0 + s * 1000);
  const X = concept(21);
  const Y = concept(22);
  const CAR = concept(23);
  const tracks: Record<string, string> = {};

  async function track(name: string, cameraId: string, objectClass: string, from: number, to: number, vectors: number[][], over: Record<string, unknown> = {}) {
    const trackId = `ws-${name}-${suffix}`;
    const isPerson = objectClass === 'person';
    let bestDetectionId: string | null = null;
    const t = await prisma.objectTrack.create({
      data: { tenantId: tenant.id, cameraId, trackId, objectClass, classVotesJson: {}, firstSeenAt: at(from), lastSeenAt: at(to), dwellSeconds: to - from, observationCount: vectors.length, maxConfidence: 0.9, pathJson: [{ t: at(from).getTime(), x: 0.2, y: 0.8 }, { t: at(to).getTime(), x: 0.7, y: 0.6 }], direction: 'UP_RIGHT', zonesJson: [], colourVotesJson: {}, ...over },
    });
    for (const [i, v] of vectors.entries()) {
      const det = await prisma.detectionEvent.create({ data: { tenantId: tenant.id, cameraId, trackId, type: isPerson ? 'PERSON_DETECTED' : 'VEHICLE_DETECTED', objectClass, confidence: 0.9, timestamp: at(from + i) } });
      bestDetectionId = bestDetectionId ?? det.id;
      const cropId = crypto.randomUUID();
      const bytes = isPerson ? BLUE_JPEG : WHITE_JPEG;
      const relativePath = `${tenant.id}/${cameraId}/${cropId}.jpg`;
      fs.mkdirSync(path.dirname(path.join(cropsDir, relativePath)), { recursive: true });
      fs.writeFileSync(path.join(cropsDir, relativePath), bytes);
      await prisma.objectCrop.create({
        data: { id: cropId, tenantId: tenant.id, cameraId, detectionEventId: det.id, cropClass: isPerson ? 'PERSON' : 'NON_PERSON', objectClass, relativePath, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, capturedAt: at(from + i), expiresAt: new Date(Date.now() + 30 * DAY) },
      });
      await storeEmbedding(prisma, { tenantId: tenant.id, cropId, model, adapterId: 'e2e-seed', vector: v });
    }
    await prisma.objectTrack.update({ where: { id: t.id }, data: { bestDetectionId } });
    tracks[name] = t.id;
  }

  await track('X@Gate', cam.Gate, 'person', 0, 20, [X, near(X, 101)], { upperColour: 'blue', lowerColour: 'black' });
  await track('X@Lobby', cam.Lobby, 'person', 80, 100, [near(X, 102), near(X, 103)], { upperColour: 'blue', lowerColour: 'black' });
  await track('Y@Lobby', cam.Lobby, 'person', 70, 95, [Y, near(Y, 104)], { upperColour: 'red' });
  const plate = 'MH12WS0001';
  const readGate = await prisma.vehicleObservation.create({ data: { tenantId: tenant.id, cameraId: cam.Gate, plateNumber: plate, normalizedPlate: plate, firstSeenAt: at(300), lastSeenAt: at(305) } });
  const readYard = await prisma.vehicleObservation.create({ data: { tenantId: tenant.id, cameraId: cam.Yard, plateNumber: plate, normalizedPlate: plate, firstSeenAt: at(3900), lastSeenAt: at(3905) } });
  await track('car@Gate', cam.Gate, 'car', 300, 310, [CAR], { bodyColour: 'white', vehicleObservationId: readGate.id });
  await track('car@Yard', cam.Yard, 'car', 3900, 3910, [near(CAR, 105)], { bodyColour: 'white', vehicleObservationId: readYard.id });

  return { tenantId: tenant.id, email, cameras: cam, tracks, plate };
}
