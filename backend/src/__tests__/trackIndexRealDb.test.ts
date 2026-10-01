/**
 * Track index (feature TRACK_INDEX) on the real database and the real Express app: detections posted to the
 * internal endpoint build one ObjectTrack per track (class, path, direction, zone visits, colours, dwell), plate
 * reads are tied to the vehicle box that contains them, the API keeps person tracks and plate text behind their
 * permissions and purposes and audits every query, and the retention purge removes old tracks except held ones.
 */
jest.mock('../config/licenseKeys', () => {
  const c = require('crypto');
  const kp = c.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { VENDOR_LICENSE_PUBLIC_KEY: kp.publicKey, TEST_LICENSE_PRIVATE_KEY: kp.privateKey };
});

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { signLicensePayload } from '../utils/license';
import { ModelManifestService } from '../services/ai/modelManifest.service';
import { AnprIngestionService } from '../services/anpr/anprIngestion.service';
import PlateTrackAggregatorService from '../services/anpr/plateTrackAggregator.service';
import { trackIndex } from '../composition';
import { purgeTenant } from '../services/privacy/dataProtection.service';

jest.setTimeout(60000);

const { TEST_LICENSE_PRIVATE_KEY } = jest.requireMock('../config/licenseKeys');
const prisma = new PrismaClient();
const SECRET = process.env.INTERNAL_API_SECRET as string;
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-30T20:00:00Z');

let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let otherTenantId = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
let manifest: { id: string; sha256: string; name: string; version: string };
let gateZoneId = '';
const task = `object_detection_track_${crypto.randomBytes(3).toString('hex')}`;

function provenance(ts: string) {
  return {
    adapterId: 'vigilone-ai-worker', adapterVersion: '2.0.0-phase2', modelId: manifest.id, modelName: manifest.name, modelVersion: manifest.version,
    modelSha256: manifest.sha256, runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: ts,
  };
}

function detection(trackId: string, t: number, box: { x: number; y: number; width: number; height: number }, over: Record<string, any> = {}) {
  const ts = new Date(t).toISOString();
  return {
    tenantId, cameraId, modelManifestId: manifest.id, inferenceId: crypto.randomUUID(), type: 'PERSON_DETECTED', objectClass: 'person',
    confidence: 0.8, boundingBox: box, trackId, trackState: 'CONFIRMED', timestamp: ts, provenance: provenance(ts), ...over,
  };
}
const colour = (upper?: string, lower?: string, monochrome = false) => ({ colour: { method: 'hsv-majority-v1', monochrome, ...(upper ? { upper } : {}), ...(lower ? { lower } : {}) } });

async function ingest(body: unknown) {
  const r = await fetch(`${app.url}/api/v1/internal/detections`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` }, body: JSON.stringify(body) });
  expect(r.status).toBe(200);
  return r.json() as Promise<any>;
}
async function api(user: { token: string }, p: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${app.url}/api/v1${p}`, { headers: { authorization: `Bearer ${user.token}`, ...headers } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
const purpose = { 'x-vigilone-purpose': 'SECURITY_INCIDENT_INVESTIGATION' };
const track = (trackId: string) => prisma.objectTrack.findUnique({ where: { cameraId_trackId: { cameraId, trackId } } });

/** A person walking left to right along y = 0.5, one detection per second. */
async function walk(trackId: string, n: number, opts: { start?: number; colours?: (i: number) => object; confidence?: (i: number) => number } = {}) {
  const start = opts.start ?? T0;
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    const body = detection(trackId, start + i * 1000, { x: 0.05 + i * 0.1, y: 0.3, width: 0.08, height: 0.2 }, {
      attributesJson: opts.colours ? opts.colours(i) : undefined,
      confidence: opts.confidence ? opts.confidence(i) : 0.8,
      trackFirstSeenAt: new Date(start - 2000).toISOString(),
    });
    out.push({ body, res: await ingest(body) });
  }
  return out;
}

async function license(forTenant: string) {
  const claims = { licenseId: `lic_tracks_${crypto.randomBytes(4).toString('hex')}`, tenantId: forTenant, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], issuedAt: new Date().toISOString(), expiresAt: null, kid: 'test' } as any;
  const art = signLicensePayload(claims, TEST_LICENSE_PRIVATE_KEY);
  await prisma.license.create({ data: { tenantId: forTenant, licenseId: claims.licenseId, tier: 'ENTERPRISE', maxCameras: 16, features: ['ADVANCED_SEARCH'], signedPayload: art.signedPayload, signatureEd25519: art.signatureEd25519 } });
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'tracks'));
  ({ tenantId: otherTenantId } = await createTenantWithCamera(prisma, 'tracks-other'));
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  for (const id of [tenantId, otherTenantId]) await license(id);
  const m = await new ModelManifestService(prisma).registerModelManifest({
    name: `yolox-track-${crypto.randomBytes(3).toString('hex')}`, version: '0.1.1rc0', sha256: crypto.randomBytes(32).toString('hex'),
    codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0',
    trainingData: { source: 'COCO 2017 train', license: 'CC-BY-4.0', provenance: 'public-dataset', commercialUse: true },
    runtimeConfig: { runtime: 'onnxruntime', modelFormat: 'ONNX', inputWidth: 416, inputHeight: 416, colorSpace: 'BGR' },
    task, modelSignature: { decoder: 'yolox' }, weightsSource: 'test',
  });
  manifest = { id: m.id, sha256: m.sha256, name: m.name, version: m.version };
  // "Gate": the left 40% of the picture.
  const zone = await prisma.detectionZone.create({ data: { tenantId, cameraId, name: 'Gate', type: 'INCLUSION', polygonCoordinates: [{ x: 0, y: 0 }, { x: 0.4, y: 0 }, { x: 0.4, y: 1 }, { x: 0, y: 1 }] } });
  gateZoneId = zone.id;
  await prisma.detectionZone.create({ data: { tenantId, cameraId, name: 'Masked', type: 'EXCLUSION', polygonCoordinates: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] } });
  trackIndex.clearZoneCache();
  app = await startApp();
});

afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_TRACK_INDEX;
  for (const id of [tenantId, otherTenantId]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await prisma.modelManifest.deleteMany({ where: { task } });
  await app.close();
  await prisma.$disconnect();
});

describe('building tracks from detections', () => {
  it('summarises a walking person: class, dwell, path, direction, zone visit, colours, best detection', async () => {
    const steps = await walk('trk-walk', 8, {
      colours: (i) => (i === 3 ? colour(undefined, undefined, true) : i === 4 ? { colour: { monochrome: false, upper: 'not-a-colour' } } : colour('blue', i === 6 ? 'grey' : 'black')),
      confidence: (i) => (i === 5 ? 0.97 : 0.8),
    });
    const t = (await track('trk-walk'))!;
    expect(t).toMatchObject({ tenantId, objectClass: 'person', observationCount: 8, maxConfidence: 0.97, direction: 'RIGHT', modelSha256: manifest.sha256 });
    expect(t.bestDetectionId).toBe(steps[5].res.detectionId);
    // First seen is the tracker's first sighting (2 s before the first confirmed detection); last is the 8th step.
    expect(t.firstSeenAt.getTime()).toBe(T0 - 2000);
    expect(t.lastSeenAt.getTime()).toBe(T0 + 7000);
    expect(t.dwellSeconds).toBe(9);
    const path = t.pathJson as any[];
    expect(path[0]).toEqual({ t: T0, x: 0.09, y: 0.5 });
    expect(path[path.length - 1]).toEqual({ t: T0 + 7000, x: 0.79, y: 0.5 });
    // Ground points (bottom centre) x = 0.09 .. 0.39 are in the Gate; the EXCLUSION zone is not a place.
    expect(t.zoneIds).toEqual([gateZoneId]);
    expect(t.zonesJson).toEqual([{ zoneId: gateZoneId, name: 'Gate', enteredAt: new Date(T0).toISOString(), exitedAt: new Date(T0 + 3000).toISOString() }]);
    // Six named votes: upper blue x6; lower black x5, grey x1. The monochrome and the malformed detections add no names.
    expect(t).toMatchObject({ upperColour: 'blue', lowerColour: 'black', bodyColour: null });
    expect((t.colourVotesJson as any).monochrome).toBe(1);
  });

  it('withholds a colour when no colour leads clearly', async () => {
    await walk('trk-mixed', 4, { colours: (i) => colour(i % 2 ? 'red' : 'green') });
    expect((await track('trk-mixed'))!.upperColour).toBeNull();
  });

  it('ignores tentative detections and duplicates, and counts concurrent detections of one track exactly once each', async () => {
    await ingest(detection('trk-tent', T0, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }, { trackState: 'TENTATIVE' }));
    expect(await track('trk-tent')).toBeNull();

    const body = detection('trk-dup', T0, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 });
    await ingest(body);
    await ingest(body);
    expect((await track('trk-dup'))!.observationCount).toBe(1);

    await Promise.all(Array.from({ length: 10 }, (_, i) => ingest(detection('trk-burst', T0 + i * 200, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }))));
    const b = (await track('trk-burst'))!;
    expect(b.observationCount).toBe(10);
    expect(b.direction).toBe('STATIONARY');
  });

  it('does nothing while the feature is off', async () => {
    process.env.VIGILONE_FEATURE_TRACK_INDEX = 'false';
    try {
      await ingest(detection('trk-off', T0, { x: 0.5, y: 0.5, width: 0.1, height: 0.1 }));
      expect(await track('trk-off')).toBeNull();
    } finally {
      process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
    }
  });
});

describe('plate reads tied to vehicle tracks', () => {
  let plateManifest: { id: string; sha256: string };
  const car = { x: 0.3, y: 0.4, width: 0.3, height: 0.3 };
  const plateIn = { x: 0.4, y: 0.62, width: 0.1, height: 0.04 };
  const plateOut = { x: 0.8, y: 0.1, width: 0.1, height: 0.04 };

  const anpr = () => new AnprIngestionService(prisma, new PlateTrackAggregatorService(prisma), trackIndex);
  const read = (plateText: string, at: number, bbox: object) => ({
    tenantId, cameraId, frameTimestampUtc: new Date(at).toISOString(),
    plates: [{ plateText, rawText: plateText, confidence: 0.9, bbox, lines: 1, format: 'STANDARD' }],
    provenance: {
      adapterId: 'vigilone-anpr', adapterVersion: '1.0.0-phase4', modelId: plateManifest.id, modelName: 'anpr-test', modelVersion: '1', modelSha256: plateManifest.sha256,
      runtime: 'onnxruntime@1.30.0', executionProvider: 'cpu', inferenceId: crypto.randomUUID(), frameTimestampUtc: new Date(at).toISOString(),
      components: [{ role: 'detector', modelName: 'det', modelVersion: '1', modelSha256: 'a'.repeat(64) }],
    },
  });

  beforeAll(async () => {
    await prisma.camera.update({ where: { id: cameraId }, data: { lprMode: true } });
    // Registered directly: this tests the link, not the pipeline approval (anprRealDb.test.ts covers that).
    const m = await prisma.modelManifest.create({
      data: { name: `anpr-track-${crypto.randomBytes(3).toString('hex')}`, version: '1', sha256: crypto.randomBytes(32).toString('hex'), codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', trainingDataJson: {}, runtimeConfigJson: {}, task: 'plate_recognition', isActive: true },
    });
    plateManifest = { id: m.id, sha256: m.sha256 };
    for (let i = 0; i < 3; i++) await ingest(detection('trk-car', T0 + 60_000 + i * 500, car, { type: 'VEHICLE_DETECTED', objectClass: 'car', attributesJson: { colour: { method: 'hsv-majority-v1', monochrome: false, body: 'white' } } }));
  });
  afterAll(async () => {
    await prisma.modelManifest.delete({ where: { id: plateManifest.id } }).catch(() => undefined);
  });

  it('links a plate inside the vehicle box in the nearest frame, both ways, once', async () => {
    const [r] = await anpr().ingest(read('MH12AB1234', T0 + 60_400, plateIn));
    const t = (await track('trk-car'))!;
    expect(t.vehicleObservationId).toBe(r.observationId);
    expect(t.bodyColour).toBe('white');
    expect((await prisma.vehicleObservation.findUnique({ where: { id: r.observationId } }))!.trackId).toBe('trk-car');
    // A second read of the same plate is the same observation: already linked, nothing changes.
    await anpr().ingest(read('MH12AB1234', T0 + 60_900, plateIn));
    expect((await track('trk-car'))!.vehicleObservationId).toBe(r.observationId);
  });

  it('does not link a plate outside every vehicle box, or too far away in time', async () => {
    const [outside] = await anpr().ingest(read('KA01CD5678', T0 + 60_400, plateOut));
    const [late] = await anpr().ingest(read('KA02EF9012', T0 + 75_000, plateIn));
    for (const id of [outside.observationId, late.observationId]) {
      expect((await prisma.vehicleObservation.findUnique({ where: { id } }))!.trackId).toBeNull();
      expect(await prisma.objectTrack.count({ where: { vehicleObservationId: id } })).toBe(0);
    }
  });
});

describe('API', () => {
  it('lists vehicle tracks without plate text and leaves person tracks out by default; audits the query', async () => {
    const r = await api(admin, '/tracks?limit=200');
    expect(r.status).toBe(200);
    expect(r.json.tracks.some((t: any) => t.objectClass === 'person')).toBe(false);
    const car = r.json.tracks.find((t: any) => t.trackId === 'trk-car');
    expect(car).toMatchObject({ objectClass: 'car', colours: { body: 'white' }, plate: { linked: true } });
    expect(JSON.stringify(r.json)).not.toContain('MH12AB1234');
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'TRACK_QUERY' } })).toBeGreaterThan(0);
  });

  it('person tracks need the permission and a purpose, and are audited with the purpose', async () => {
    expect((await api(admin, '/tracks?includePersons=true')).json.code).toBe('PURPOSE_REQUIRED');
    expect((await api(operator, '/tracks?includePersons=true', purpose)).json.code).toBe('PERSON_TRACK_FORBIDDEN');
    expect((await api(admin, '/tracks?upperColour=blue')).json.code).toBe('PERSON_QUERY_REQUIRES_INCLUDE');
    expect((await api(admin, '/tracks?objectClasses=person')).json.code).toBe('PERSON_QUERY_REQUIRES_INCLUDE');

    const r = await api(admin, `/tracks?includePersons=true&upperColour=blue&lowerColour=black&zoneId=${gateZoneId}&direction=RIGHT&minDwellSeconds=8`, purpose);
    expect(r.status).toBe(200);
    expect(r.json.tracks.map((t: any) => t.trackId)).toEqual(['trk-walk']);
    expect(r.json.tracks[0]).toMatchObject({ dwellSeconds: 9, colours: { upper: 'blue', lower: 'black', monochromeDetections: 1 } });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'TRACK_PERSON_QUERY' }, orderBy: { timestampUtc: 'desc' } });
    expect(audit.metadataJson as any).toMatchObject({ category: 'BIOMETRIC', purpose: 'SECURITY_INCIDENT_INVESTIGATION', resultCount: 1 });
  });

  it('plate text needs the plate permission and a purpose, and cannot be asked with person tracks', async () => {
    expect((await api(admin, '/tracks?includePlates=true&includePersons=true', purpose)).json.code).toBe('SENSITIVE_CATEGORIES_SEPARATE');
    expect((await api(admin, '/tracks?includePlates=true')).json.code).toBe('PURPOSE_REQUIRED');
    const r = await api(admin, '/tracks?includePlates=true&hasPlate=true', purpose);
    expect(r.status).toBe(200);
    expect(r.json.tracks.map((t: any) => [t.trackId, t.plate?.plate])).toEqual([['trk-car', 'MH12AB1234']]);
    await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'TRACK_PLATE_QUERY' } });
  });

  it('one track: a person track needs a purpose; another tenant\'s track is not found', async () => {
    const walkTrack = (await track('trk-walk'))!;
    expect((await api(admin, `/tracks/${walkTrack.id}`)).json.code).toBe('PURPOSE_REQUIRED');
    expect((await api(admin, `/tracks/${walkTrack.id}`, purpose)).json.track.trackId).toBe('trk-walk');
    const other = await createUserWithToken(prisma, otherTenantId, 'TENANT_ADMIN');
    expect((await api(other, `/tracks/${walkTrack.id}`, purpose)).status).toBe(404);
  });

  it('rejects unknown parameters and bad values', async () => {
    expect((await api(admin, '/tracks?colour=blue')).json.code).toBe('INVALID_TRACK_QUERY');
    expect((await api(admin, '/tracks?bodyColour=teal')).json.code).toBe('INVALID_TRACK_QUERY');
    expect((await api(admin, '/tracks?limit=1000')).json.code).toBe('INVALID_TRACK_QUERY');
  });

  it('answers 501 FEATURE_DISABLED while the feature is off', async () => {
    process.env.VIGILONE_FEATURE_TRACK_INDEX = 'false';
    try {
      const r = await api(admin, '/tracks');
      expect(r.status).toBe(501);
      expect(r.json.code).toBe('FEATURE_DISABLED');
    } finally {
      process.env.VIGILONE_FEATURE_TRACK_INDEX = 'true';
    }
  });
});

describe('retention', () => {
  it('purges tracks past the detection retention period, keeps held and recent ones', async () => {
    const now = Date.now();
    const mk = (trackId: string, ageDays: number) =>
      prisma.objectTrack.create({
        data: { tenantId, cameraId, trackId, objectClass: 'car', classVotesJson: {}, firstSeenAt: new Date(now - ageDays * DAY), lastSeenAt: new Date(now - ageDays * DAY), pathJson: [], zonesJson: [], colourVotesJson: {} },
      });
    const old = await mk('trk-old', 40);
    const recent = await mk('trk-recent', 2);
    const held = await mk('trk-held', 50);
    const alarm = await prisma.alarm.create({ data: { tenantId, cameraId, title: 'held', severity: 'CRITICAL' } });
    await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: alarm.id, cameraId, windowStart: new Date(now - 51 * DAY), windowEnd: new Date(now - 49 * DAY), expiresAt: new Date(now + 30 * DAY) } });

    const r = await purgeTenant(prisma, tenantId);
    expect(await prisma.objectTrack.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.objectTrack.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await prisma.objectTrack.findUnique({ where: { id: held.id } })).not.toBeNull();
    // At least the old one: tracks built by the tests above are dated 30 Sept 2026 and pass the 30-day period later.
    expect(r.tracksDeleted).toBeGreaterThanOrEqual(1);
    expect(r.tracksHeld).toBe(1);
  });
});
