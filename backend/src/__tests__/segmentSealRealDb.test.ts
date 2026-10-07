/**
 * ADR 0018 on the real database with real files: segments are sealed when registered (flag on), the per-camera chain has
 * no gaps under concurrent registration, a file or stored hash that later differs from its seal is reported once and
 * never resealed, the chain report finds edited, removed and cut-off seals, anchors go into the audit chain, a sealing
 * failure never fails registration, and exports carry segment_seals.json that the standalone verifier checks.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { PrismaClient, SegmentStatus } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';

jest.setTimeout(180000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seals-'));
process.env.EXPORTS_DIR = path.join(tmp, 'exports');
process.env.RECORDINGS_DIR = path.join(tmp, 'recordings');
fs.mkdirSync(process.env.EXPORTS_DIR, { recursive: true });
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
import { SegmentIntegrityVerifier } from '../services/recording/catalog/segmentIntegrity';
import { SEAL_ANCHOR_ACTION, SegmentSealer } from '../services/recording/catalog/segmentSeal';

const FLAG = 'VIGILONE_FEATURE_FOOTAGE_SEALING';
const VERIFY = path.resolve(__dirname, '../../../tools/vigilone-verify/vigilone-verify.mjs');
const prisma = new PrismaClient();
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const originalFlag = process.env[FLAG];
const created: string[] = [];
const t0 = Date.now() - 120_000;

function makeClip(name: string, hue: number): string {
  const f = path.join(process.env.RECORDINGS_DIR!, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=10`, '-vf', `hue=h=${hue}`, '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', f]);
  return f;
}

async function camera(label: string) {
  const c = await createTenantWithCamera(prisma, label);
  created.push(c.cameraId);
  return c;
}
const register = (catalog: RecordingCatalog, c: { tenantId: string; cameraId: string }, filePath: string, i: number) =>
  catalog.registerSegment({ tenantId: c.tenantId, cameraId: c.cameraId, filePath, startTime: new Date(t0 + i * 1000), durationMs: 1000 });

function verify(target: string, ...extra: string[]) {
  const r = spawnSync('node', [VERIFY, target, '--json', ...extra], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}
const statusOf = (r: any, id: string) => r.out.results.find((x: any) => x.id === id)?.status;
const failed = (r: any) => r.out.results.filter((x: any) => x.status === 'FAIL').map((x: any) => x.id);
function unzip(zip: string): string {
  const d = fs.mkdtempSync(path.join(tmp, 'x-'));
  execFileSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, d]);
  return d;
}

beforeEach(() => {
  process.env[FLAG] = 'true';
});
afterAll(async () => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
  await prisma.segmentSeal.deleteMany({ where: { cameraId: { in: created } } });
  const cams = await prisma.camera.findMany({ where: { id: { in: created } }, select: { tenantId: true } });
  for (const c of cams) await prisma.tenant.delete({ where: { id: c.tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sealing at registration', () => {
  it('seals each FINALIZED segment once, chained from the genesis hash, and the chain report passes', async () => {
    const c = await camera('seal-a');
    const catalog = new RecordingCatalog(prisma);
    const a = await register(catalog, c, makeClip(`${c.cameraId}-a.mp4`, 0), 0);
    const b = await register(catalog, c, makeClip(`${c.cameraId}-b.mp4`, 90), 1);
    await register(catalog, c, a.filePath, 0); // same file again: no second seal

    const seals = await prisma.segmentSeal.findMany({ where: { cameraId: c.cameraId }, orderBy: { sequence: 'asc' } });
    expect(seals.map((s) => [s.sequence, s.segmentId])).toEqual([[1, a.id], [2, b.id]]);
    expect(seals[0].prevSealHash).toBe('0'.repeat(64));
    expect(seals[1].prevSealHash).toBe(seals[0].sealHash);
    expect(seals[0].mediaSha256).toBe(sha(fs.readFileSync(a.filePath)));

    const report = await new SegmentSealer(prisma).verifyCameraChain(c.cameraId);
    expect(report).toMatchObject({ valid: true, sealCount: 2, headSequence: 2, signaturesChecked: 2, problems: [], lastAnchor: null, unanchoredSeals: 2 });
  });

  it('does not seal with the flag off, nor an unreadable file', async () => {
    const c = await camera('seal-off');
    const catalog = new RecordingCatalog(prisma);
    delete process.env[FLAG];
    await register(catalog, c, makeClip(`${c.cameraId}-a.mp4`, 0), 0);
    process.env[FLAG] = 'true';
    const bad = path.join(process.env.RECORDINGS_DIR!, `${c.cameraId}-junk.mp4`);
    fs.writeFileSync(bad, 'not a video');
    const row = await catalog.registerSegment({ tenantId: c.tenantId, cameraId: c.cameraId, filePath: bad });
    expect(row.status).toBe(SegmentStatus.CORRUPTED);
    expect(await prisma.segmentSeal.count({ where: { cameraId: c.cameraId } })).toBe(0);
  });

  it('keeps one gap-free chain when many segments of one camera register at once', async () => {
    const c = await camera('seal-race');
    const files = Array.from({ length: 6 }, (_, i) => makeClip(`${c.cameraId}-${i}.mp4`, i * 40));
    await Promise.all(files.map((f, i) => register(new RecordingCatalog(prisma), c, f, i)));
    const seals = await prisma.segmentSeal.findMany({ where: { cameraId: c.cameraId }, orderBy: { sequence: 'asc' } });
    expect(seals.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await new SegmentSealer(prisma).verifyCameraChain(c.cameraId)).valid).toBe(true);
  });

  it('a sealing failure never fails registration, and warns at most once an hour', async () => {
    const c = await camera('seal-nokey');
    const catalog = new RecordingCatalog(prisma);
    (catalog as any).sealer = new SegmentSealer(prisma, () => {
      throw new Error('appliance key unreadable');
    });
    const a = await register(catalog, c, makeClip(`${c.cameraId}-a.mp4`, 0), 0);
    const b = await register(catalog, c, makeClip(`${c.cameraId}-b.mp4`, 60), 1);
    expect([a.status, b.status]).toEqual([SegmentStatus.FINALIZED, SegmentStatus.FINALIZED]);
    expect(await prisma.segmentSeal.count({ where: { cameraId: c.cameraId } })).toBe(0);
    const warnings = await prisma.event.findMany({ where: { cameraId: c.cameraId, title: 'Recorded segment could not be sealed' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].description).toMatch(/appliance key unreadable/);
  });
});

describe('the first hash wins', () => {
  it('a sealed file registered again with other bytes keeps its hash, becomes CORRUPTED, and is reported once', async () => {
    const c = await camera('seal-swap');
    const catalog = new RecordingCatalog(prisma);
    const a = await register(catalog, c, makeClip(`${c.cameraId}-a.mp4`, 0), 0);
    const original = a.sha256Hash;
    fs.copyFileSync(makeClip(`${c.cameraId}-other.mp4`, 150), a.filePath); // replaced on disk (different bytes)

    const again = await register(catalog, c, a.filePath, 0);
    expect(again.status).toBe(SegmentStatus.CORRUPTED);
    expect(again.quarantineReason).toBe('DIFFERS_FROM_SEAL');
    expect(again.sha256Hash).toBe(original);
    await register(catalog, c, a.filePath, 0); // the crawler comes back every pass

    const audits = await prisma.auditEvent.findMany({ where: { tenantId: c.tenantId, action: 'SEGMENT_INTEGRITY_FAILURE', resourceId: a.id } });
    expect(audits).toHaveLength(1);
    expect((audits[0].metadataJson as any).reason).toBe('DIFFERS_FROM_SEAL');
    expect(await prisma.event.count({ where: { cameraId: c.cameraId, title: 'Recording file failed its integrity check' } })).toBe(1);
    expect(await prisma.segmentSeal.count({ where: { cameraId: c.cameraId } })).toBe(1);
  });

  it('the periodic check catches a stored hash rewritten to match a swapped file', async () => {
    const c = await camera('seal-db');
    const catalog = new RecordingCatalog(prisma);
    const a = await register(catalog, c, makeClip(`${c.cameraId}-a.mp4`, 0), 0);
    fs.copyFileSync(makeClip(`${c.cameraId}-other.mp4`, 200), a.filePath);
    await prisma.recordingSegment.update({ where: { id: a.id }, data: { sha256Hash: sha(fs.readFileSync(a.filePath)), sizeBytes: BigInt(fs.statSync(a.filePath).size) } });
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(a.filePath, old, old);

    const before = await new SegmentSealer(prisma).verifyCameraChain(c.cameraId);
    expect(before.valid).toBe(false);
    expect(before.problems.map((p) => p.problem)).toEqual(['STORED_HASH_DIFFERS']);

    // Older rows from other suites may be due first; run until this one is checked.
    const verifier = new SegmentIntegrityVerifier(prisma);
    for (let i = 0; i < 50; i++) {
      await verifier.runCycle({ presenceBatch: 0, hashBudgetBytes: 50_000_000 });
      if ((await prisma.recordingSegment.findUniqueOrThrow({ where: { id: a.id } })).status !== SegmentStatus.FINALIZED) break;
    }
    const row = await prisma.recordingSegment.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.status).toBe(SegmentStatus.CORRUPTED);
    expect(row.quarantineReason).toBe('DB_HASH_DIFFERS_FROM_SEAL');
  });
});

describe('the chain report and anchors', () => {
  it('finds an edited seal, a removed seal and a tail cut after an anchor', async () => {
    const c = await camera('seal-chain');
    const catalog = new RecordingCatalog(prisma);
    for (let i = 0; i < 4; i++) await register(catalog, c, makeClip(`${c.cameraId}-${i}.mp4`, i * 50), i);
    const sealer = new SegmentSealer(prisma);

    expect(await sealer.anchorAll()).toBeGreaterThanOrEqual(1);
    const anchors = () => prisma.auditEvent.findMany({ where: { tenantId: c.tenantId, action: SEAL_ANCHOR_ACTION } });
    expect(await anchors()).toHaveLength(1);
    await sealer.anchorAll();
    expect(await anchors()).toHaveLength(1); // nothing new: no second anchor
    expect(((await anchors())[0].metadataJson as any).sequence).toBe(4);
    expect(await sealer.verifyCameraChain(c.cameraId)).toMatchObject({ valid: true, unanchoredSeals: 0, lastAnchor: { sequence: 4 } });

    const seals = await prisma.segmentSeal.findMany({ where: { cameraId: c.cameraId }, orderBy: { sequence: 'asc' } });
    await prisma.segmentSeal.update({ where: { id: seals[1].id }, data: { endUtc: new Date(seals[1].endUtc.getTime() + 5000) } });
    // An edited body no longer matches its hash, nor its signature.
    expect((await sealer.verifyCameraChain(c.cameraId)).problems.map((p) => p.problem)).toEqual(['SEAL_HASH_MISMATCH', 'BAD_SIGNATURE']);

    await prisma.segmentSeal.delete({ where: { id: seals[1].id } });
    expect((await sealer.verifyCameraChain(c.cameraId)).problems.map((p) => p.problem)).toEqual(['SEQUENCE_GAP']);

    await prisma.segmentSeal.delete({ where: { id: seals[3].id } }); // the anchored head
    expect((await sealer.verifyCameraChain(c.cameraId)).problems.map((p) => p.problem)).toEqual(['SEQUENCE_GAP', 'ANCHORED_SEAL_MISSING']);
  });

  it('a seal re-signed by another key is not passed as checked', async () => {
    const c = await camera('seal-key');
    await register(new RecordingCatalog(prisma), c, makeClip(`${c.cameraId}-a.mp4`, 0), 0);
    await prisma.segmentSeal.updateMany({ where: { cameraId: c.cameraId }, data: { signature: Buffer.alloc(64).toString('base64') } });
    expect((await new SegmentSealer(prisma).verifyCameraChain(c.cameraId)).problems.map((p) => p.problem)).toEqual(['BAD_SIGNATURE']);
  });
});

describe('seals in the evidence package', () => {
  let tenantId = '';
  let cameraId = '';
  let userId = '';
  let zip = '';
  const exportNow = async () => {
    const { EvidenceArchive } = require('../services/evidence/archive/evidenceArchive.service');
    return new EvidenceArchive(prisma).processExport({ tenantId, cameraId, requestedById: userId, startTime: new Date(t0), endTime: new Date(t0 + 3000) });
  };

  beforeAll(async () => {
    process.env[FLAG] = 'true';
    const c = await camera('seal-pkg');
    ({ tenantId, cameraId } = c);
    ({ userId } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
    const catalog = new RecordingCatalog(prisma);
    for (let i = 0; i < 3; i++) await register(catalog, c, makeClip(`${cameraId}-${i}.mp4`, i * 70), i);
  });

  it('carries segment_seals.json, and vigilone-verify --require-segment-seals passes it', async () => {
    zip = await exportNow();
    const r = verify(zip, '--require-segment-seals');
    expect(failed(r)).toEqual([]);
    for (const id of ['seals.artifact_bound', 'seals.summary_matches', 'seals.hashes', 'seals.signatures', 'seals.chain', 'seals.leaves_match', 'seals.coverage']) expect(statusOf(r, id)).toBe('PASS');
    const manifest = JSON.parse(fs.readFileSync(path.join(unzip(zip), 'manifest.json'), 'utf8'));
    expect(manifest.segmentSeals).toMatchObject({ artifact: 'segment_seals.json', sealCount: 3, exportedSegmentsSealed: 3, exportedSegmentCount: 3 });
  });

  it('rejects an edited seal body, a dropped middle seal and a seal that no longer matches its leaf', () => {
    const base = unzip(zip);
    const variant = (f: (doc: any) => void) => {
      const d = fs.mkdtempSync(path.join(tmp, 't-'));
      fs.cpSync(base, d, { recursive: true });
      const p = path.join(d, 'segment_seals.json');
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      f(doc);
      fs.writeFileSync(p, JSON.stringify(doc));
      return verify(d);
    };
    // The artifact table in the signed manifest catches any edit; the seal checks name what was changed.
    const edited = variant((d) => (d.seals[0].body.mediaSha256 = 'f'.repeat(64)));
    expect(failed(edited)).toEqual(expect.arrayContaining(['seals.hashes']));
    const dropped = variant((d) => d.seals.splice(1, 1));
    expect(failed(dropped)).toEqual(expect.arrayContaining(['seals.chain']));
    const rehashed = variant((d) => {
      const b = d.seals[2].body;
      b.mediaSha256 = 'e'.repeat(64);
      d.seals[2].sealHash = sha(require('../utils/license').canonicalizeJson(b));
    });
    expect(failed(rehashed)).toEqual(expect.arrayContaining(['seals.signatures', 'seals.leaves_match']));
  });

  it('refuses to export a sealed segment whose file no longer matches its seal, even when the stored hash was rewritten', async () => {
    const seg = await prisma.recordingSegment.findFirstOrThrow({ where: { cameraId }, orderBy: { startTime: 'asc' } });
    fs.copyFileSync(makeClip(`${cameraId}-other.mp4`, 300), seg.filePath);
    await prisma.recordingSegment.update({ where: { id: seg.id }, data: { sha256Hash: sha(fs.readFileSync(seg.filePath)) } });
    await expect(exportNow()).rejects.toThrow(/EXPORT_SEGMENT_SEAL_MISMATCH/);
  });

  it('without the section, --require-segment-seals fails and a plain run warns', async () => {
    const c = await camera('seal-none');
    delete process.env[FLAG];
    ({ tenantId, cameraId } = c);
    ({ userId } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
    await register(new RecordingCatalog(prisma), c, makeClip(`${cameraId}-a.mp4`, 0), 0);
    const plain = await exportNow();
    expect(statusOf(verify(plain), 'seals.present')).toBe('WARN');
    expect(failed(verify(plain, '--require-segment-seals'))).toEqual(['seals.present']);
  });
});

describe('the chain report route', () => {
  it('answers for a camera of the caller\'s tenant, 404 for another tenant\'s camera, and 501 with the flag off', async () => {
    const mine = await camera('seal-api');
    const other = await camera('seal-api-other');
    await register(new RecordingCatalog(prisma), mine, makeClip(`${mine.cameraId}-a.mp4`, 0), 0);
    const { token } = await createUserWithToken(prisma, mine.tenantId, 'VIEWER');
    const app = await startApp();
    const get = (cam: string) => fetch(`${app.url}/api/v1/segment-seals/cameras/${cam}/verify`, { headers: { authorization: `Bearer ${token}` } });
    try {
      const ok = await get(mine.cameraId);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as any).report).toMatchObject({ cameraId: mine.cameraId, valid: true, sealCount: 1 });
      expect((await get(other.cameraId)).status).toBe(404);
      delete process.env[FLAG];
      expect((await get(mine.cameraId)).status).toBe(501);
    } finally {
      await app.close();
    }
  });
});
