#!/usr/bin/env node
/**
 * Offline verification of a VigilOne evidence package (checklist F27-F29), independent of the
 * appliance software:
 *   - required files present (manifest.json, manifest.sha256, manifest.sig, appliance_public_key.pem)
 *   - manifest.sha256 equals SHA-256(manifest.json)
 *   - manifest.sig is a valid Ed25519 signature over the exact manifest.json bytes
 *   - every artifact listed in the manifest exists with the recorded byte length and SHA-256
 *   - no file in the package is missing from the manifest (except the signature/digest files)
 *
 *   node scripts/acceptance/verify-evidence-package.mjs Evidence_<id>.zip [--json]
 * Exit 0 only if every check passes. Needs Node >= 20 and `unzip`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { run } from '../lib/proc.mjs';

export async function verifyEvidencePackage(zipPath) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-verify-'));
  try {
    const unz = await run('unzip', ['-q', '-o', zipPath, '-d', dir], { timeoutMs: 300000 });
    if (unz.code !== 0) {
      add('unzip', false, unz.stderr.trim() || `unzip exited ${unz.code}`);
      return { zipPath, checks, verdict: 'FAIL' };
    }
    const need = ['manifest.json', 'manifest.sha256', 'manifest.sig', 'appliance_public_key.pem'];
    const missing = need.filter((f) => !fs.existsSync(path.join(dir, f)));
    add('required-files', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : need.join(', '));
    if (missing.length) return { zipPath, checks, verdict: 'FAIL' };

    const manifestBytes = fs.readFileSync(path.join(dir, 'manifest.json'));
    const digest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    const recorded = fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8').trim().split(/\s+/)[0];
    add('manifest-digest', digest === recorded, `sha256(manifest.json)=${digest}, manifest.sha256=${recorded}`);

    const sigText = fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8').trim();
    const sig = /^[0-9a-f]+$/i.test(sigText) && sigText.length === 128 ? Buffer.from(sigText, 'hex') : Buffer.from(sigText, 'base64');
    let sigOk = false;
    let sigDetail = '';
    try {
      const pub = crypto.createPublicKey(fs.readFileSync(path.join(dir, 'appliance_public_key.pem'), 'utf8'));
      sigDetail = `key type ${pub.asymmetricKeyType}`;
      sigOk = pub.asymmetricKeyType === 'ed25519' && crypto.verify(null, manifestBytes, pub, sig);
    } catch (err) {
      sigDetail = String(err.message || err);
    }
    add('manifest-signature', sigOk, sigOk ? `Ed25519 signature valid (${sigDetail})` : `signature does not verify over manifest.json (${sigDetail})`);

    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch (err) {
      add('manifest-json', false, String(err.message));
      return { zipPath, checks, verdict: 'FAIL' };
    }
    const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
    add('manifest-artifacts-listed', artifacts.length > 0, `${artifacts.length} artifact(s) listed`);
    for (const a of artifacts) {
      const p = path.join(dir, a.path);
      if (!path.resolve(p).startsWith(path.resolve(dir) + path.sep)) {
        add(`artifact:${a.path}`, false, 'path escapes the package');
        continue;
      }
      if (!fs.existsSync(p)) {
        add(`artifact:${a.path}`, false, 'listed in manifest but missing from package');
        continue;
      }
      const bytes = fs.readFileSync(p);
      const h = crypto.createHash('sha256').update(bytes).digest('hex');
      const lenOk = a.byteLength === undefined || Number(a.byteLength) === bytes.length;
      add(`artifact:${a.path}`, h === a.sha256 && lenOk, `sha256 ${h === a.sha256 ? 'matches' : `MISMATCH (${h} vs ${a.sha256})`}, ${bytes.length} bytes${lenOk ? '' : ` (manifest says ${a.byteLength})`}`);
    }
    const listed = new Set(artifacts.map((a) => path.normalize(a.path)));
    const walk = (d, rel = '') =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), path.join(rel, e.name)) : [path.join(rel, e.name)]));
    const extra = walk(dir).filter((f) => !['manifest.json', 'manifest.sha256', 'manifest.sig'].includes(f) && !listed.has(path.normalize(f)));
    add('no-unlisted-files', extra.length === 0, extra.length ? `not covered by the signed manifest: ${extra.join(', ')}` : 'every file is covered by the manifest');
    return { zipPath, checks, verdict: checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('acceptance', 'verify-evidence-package.mjs'))) {
  const zip = process.argv[2];
  if (!zip) {
    console.error('usage: verify-evidence-package.mjs <package.zip> [--json]');
    process.exit(2);
  }
  const res = await verifyEvidencePackage(path.resolve(zip));
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    for (const c of res.checks) console.log(`${c.status.padEnd(4)} ${c.name}: ${c.detail}`);
    console.log(`VERDICT: ${res.verdict}`);
  }
  process.exit(res.verdict === 'PASS' ? 0 : 1);
}
