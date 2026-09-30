/**
 * Phase 6 off-site archive against a REAL S3-compatible server: S3_TEST_ENDPOINT (MinIO in CI; moto locally).
 * Skipped without it unless VIGILONE_REQUIRE_S3=1. The checks that need a server which verifies signatures and
 * payload hashes (wrong keys, a body that differs from its signed SHA-256) run only when
 * S3_TEST_VERIFIES_AUTH=1 (MinIO does; moto does not). Segment files are SIMULATED random bytes.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { ObjectStorageArchiveService, ArchiveWorker } from '../services/storage/objectStorageArchive.service';
import { S3Client } from '../services/storage/s3Client';

const endpoint = process.env.S3_TEST_ENDPOINT;
const verifiesAuth = process.env.S3_TEST_VERIFIES_AUTH === '1';
const keyId = process.env.S3_TEST_ACCESS_KEY || 'testkey';
const secret = process.env.S3_TEST_SECRET_KEY || 'testsecret';
const required = process.env.VIGILONE_REQUIRE_S3 === '1';
jest.setTimeout(180000);

describe('S3 test server', () => {
  it('is configured, or this run does not require it (VIGILONE_REQUIRE_S3)', () => {
    if (!endpoint && required) throw new Error('set S3_TEST_ENDPOINT (and keys) to an S3-compatible server');
    expect(Boolean(endpoint) || !required).toBe(true);
  });
});

(endpoint ? describe : describe.skip)('off-site archive against a real S3-compatible server', () => {
  const prisma = new PrismaClient();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-'));
  const bucket = `vigilone-test-${crypto.randomBytes(4).toString('hex')}`;
  const saved = { ...process.env };
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  let app: { url: string; close: () => Promise<void> };
  let tenantId = '';
  let cameraId = '';
  let otherTenant = '';
  let admin = '';
  let client: S3Client;
  const svc = () => new ObjectStorageArchiveService(prisma);

  async function segment(bytes: number, opts: { pinned?: boolean; t?: string; cam?: string } = {}) {
    const data = crypto.randomBytes(bytes);
    const file = path.join(tmp, `${crypto.randomUUID()}.fmp4`);
    fs.writeFileSync(file, data);
    const start = new Date(Date.now() - 600_000);
    const seg = await prisma.recordingSegment.create({ data: { tenantId: opts.t ?? tenantId, cameraId: opts.cam ?? cameraId, filePath: file, startTime: start, endTime: new Date(start.getTime() + 60_000), durationMs: 60_000, sizeBytes: BigInt(bytes), sha256Hash: sha(data), status: 'FINALIZED' } });
    if (opts.pinned) await prisma.evidencePin.create({ data: { tenantId: opts.t ?? tenantId, segmentId: seg.id, exportJobId: 'incident-hold-test', reason: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
    return { seg, data, file };
  }
  const configure = async (body: Record<string, unknown>) => {
    const r = await fetch(`${app.url}/api/v1/archive/config`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify({ endpoint, bucket, region: 'us-east-1', accessKey: keyId, secretKey: secret, bandwidthLimitKbps: 0, enabled: true, ...body }) });
    return { status: r.status, json: (await r.json()) as any };
  };
  // A window that excludes / includes the current minute.
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const closedWindow = () => ({ offPeakStartUtc: hhmm(new Date(Date.now() + 2 * 3_600_000)), offPeakEndUtc: hhmm(new Date(Date.now() + 3 * 3_600_000)) });
  const openWindow = () => ({ offPeakStartUtc: hhmm(new Date(Date.now() - 3_600_000)), offPeakEndUtc: hhmm(new Date(Date.now() + 3_600_000)) });

  beforeAll(async () => {
    process.env.VIGILONE_FEATURE_OBJECT_STORAGE_ARCHIVE = 'true';
    process.env.ARCHIVE_ALLOW_INSECURE_ENDPOINT = 'true';
    ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'arch'));
    otherTenant = (await createTenantWithCamera(prisma, 'arch-other')).tenantId;
    admin = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
    client = new S3Client({ endpoint, region: 'us-east-1', bucket, accessKeyId: keyId, secretAccessKey: secret });
    await client.createBucket();
    app = await startApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenant] } } });
    await prisma.$disconnect();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.env = saved;
  });

  it('stores credentials encrypted and never returns them; refuses a bad window or an insecure endpoint', async () => {
    const r = await configure(closedWindow());
    expect(r.status).toBe(200);
    expect(r.json.config).not.toHaveProperty('secretKeyEncrypted');
    expect(r.json.config.credentialsSet).toBe(true);
    const row = await prisma.objectStorageConfig.findUniqueOrThrow({ where: { tenantId } });
    expect(row.secretKeyEncrypted).not.toContain(secret);
    expect(row.accessKeyEncrypted).not.toBe(keyId);
    const get = await fetch(`${app.url}/api/v1/archive/config`, { headers: { authorization: `Bearer ${admin}` } });
    expect(JSON.stringify(await get.json())).not.toContain(row.secretKeyEncrypted);
    expect((await configure({ offPeakStartUtc: '25:00' })).status).toBe(400);
    delete process.env.ARCHIVE_ALLOW_INSECURE_ENDPOINT;
    expect((await configure({})).status).toBe(400); // http endpoint without the lab switch
    process.env.ARCHIVE_ALLOW_INSECURE_ENDPOINT = 'true';
  });

  it('outside the window only pinned evidence is uploaded; inside it the rest follows; stored bytes are identical', async () => {
    await configure(closedWindow());
    const pinned = await segment(300_000, { pinned: true });
    const normal = await segment(1_200_000);
    const w = new ArchiveWorker(svc());
    const r1 = (await w.runOnce())!;
    expect(r1.queued).toBe(2);
    const byPath = async (p: string) => prisma.archiveJob.findFirstOrThrow({ where: { tenantId, segmentPath: p } });
    expect(await byPath(pinned.file)).toMatchObject({ status: 'COMPLETED', priority: true });
    expect(await byPath(normal.file)).toMatchObject({ status: 'QUEUED', priority: false });
    expect(r1.results.map((x) => x.status).sort()).toEqual(['COMPLETED', 'DEFERRED']);

    await configure(openWindow());
    const r2 = (await w.runOnce())!;
    expect(r2.queued).toBe(0);
    const job = await byPath(normal.file);
    expect(job.status).toBe('COMPLETED');
    expect(job.objectKey).toBe(`archive/${tenantId}/${cameraId}/${sha(normal.data)}.fmp4`);
    const head = await client.head(job.objectKey);
    expect(head).toMatchObject({ sizeBytes: normal.data.length, sha256: sha(normal.data) });
    expect((await client.get(job.objectKey)).equals(normal.data)).toBe(true);
  });

  it('the same content under another path is recognised as already stored; a changed local file is never uploaded', async () => {
    await configure(openWindow());
    const a = await segment(50_000);
    await new ArchiveWorker(svc()).runOnce();
    const copy = path.join(tmp, 'copy.fmp4');
    fs.copyFileSync(a.file, copy);
    const s2 = await prisma.recordingSegment.create({ data: { tenantId, cameraId, filePath: copy, startTime: new Date(), endTime: new Date(), durationMs: 1, sizeBytes: BigInt(a.data.length), sha256Hash: sha(a.data), status: 'FINALIZED' } });
    const job2 = await svc().queueSegment(tenantId, s2.id);
    expect((await svc().processArchiveJob(job2.id)).skippedDuplicate).toBe(true);

    const bad = await segment(40_000);
    fs.appendFileSync(bad.file, 'tamper');
    const jb = await svc().queueSegment(tenantId, bad.seg.id);
    const r = await svc().processArchiveJob(jb.id);
    expect(r).toMatchObject({ status: 'FAILED' });
    expect((await prisma.archiveJob.findUniqueOrThrow({ where: { id: jb.id } })).error).toMatch(/does not match the index/);
    expect(await client.head(jb.objectKey)).toBeNull();
  });

  it('a missing local file is retried up to the limit, then FAILED with the reason', async () => {
    await configure(openWindow());
    const g = await segment(10_000);
    fs.rmSync(g.file);
    const job = await svc().queueSegment(tenantId, g.seg.id);
    const outcomes = [];
    for (let i = 0; i < 3; i++) outcomes.push((await svc().processArchiveJob(job.id)).status);
    expect(outcomes).toEqual(['RETRY', 'RETRY', 'FAILED']);
    expect((await prisma.archiveJob.findUniqueOrThrow({ where: { id: job.id } })).error).toMatch(/gone locally/);
  });

  it('the queue API takes a segment id of this tenant only, never a file path', async () => {
    const post = async (body: unknown) => (await fetch(`${app.url}/api/v1/archive/queue`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
    expect(await post({ segmentPath: '/etc/passwd', sha256Checksum: 'a'.repeat(64), sizeBytes: 1, cameraId })).toBe(400);
    const theirs = await segment(1000, { t: otherTenant, cam: (await prisma.camera.findFirstOrThrow({ where: { tenantId: otherTenant } })).id });
    expect(await post({ segmentId: theirs.seg.id })).toBe(404);
    const mine = await segment(1000);
    expect(await post({ segmentId: mine.seg.id })).toBe(201);
  });

  (verifiesAuth ? it : it.skip)('the server refuses wrong keys and a body that differs from its signed SHA-256', async () => {
    const wrong = new S3Client({ endpoint, region: 'us-east-1', bucket, accessKeyId: keyId, secretAccessKey: 'not-the-secret' });
    await expect(wrong.head('anything')).rejects.toThrow(/403|SignatureDoesNotMatch|HTTP403/);
    const f = path.join(tmp, 'lie.bin');
    fs.writeFileSync(f, 'actual bytes');
    await expect(client.putFile('lie.bin', f, sha(Buffer.from('other bytes!')), 12)).rejects.toThrow(/XAmzContentSHA256Mismatch|BadDigest|400/);
    expect(await client.head('lie.bin')).toBeNull();
  });
});
