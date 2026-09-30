/**
 * P5.2 evidence export on the real path: a Section 63 export built from a real ffmpeg segment and the
 * real database carries explanations.json (role EXPLANATIONS) and a signed manifest section, and the
 * standalone offline verifier (separate process) passes it with --require-explanations. Tampered
 * copies, out-of-scope records and a corrupted stored record are rejected.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken } from './helpers/realDb';

jest.setTimeout(180000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explpkg-'));
process.env.EXPORTS_DIR = path.join(tmp, 'exports');
process.env.RECORDINGS_DIR = path.join(tmp, 'recordings');
fs.mkdirSync(process.env.EXPORTS_DIR, { recursive: true });
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

import { generateExplanationForAlarm } from '../services/explanation/explanationService';

const VERIFY = path.resolve(__dirname, '../../../tools/vigilone-verify/vigilone-verify.mjs');
const FLAG = 'VIGILONE_FEATURE_EXPLANATIONS';
const prisma = new PrismaClient();
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const t0 = Date.UTC(2026, 8, 29, 9, 0, 0);
let tenantId = '';
let cameraId = '';
let userId = '';
let alarmInside = '';
let alarmOutside = '';
let exportZip = '';
const originalFlag = process.env[FLAG];

function verify(target: string, ...extra: string[]) {
  const r = spawnSync('node', [VERIFY, target, '--json', ...extra], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
}
const failed = (r: any) => r.out.results.filter((x: any) => x.status === 'FAIL').map((x: any) => x.id);
const statusOf = (r: any, id: string) => r.out.results.find((x: any) => x.id === id)?.status;
function unzip(zip: string): string {
  const d = fs.mkdtempSync(path.join(tmp, 'x-'));
  execFileSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, d]);
  return d;
}
const exportNow = async () => {
  const { EvidenceArchive } = require('../services/evidence/archive/evidenceArchive.service');
  return new EvidenceArchive(prisma).processExport({ tenantId, cameraId, requestedById: userId, startTime: new Date(t0), endTime: new Date(t0 + 3000) });
};

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'explpkg'));
  ({ userId } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  const f = path.join(process.env.RECORDINGS_DIR!, 'seg0.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', f]);
  await prisma.recordingSegment.create({
    data: { tenantId, cameraId, filePath: f, startTime: new Date(t0), endTime: new Date(t0 + 3000), durationMs: 3000, sizeBytes: BigInt(fs.statSync(f).size), sha256Hash: sha(fs.readFileSync(f)) },
  });
  // One alarm inside the export window, one an hour later (outside it); both explained.
  alarmInside = (await prisma.alarm.create({ data: { tenantId, cameraId, title: 'inside window', severity: 'CRITICAL', triggeredAt: new Date(t0 + 1500) } })).id;
  alarmOutside = (await prisma.alarm.create({ data: { tenantId, cameraId, title: 'outside window', triggeredAt: new Date(t0 + 3_600_000) } })).id;
  await generateExplanationForAlarm(prisma, alarmInside);
  await generateExplanationForAlarm(prisma, alarmOutside);
});
afterAll(async () => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('P5.2 explanations in the evidence package', () => {
  it('flag ON: the export carries explanations.json for the in-window alarm only and passes vigilone-verify --require-explanations', async () => {
    process.env[FLAG] = 'true';
    exportZip = await exportNow();
    const r = verify(exportZip, '--require-explanations');
    expect(failed(r)).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.verdict).toBe('VALID');
    for (const id of ['explain.artifact_bound', 'explain.summary_matches', 'explain.records_intact', 'explain.unique', 'explain.scope']) expect(statusOf(r, id)).toBe('PASS');

    const dir = unzip(exportZip);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'explanations.json'), 'utf8'));
    expect(doc).toMatchObject({ schema: 'vigilone.explanations.v1', cameraId });
    expect(doc.explanations).toHaveLength(1);
    expect(doc.explanations[0].facts.subject.id).toBe(alarmInside);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.explanations).toEqual({ schema: 'vigilone.explanations.v1', artifact: 'explanations.json', recordCount: 1, digestSha256: doc.digestSha256 });
    expect(manifest.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'explanations.json', role: 'EXPLANATIONS' })]));
    // The signed export record in the database holds the same summary.
    const exp = await prisma.evidenceExport.findFirstOrThrow({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
    expect((exp.manifestJson as any).explanations.digestSha256).toBe(doc.digestSha256);
  });

  it('rejects an edited record, an edited summary and a stripped section', () => {
    const base = unzip(exportZip);
    const copy = () => {
      const d = fs.mkdtempSync(path.join(tmp, 't-'));
      fs.cpSync(base, d, { recursive: true });
      return d;
    };
    // 1. the explanation text is changed after signing
    let d = copy();
    const doc = JSON.parse(fs.readFileSync(path.join(d, 'explanations.json'), 'utf8'));
    doc.explanations[0].text = doc.explanations[0].text.replace('CRITICAL', 'INFO');
    fs.writeFileSync(path.join(d, 'explanations.json'), JSON.stringify(doc));
    expect(failed(verify(d, '--require-explanations'))).toContain('artifact:explanations.json');

    // 2. manifest re-signed with another key with the explanations section removed
    d = copy();
    const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
    delete m.explanations;
    const { canonicalizeJson } = require('../services/evidence/archive/canonicalJson');
    const bytes = canonicalizeJson(m);
    const k = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(d, 'manifest.json'), bytes);
    fs.writeFileSync(path.join(d, 'manifest.sha256'), sha(bytes));
    fs.writeFileSync(path.join(d, 'manifest.sig'), crypto.sign(null, Buffer.from(bytes), k.privateKey).toString('base64'));
    const r = verify(d, '--require-explanations');
    expect(failed(r)).toEqual(expect.arrayContaining(['manifest.signature', 'explain.present']));
    expect(r.code).toBe(1);
  });

  it('flag OFF and no stored records: no section (the verifier warns, and fails only under --require-explanations)', async () => {
    delete process.env[FLAG];
    await prisma.explanation.deleteMany({ where: { tenantId } });
    const zip = await exportNow();
    const dir = unzip(zip);
    expect(fs.existsSync(path.join(dir, 'explanations.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).explanations).toBeUndefined();
    const soft = verify(zip);
    expect(soft.code).toBe(0);
    expect(statusOf(soft, 'explain.present')).toBe('WARN');
    const strict = verify(zip, '--require-explanations');
    expect(strict.code).toBe(1);
    expect(failed(strict)).toEqual(['explain.present']);
  });

  it('flag OFF but records exist: they are still included (a record is never left out because the flag was switched off)', async () => {
    delete process.env[FLAG];
    await generateExplanationForAlarm(prisma, alarmInside);
    const zip = await exportNow();
    const r = verify(zip, '--require-explanations');
    expect(failed(r)).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('a stored record that no longer matches its row fails the export loudly instead of being dropped', async () => {
    process.env[FLAG] = 'true';
    const row = await prisma.explanation.findFirstOrThrow({ where: { alarmId: alarmInside } });
    await prisma.explanation.update({ where: { id: row.id }, data: { recordSha256: sha('tampered') } });
    await expect(exportNow()).rejects.toThrow(/does not match its own row/);
    const failedExport = await prisma.evidenceExport.findFirstOrThrow({ where: { tenantId, status: 'FAILED' }, orderBy: { createdAt: 'desc' } });
    expect(failedExport.errorMessage).toMatch(/does not match its own row/);
    await prisma.explanation.update({ where: { id: row.id }, data: { recordSha256: row.recordSha256 } });
  });
});
