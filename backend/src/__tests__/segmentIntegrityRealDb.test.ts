/**
 * F7 (docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md): footage is re-checked while the appliance runs. A cheap
 * presence and size check goes round all segments in batches; a hash check, limited by a byte budget per cycle, goes
 * evidence-pinned segments first. A failure marks the row and says so (audit entry, event, and for pinned evidence a
 * CRITICAL alarm); nothing is ever deleted, moved or repaired by this check. Real database and real files.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-integrity-'));
const previousGrace = process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS = '120';

import { PrismaClient, SegmentStatus } from '@prisma/client';
import { RecordingCatalog } from '../services/recording/catalog/recordingCatalog.service';
import { SegmentIntegrityVerifier } from '../services/recording/catalog/segmentIntegrity';
import { createTenantWithCamera } from './helpers/realDb';

jest.setTimeout(60000);

const prisma = new PrismaClient();
let tenantId = '';
let cameraId = '';
let seq = 0;
const T0 = Date.parse('2026-10-05T10:00:00Z');
const BIG = 1_000_000_000;

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A finalized segment with a real file of the given bytes, aged past the active-write grace. */
async function segment(over: Record<string, any> = {}, bytes: Buffer = crypto.randomBytes(4096)) {
  seq += 1;
  const file = path.join(root, `s${seq}.mp4`);
  fs.writeFileSync(file, bytes);
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  return prisma.recordingSegment.create({
    data: {
      tenantId, cameraId, filePath: file, startTime: new Date(T0 + seq * 600_000), endTime: new Date(T0 + seq * 600_000 + 599_000),
      durationMs: 599_000, sizeBytes: BigInt(bytes.length), sha256Hash: sha(bytes), status: SegmentStatus.FINALIZED, ...over,
    },
  });
}
const pin = (segmentId: string) =>
  prisma.evidencePin.create({ data: { tenantId, segmentId, exportJobId: 'job', reason: 'test', expiresAt: new Date(Date.now() + 86_400_000), pinType: 'LEGAL_HOLD' } });
const row = (id: string) => prisma.recordingSegment.findUniqueOrThrow({ where: { id } });
const verifier = () => new SegmentIntegrityVerifier(prisma);
const cycle = (over: Record<string, number> = {}) => verifier().runCycle({ presenceBatch: 1000, hashBudgetBytes: BIG, ...over });

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'integrity'));
});
afterAll(async () => {
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousGrace === undefined) delete process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
  else process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS = previousGrace;
});
afterEach(async () => {
  await prisma.alarm.deleteMany({ where: { tenantId } });
  await prisma.event.deleteMany({ where: { cameraId } });
  await prisma.recordingSegment.deleteMany({ where: { cameraId } });
});

describe('presence and size (cheap tier)', () => {
  it('a healthy segment stays FINALIZED and is stamped as checked', async () => {
    const s = await segment();
    const r = await cycle({ hashBudgetBytes: 0 });
    expect(r.presenceChecked).toBe(1);
    const after = await row(s.id);
    expect(after.status).toBe(SegmentStatus.FINALIZED);
    expect(after.integrityCheckedAt).not.toBeNull();
  });

  it('a file that vanished while running becomes FILE_MISSING, with an audit entry and a warning event, and the row is kept', async () => {
    const s = await segment();
    fs.rmSync(s.filePath);
    const r = await cycle({ hashBudgetBytes: 0 });
    expect(r.missing).toBe(1);
    const after = await row(s.id);
    expect([after.status, after.quarantineReason]).toEqual([SegmentStatus.FILE_MISSING, 'FILE_MISSING_DURING_RUN']);
    expect(await prisma.auditEvent.count({ where: { tenantId, action: 'SEGMENT_INTEGRITY_FAILURE', resourceId: s.id } })).toBe(1);
    const ev = await prisma.event.findFirstOrThrow({ where: { cameraId, type: 'RECORDING_FAILURE' } });
    expect(ev.severity).toBe('WARNING');
    expect(await prisma.alarm.count({ where: { tenantId } })).toBe(0);
  });

  it('a finalized file whose size changed becomes CORRUPTED (SIZE_CHANGED); the file is left where it is', async () => {
    const s = await segment();
    fs.appendFileSync(s.filePath, 'x');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(s.filePath, old, old); // a file changed just now counts as still being written; this one is old
    await cycle({ hashBudgetBytes: 0 });
    const after = await row(s.id);
    expect([after.status, after.quarantineReason]).toEqual([SegmentStatus.CORRUPTED, 'SIZE_CHANGED']);
    expect(fs.existsSync(s.filePath)).toBe(true);
  });

  it('a segment that crash recovery repaired is not flagged for its new size', async () => {
    const s = await segment({ repairedAt: new Date(), repairedSha256: 'a'.repeat(64) }, crypto.randomBytes(2048));
    fs.writeFileSync(s.filePath, crypto.randomBytes(3000)); // the repaired file differs in size from the original row
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(s.filePath, old, old);
    await cycle({ hashBudgetBytes: 0 });
    expect((await row(s.id)).status).toBe(SegmentStatus.FINALIZED);
  });

  it('skips a file modified inside the active-write grace, and rows that are not local or not FINALIZED', async () => {
    const fresh = await segment();
    fs.utimesSync(fresh.filePath, new Date(), new Date());
    const archived = await segment({ storageLocation: 'S3' });
    fs.rmSync(archived.filePath);
    const quarantined = await segment({ status: SegmentStatus.QUARANTINED });
    const r = await cycle({ hashBudgetBytes: 0 });
    expect(r.presenceChecked).toBe(0);
    expect((await row(fresh.id)).integrityCheckedAt).toBeNull();
    expect((await row(archived.id)).status).toBe(SegmentStatus.FINALIZED);
    expect((await row(quarantined.id)).status).toBe(SegmentStatus.QUARANTINED);
  });

  it('works through all segments in batches, least recently checked first', async () => {
    const all = [await segment(), await segment(), await segment(), await segment(), await segment()];
    await cycle({ presenceBatch: 2, hashBudgetBytes: 0 });
    await cycle({ presenceBatch: 2, hashBudgetBytes: 0 });
    expect((await Promise.all(all.map((s) => row(s.id)))).filter((r) => r.integrityCheckedAt).length).toBe(4);
    await cycle({ presenceBatch: 2, hashBudgetBytes: 0 });
    expect((await Promise.all(all.map((s) => row(s.id)))).every((r) => r.integrityCheckedAt)).toBe(true);
  });

  it('a segment marked bad no longer counts as footage in coverage', async () => {
    const s = await segment();
    fs.rmSync(s.filePath);
    await cycle({ hashBudgetBytes: 0 });
    const cov = await new RecordingCatalog(prisma).getCoverage(cameraId, new Date(T0), new Date(T0 + 86_400_000 * 2));
    expect(cov.coverageBlocks).toHaveLength(0);
  });
});

describe('content hash (budgeted tier)', () => {
  it('a segment whose bytes changed is marked CORRUPTED (HASH_MISMATCH) and left in place', async () => {
    const bytes = crypto.randomBytes(4096);
    const s = await segment({}, bytes);
    const flipped = Buffer.from(bytes);
    flipped[100] ^= 0xff; // same size, one byte different: only the hash can tell
    fs.writeFileSync(s.filePath, flipped);
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(s.filePath, old, old);
    const r = await cycle();
    expect(r.hashMismatch).toBe(1);
    const after = await row(s.id);
    expect([after.status, after.quarantineReason]).toEqual([SegmentStatus.CORRUPTED, 'HASH_MISMATCH']);
    expect(fs.existsSync(s.filePath)).toBe(true);
  });

  it('a matching hash is stamped as verified; a repaired segment is checked against its repaired hash', async () => {
    const good = await segment();
    const repairedBytes = crypto.randomBytes(1500);
    const rep = await segment({ repairedAt: new Date(), repairedSha256: sha(repairedBytes), sizeBytes: 1n }, repairedBytes);
    const r = await cycle();
    expect(r.hashChecked).toBe(2);
    expect((await row(good.id)).hashVerifiedAt).not.toBeNull();
    expect((await row(rep.id)).status).toBe(SegmentStatus.FINALIZED);
  });

  it('pinned evidence that fails raises a CRITICAL event and alarm; an unpinned failure raises neither', async () => {
    const pinned = await segment();
    await pin(pinned.id);
    const plain = await segment();
    for (const s of [pinned, plain]) {
      fs.writeFileSync(s.filePath, crypto.randomBytes(4096)); // same size, different content
      const old = new Date(Date.now() - 3600_000);
      fs.utimesSync(s.filePath, old, old);
    }
    await cycle();
    const alarms = await prisma.alarm.findMany({ where: { tenantId } });
    expect(alarms).toHaveLength(1);
    expect(alarms[0].severity).toBe('CRITICAL');
    expect(JSON.stringify(alarms[0].metadataJson)).toContain(pinned.id);
    expect((await prisma.event.findMany({ where: { cameraId } })).map((e) => e.severity).sort()).toEqual(['CRITICAL', 'WARNING']);
  });

  it('the byte budget limits the work per cycle, and pinned evidence is hashed first', async () => {
    const a = await segment();
    const b = await segment();
    const pinned = await segment();
    await pin(pinned.id);
    const r = await cycle({ hashBudgetBytes: 1 }); // enough for exactly one file
    expect(r.hashChecked).toBe(1);
    expect((await row(pinned.id)).hashVerifiedAt).not.toBeNull();
    expect([(await row(a.id)).hashVerifiedAt, (await row(b.id)).hashVerifiedAt]).toEqual([null, null]);
    await cycle({ hashBudgetBytes: 1 });
    await cycle({ hashBudgetBytes: 1 });
    expect([(await row(a.id)).hashVerifiedAt, (await row(b.id)).hashVerifiedAt].every(Boolean)).toBe(true);
  });

  it('pinned evidence goes first again once its last check is more than 24 hours old, and not before', async () => {
    const plain = await segment();
    const pinned = await segment({ hashVerifiedAt: new Date(Date.now() - 3600_000) });
    await pin(pinned.id);
    await cycle({ hashBudgetBytes: 1 });
    expect((await row(plain.id)).hashVerifiedAt).not.toBeNull(); // pinned was checked an hour ago: not due
    await prisma.recordingSegment.update({ where: { id: pinned.id }, data: { hashVerifiedAt: new Date(Date.now() - 25 * 3600_000) } });
    const plain2 = await segment();
    await cycle({ hashBudgetBytes: 1 });
    expect((await row(pinned.id)).hashVerifiedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000); // overdue: hashed first
    expect((await row(plain2.id)).hashVerifiedAt).toBeNull();
  });

  it('a budget of 0 turns the hash tier off', async () => {
    const s = await segment();
    const r = await cycle({ hashBudgetBytes: 0 });
    expect(r.hashChecked).toBe(0);
    expect((await row(s.id)).hashVerifiedAt).toBeNull();
  });

  it('a segment with no stored hash is not baselined here (it would bless whatever is on disk) and is counted', async () => {
    const s = await segment({ sha256Hash: null });
    const r = await cycle();
    expect(r.hashNoBaseline).toBe(1);
    expect((await row(s.id)).sha256Hash).toBeNull();
  });
});

describe('scheduling', () => {
  it('the catalog starts the checks only when the interval is above 0, and stops them', async () => {
    const catalog = new RecordingCatalog(prisma);
    const spy = jest.spyOn(global, 'setInterval');
    catalog.startIntegrityChecks(0);
    expect(spy).not.toHaveBeenCalled();
    catalog.startIntegrityChecks(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    catalog.stop();
    spy.mockRestore();
  });
});
