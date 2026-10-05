/**
 * ADR 0016 in the evidence package, on the real export path: the export carries incident_summaries.json (role
 * INCIDENT_SUMMARIES) with a signed manifest section, and the standalone offline verifier (separate process) passes it with
 * --require-incident-summaries. Edited sentences, moved citations, hostile facts, out-of-scope records and a corrupted
 * stored record are rejected.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken } from './helpers/realDb';

jest.setTimeout(180000);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'isumpkg-'));
process.env.EXPORTS_DIR = path.join(tmp, 'exports');
process.env.RECORDINGS_DIR = path.join(tmp, 'recordings');
fs.mkdirSync(process.env.EXPORTS_DIR, { recursive: true });
fs.mkdirSync(process.env.RECORDINGS_DIR, { recursive: true });

import { generateIncidentSummary } from '../services/incidentSummary/service';

const VERIFY = path.resolve(__dirname, '../../../tools/vigilone-verify/vigilone-verify.mjs');
const FLAG = 'VIGILONE_FEATURE_INCIDENT_SUMMARY';
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
const ctx = () => ({ tenantId, userId });

beforeAll(async () => {
  ({ tenantId, cameraId } = await createTenantWithCamera(prisma, 'isumpkg'));
  ({ userId } = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN'));
  const f = path.join(process.env.RECORDINGS_DIR!, 'seg0.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '10', f]);
  await prisma.recordingSegment.create({
    data: { tenantId, cameraId, filePath: f, startTime: new Date(t0), endTime: new Date(t0 + 3000), durationMs: 3000, sizeBytes: BigInt(fs.statSync(f).size), sha256Hash: sha(fs.readFileSync(f)) },
  });
  alarmInside = (await prisma.alarm.create({ data: { tenantId, cameraId, title: 'inside window', severity: 'CRITICAL', triggeredAt: new Date(t0 + 1500), acknowledgedAt: new Date(t0 + 2500), acknowledgedById: userId } })).id;
  alarmOutside = (await prisma.alarm.create({ data: { tenantId, cameraId, title: 'outside window', triggeredAt: new Date(t0 + 3_600_000) } })).id;
  await generateIncidentSummary(prisma, ctx(), alarmInside);
  await generateIncidentSummary(prisma, ctx(), alarmOutside);
});
afterAll(async () => {
  if (originalFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = originalFlag;
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('incident summaries in the evidence package (ADR 0016)', () => {
  it('flag ON: carries incident_summaries.json for the in-window alarm only and passes vigilone-verify --require-incident-summaries', async () => {
    process.env[FLAG] = 'true';
    exportZip = await exportNow();
    const r = verify(exportZip, '--require-incident-summaries');
    expect(r.out.results.filter((x: any) => x.status === 'FAIL')).toEqual([]);
    expect(r.code).toBe(0);
    for (const id of ['summary.artifact_bound', 'summary.summary_matches', 'summary.records_intact', 'summary.unique', 'summary.scope']) expect(statusOf(r, id)).toBe('PASS');

    const dir = unzip(exportZip);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'incident_summaries.json'), 'utf8'));
    expect(doc).toMatchObject({ schema: 'vigilone.incident-summaries.v1', cameraId });
    expect(doc.summaries).toHaveLength(1);
    expect(doc.summaries[0].facts.subject.id).toBe(alarmInside);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.incidentSummaries).toEqual({ schema: 'vigilone.incident-summaries.v1', artifact: 'incident_summaries.json', recordCount: 1, digestSha256: doc.digestSha256 });
    expect(manifest.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'incident_summaries.json', role: 'INCIDENT_SUMMARIES' })]));
    const exp = await prisma.evidenceExport.findFirstOrThrow({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
    expect((exp.manifestJson as any).incidentSummaries.digestSha256).toBe(doc.digestSha256);
  });

  it('the export holds the newest snapshot of an alarm, not the old one', async () => {
    process.env[FLAG] = 'true';
    await prisma.alarm.update({ where: { id: alarmInside }, data: { state: 'RESOLVED', resolvedAt: new Date(t0 + 2800), resolvedById: userId } });
    await generateIncidentSummary(prisma, ctx(), alarmInside);
    const zip = await exportNow();
    const doc = JSON.parse(fs.readFileSync(path.join(unzip(zip), 'incident_summaries.json'), 'utf8'));
    expect(doc.summaries).toHaveLength(1);
    expect(doc.summaries[0].text).toMatch(/was resolved by user/);
    expect(failed(verify(zip, '--require-incident-summaries'))).toEqual([]);
    exportZip = zip;
  });

  it('rejects an edited sentence, a moved citation, a fact edited with its hashes recomputed, and a stripped section', () => {
    const base = unzip(exportZip);
    const copy = () => {
      const d = fs.mkdtempSync(path.join(tmp, 't-'));
      fs.cpSync(base, d, { recursive: true });
      return d;
    };
    const rewrite = (d: string, f: (doc: any) => void) => {
      const doc = JSON.parse(fs.readFileSync(path.join(d, 'incident_summaries.json'), 'utf8'));
      f(doc);
      fs.writeFileSync(path.join(d, 'incident_summaries.json'), JSON.stringify(doc));
    };
    // 1. text edited after signing: the artifact hash no longer matches the signed manifest
    let d = copy();
    rewrite(d, (doc) => (doc.summaries[0].text = doc.summaries[0].text.replace('CRITICAL', 'INFO')));
    expect(failed(verify(d, '--require-incident-summaries'))).toContain('artifact:incident_summaries.json');

    // 2. a citation moved, and EVERY hash and the manifest recomputed and re-signed with another key: the checks that
    //    do not depend on the signature (re-rendering, citations) still catch it
    const { canonicalizeJson } = require('../services/evidence/archive/canonicalJson');
    const resign = (dir: string, mutate: (rec: any) => void) => {
      rewrite(dir, (doc) => {
        const rec = doc.summaries[0];
        mutate(rec);
        rec.text = rec.sentences.map((s: any) => (s.cites.length ? `${s.text} [${s.cites.join(', ')}]` : s.text)).join('\n');
        rec.textSha256 = sha(rec.text);
        rec.factsSha256 = sha(canonicalizeJson(rec.facts));
        const { recordSha256, ...rest } = rec;
        rec.recordSha256 = sha(canonicalizeJson(rest));
        doc.digestSha256 = sha(canonicalizeJson(doc.summaries.map((x: any) => x.recordSha256).sort()));
      });
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const docNow = JSON.parse(fs.readFileSync(path.join(dir, 'incident_summaries.json'), 'utf8'));
      m.incidentSummaries.digestSha256 = docNow.digestSha256;
      const art = m.artifacts.find((a: any) => a.path === 'incident_summaries.json');
      const bytes = fs.readFileSync(path.join(dir, 'incident_summaries.json'));
      art.sha256 = sha(bytes);
      art.byteLength = bytes.length;
      const mb = canonicalizeJson(m);
      const k = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(path.join(dir, 'manifest.json'), mb);
      fs.writeFileSync(path.join(dir, 'manifest.sha256'), sha(mb));
      fs.writeFileSync(path.join(dir, 'manifest.sig'), crypto.sign(null, Buffer.from(mb), k.privateKey).toString('base64'));
    };
    d = copy();
    resign(d, (rec) => (rec.sentences[0].cites = ['F2']));
    let r = verify(d, '--require-incident-summaries');
    expect(failed(r)).toContain('summary.records_intact');

    // 3. a fact edited and every hash recomputed: the text no longer equals what the template renders from the facts
    d = copy();
    resign(d, (rec) => (rec.facts.timeline[0].data.title = 'A different alarm'));
    r = verify(d, '--require-incident-summaries');
    expect(failed(r)).toContain('summary.records_intact');

    // 4. section removed, manifest re-signed: required, so it fails
    d = copy();
    const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
    delete m.incidentSummaries;
    const bytes = canonicalizeJson(m);
    const k2 = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(path.join(d, 'manifest.json'), bytes);
    fs.writeFileSync(path.join(d, 'manifest.sha256'), sha(bytes));
    fs.writeFileSync(path.join(d, 'manifest.sig'), crypto.sign(null, Buffer.from(bytes), k2.privateKey).toString('base64'));
    r = verify(d, '--require-incident-summaries');
    expect(failed(r)).toContain('summary.present');
    expect(r.code).toBe(1);
  });

  it('flag OFF and no stored records: no section (the verifier warns, and fails only under --require-incident-summaries)', async () => {
    delete process.env[FLAG];
    await prisma.incidentSummary.deleteMany({ where: { tenantId } });
    const zip = await exportNow();
    const dir = unzip(zip);
    expect(fs.existsSync(path.join(dir, 'incident_summaries.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).incidentSummaries).toBeUndefined();
    const soft = verify(zip);
    expect(soft.code).toBe(0);
    expect(statusOf(soft, 'summary.present')).toBe('WARN');
    const strict = verify(zip, '--require-incident-summaries');
    expect(strict.code).toBe(1);
    expect(failed(strict)).toEqual(['summary.present']);
  });

  it('flag OFF but records exist: they are still included', async () => {
    delete process.env[FLAG];
    await generateIncidentSummary(prisma, ctx(), alarmInside);
    const zip = await exportNow();
    const r = verify(zip, '--require-incident-summaries');
    expect(failed(r)).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('a stored record that no longer matches its row fails the export loudly instead of being dropped', async () => {
    process.env[FLAG] = 'true';
    const row = await prisma.incidentSummary.findFirstOrThrow({ where: { alarmId: alarmInside } });
    await prisma.incidentSummary.update({ where: { id: row.id }, data: { recordSha256: sha('tampered') } });
    await expect(exportNow()).rejects.toThrow(/does not match its own row/);
    await prisma.incidentSummary.update({ where: { id: row.id }, data: { recordSha256: row.recordSha256 } });
  });
});
