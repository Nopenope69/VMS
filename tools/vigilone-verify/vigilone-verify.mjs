#!/usr/bin/env node
/**
 * vigilone-verify: offline verifier for VigilOne evidence packages (P4.5).
 *
 *   vigilone-verify <package.zip | extracted-dir> [--trusted-key key.pem | --trusted-key-sha256 HEX]
 *                   [--require-ai-provenance] [--json]
 *
 * Needs only Node.js >= 18. No network access and no dependencies. It checks:
 *   - manifest.json is canonical JSON; manifest.sha256 matches it; manifest.sig is a valid Ed25519
 *     signature by the key in the package (pin the key with --trusted-key to trust the appliance)
 *   - every file is listed in the manifest's artifacts table with the same size and SHA-256, and no
 *     file is unlisted
 *   - the primary media hash equals videoChecksumSha256
 *   - the Merkle root recomputed from the segment leaves equals evidenceMerkleRoot, and every
 *     source-segment inclusion proof holds
 *   - the chain-of-custody ledger links from genesis and every event hash recomputes, and the head
 *     equals the manifest's custody summary; the export (or redaction) event binds source to result
 *   - ai_provenance.json: every AI record names a model (name, version, SHA-256), confidence,
 *     timestamp and camera, and the counts match the signed summary
 *   - derivation.json (derivatives): the derivative hash, parent master hash and source segments
 *     agree with the manifest, the leaves and the custody ledger
 *
 * Exit codes: 0 all checks passed (warnings allowed), 1 a check failed, 2 usage or read error.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const VERSION = '1.0.0';
const MERKLE_DOMAIN = 'VIGILONE-EVIDENCE-SEGMENT-V1';
const GENESIS = '0'.repeat(64);
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- canonical JSON (same as backend)
export function canonicalizeJson(value) {
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  };
  return canon(value === undefined ? null : JSON.parse(JSON.stringify(value)));
}

// ---------------------------------------------------------------- ZIP reader (stored/deflate, ZIP64)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP file (no end of central directory)');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (buf.readUInt32LE(z64) !== 0x06064b50) throw new Error('bad ZIP64 end of central directory');
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdSize = Number(buf.readBigUInt64LE(z64 + 40));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    let lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = buf.readUInt16LE(x);
      const sz = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) (usize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (lho === 0xffffffff) lho = Number(buf.readBigUInt64LE(q));
      }
      x += 4 + sz;
    }
    p = xend + clen;
    if (name.endsWith('/')) continue;
    if (name.includes('..') || name.startsWith('/') || name.includes('\\')) throw new Error(`unsafe path in ZIP: ${name}`);
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`${name}: unsupported compression method ${method}`);
    if (data.length !== usize) throw new Error(`${name}: size ${data.length}, directory says ${usize}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC-32 mismatch`);
    if (files.has(name)) throw new Error(`duplicate entry ${name}`);
    files.set(name, data);
  }
  return files;
}

function readDir(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else files.set(path.relative(dir, f).split(path.sep).join('/'), fs.readFileSync(f));
    }
  };
  walk(dir);
  return files;
}

// ---------------------------------------------------------------- Merkle (same as backend MerkleTree)
function leafHash(l) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const seg = Buffer.from(l.segmentId, 'utf8');
  const cam = Buffer.from(l.cameraId, 'utf8');
  const t = Buffer.alloc(16);
  t.writeBigInt64LE(BigInt(Date.parse(l.startUtc)), 0);
  t.writeBigInt64LE(BigInt(Date.parse(l.endUtc)), 8);
  return sha256(Buffer.concat([Buffer.from(MERKLE_DOMAIN, 'utf8'), u32(seg.length), seg, u32(cam.length), cam, t, Buffer.from(l.mediaSha256, 'hex')]));
}
const combine = (a, b) => sha256(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')]));
function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256(Buffer.from(`${MERKLE_DOMAIN}:EMPTY`, 'utf8'));
  const sorted = [...leaves].sort((a, b) => (a.cameraId !== b.cameraId ? a.cameraId.localeCompare(b.cameraId) : Date.parse(a.startUtc) - Date.parse(b.startUtc) || a.segmentId.localeCompare(b.segmentId)));
  let level = sorted.map(leafHash);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(combine(level[i], level[i + 1] ?? level[i]));
    level = next;
  }
  return level[0];
}
function verifyProof(leaf, proof, root) {
  let h = leaf;
  for (const n of proof) h = n.position === 'left' ? combine(n.hash, h) : combine(h, n.hash);
  return h === root;
}

// ---------------------------------------------------------------- custody chain (same as backend CustodyLedger)
function custodyEventHash(e, prev, legacy) {
  const meta = e.metadata ? (legacy ? JSON.stringify(e.metadata) : canonicalizeJson(e.metadata)) : '{}';
  const payloadHash = sha256(`${e.sourceHash}:${e.resultHash || ''}:${meta}`);
  const ts = new Date(e.timestampUtc).toISOString();
  return sha256(`${prev}:${e.eventId}:${e.action}:${e.actorUserId}:${ts}:${payloadHash}`);
}

// ---------------------------------------------------------------- verification
export function verifyPackage(files, opts = {}) {
  const results = [];
  const check = (id, ok, detail = '', level = 'FAIL') => results.push({ id, status: ok ? 'PASS' : level, detail });
  const warn = (id, detail) => results.push({ id, status: 'WARN', detail });
  const json = (name) => {
    try {
      return JSON.parse(files.get(name).toString('utf8'));
    } catch (e) {
      check(`${name}.parse`, false, e.message);
      return null;
    }
  };

  const required = ['manifest.json', 'manifest.sha256', 'manifest.sig', 'appliance_public_key.pem'];
  const missing = required.filter((f) => !files.has(f));
  check('package.required_files', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : required.join(', '));
  if (missing.length) return results;

  const manifestBytes = files.get('manifest.json');
  const manifest = json('manifest.json');
  if (!manifest) return results;
  check('manifest.canonical', canonicalizeJson(manifest) === manifestBytes.toString('utf8'), 'manifest.json is canonical JSON');
  check('manifest.sha256', files.get('manifest.sha256').toString('utf8').trim() === sha256(manifestBytes), sha256(manifestBytes));

  const keyPem = files.get('appliance_public_key.pem').toString('utf8');
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, manifestBytes, keyPem, Buffer.from(files.get('manifest.sig').toString('utf8').trim(), 'base64'));
  } catch (e) {
    sigOk = false;
  }
  check('manifest.signature', sigOk, 'Ed25519 signature over manifest.json by the package key');
  const keyDer = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  const keyFp = sha256(keyDer);
  if (opts.trustedKeyPem) {
    const trusted = sha256(crypto.createPublicKey(opts.trustedKeyPem).export({ type: 'spki', format: 'der' }));
    check('trust.appliance_key', trusted === keyFp, `package key SPKI SHA-256 ${keyFp}`);
  } else if (opts.trustedKeySha256) {
    check('trust.appliance_key', opts.trustedKeySha256.toLowerCase() === keyFp, `package key SPKI SHA-256 ${keyFp}`);
  } else {
    warn('trust.appliance_key', `self-signed: the package key (SPKI SHA-256 ${keyFp}) was not compared with a trusted appliance key; pass --trusted-key`);
  }

  // Artifacts table
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  check('artifacts.present', artifacts.length > 0, `${artifacts.length} artifact(s)`);
  const listed = new Set(artifacts.map((a) => a.path));
  for (const a of artifacts) {
    const f = files.get(a.path);
    if (!f) {
      check(`artifact:${a.path}`, false, 'listed but missing');
      continue;
    }
    check(`artifact:${a.path}`, f.length === a.byteLength && sha256(f) === a.sha256, `${a.role} ${f.length} bytes sha256 ${sha256(f)}`);
  }
  const unlisted = [...files.keys()].filter((n) => !listed.has(n) && !['manifest.json', 'manifest.sha256', 'manifest.sig'].includes(n));
  check('artifacts.no_unlisted_files', unlisted.length === 0, unlisted.join(', '));
  const keyArt = artifacts.find((a) => a.role === 'TRUST_ANCHOR_PUBLIC_KEY');
  check('artifacts.key_bound', Boolean(keyArt && keyArt.path === 'appliance_public_key.pem'), 'the signing key is bound in the signed artifacts table');

  // Media
  const media = artifacts.find((a) => a.role === 'PRIMARY_MEDIA');
  check('media.hash', Boolean(media) && media.sha256 === manifest.videoChecksumSha256, media ? `${media.path} ${media.sha256}` : 'no PRIMARY_MEDIA artifact');

  // Merkle
  const leaves = Array.isArray(manifest.leaves) ? manifest.leaves : [];
  const badLeaves = leaves.filter((l) => !HEX64.test(l.mediaSha256 || '') || sha256(`UNFINALIZED:${l.segmentId}:${l.startUtc}`) === l.mediaSha256);
  check('merkle.leaf_media_hashes', badLeaves.length === 0, badLeaves.length ? `segment(s) without a media hash computed from their bytes: ${badLeaves.map((l) => l.segmentId).join(', ')}` : `${leaves.length} leaf/leaves`);
  const wrongLeaf = leaves.filter((l) => l.leafHash && leafHash(l) !== l.leafHash);
  check('merkle.leaf_hashes', wrongLeaf.length === 0, wrongLeaf.map((l) => l.segmentId).join(', '));
  const root = merkleRoot(leaves);
  check('merkle.root', root === manifest.evidenceMerkleRoot, `recomputed ${root}`);
  for (const s of manifest.sourceSegments || []) {
    check(`merkle.proof:${s.segmentId}`, verifyProof(leafHash({ segmentId: s.segmentId, cameraId: manifest.camera?.id, startUtc: s.startTimeUtc, endUtc: s.endTimeUtc, mediaSha256: s.mediaSha256 }), s.merkleProof || [], manifest.evidenceMerkleRoot));
  }

  // Custody
  const custodyArt = artifacts.find((a) => a.role === 'CUSTODY_LEDGER');
  const custody = custodyArt ? json(custodyArt.path) : null;
  if (!custody) check('custody.present', false, 'no chain-of-custody ledger in the package');
  else {
    const ev = [...custody].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    let prev = GENESIS;
    let ok = true;
    let legacy = 0;
    let detail = `${ev.length} event(s)`;
    ev.forEach((e, i) => {
      if (!ok) return;
      if (e.sequenceNumber !== i + 1) (ok = false), (detail = `sequence gap at ${i + 1}`);
      else if (e.previousEventHash !== prev) (ok = false), (detail = `event ${e.sequenceNumber} does not link to the previous event`);
      else if (custodyEventHash(e, prev, false) !== e.eventHash) {
        if (custodyEventHash(e, prev, true) === e.eventHash) legacy++;
        else (ok = false), (detail = `event ${e.sequenceNumber} (${e.action}) hash does not recompute`);
      }
      prev = e.eventHash;
    });
    check('custody.chain', ok, detail + (legacy ? `; ${legacy} event(s) verified with the pre-P4.5 payload hash` : ''));
    check('custody.head', !manifest.custodySummary || manifest.custodySummary.headHash === ev[ev.length - 1]?.eventHash, 'ledger head equals the signed custody summary');
    if (manifest.derivation) {
      const red = ev.find((e) => e.action === 'EVIDENCE_REDACTED' && e.resultHash === manifest.videoChecksumSha256);
      check('custody.derivation_event', Boolean(red) && red.sourceHash === manifest.derivation.parentMasterEvidenceHash, 'EVIDENCE_REDACTED links the parent master hash to this derivative');
    } else {
      const exp = ev.find((e) => e.action === 'EVIDENCE_EXPORTED' && e.resultHash === manifest.videoChecksumSha256);
      check('custody.export_event', Boolean(exp) && exp.sourceHash === manifest.evidenceMerkleRoot, 'EVIDENCE_EXPORTED links the Merkle root to this video');
    }
  }

  // AI provenance
  if (!manifest.aiProvenance) {
    check('ai.provenance', !opts.requireAiProvenance, 'the manifest has no AI provenance section (package predates P4.5)', opts.requireAiProvenance ? 'FAIL' : 'WARN');
  } else {
    const s = manifest.aiProvenance;
    const art = artifacts.find((a) => a.path === s.artifact && a.role === 'AI_PROVENANCE');
    check('ai.artifact_bound', Boolean(art), `${s.artifact} listed with role AI_PROVENANCE`);
    const doc = art ? json(art.path) : null;
    if (doc) {
      const models = new Map((doc.models || []).map((m) => [m.sha256, m]));
      const bad = (doc.records || []).filter(
        (r) =>
          !r.model || !r.model.name || !r.model.version || !HEX64.test(r.model.sha256 || '') || !models.has(r.model.sha256) ||
          typeof r.confidence !== 'number' || r.confidence < 0 || r.confidence > 1 || Number.isNaN(Date.parse(r.frameTimestampUtc)) || !r.cameraId
      );
      check('ai.records_attributed', bad.length === 0, bad.length ? `${bad.length} record(s) without model/confidence/timestamp/camera: ${bad.slice(0, 5).map((r) => r.id).join(', ')}` : `${(doc.records || []).length} record(s)`);
      check('ai.summary_matches', doc.schema === s.schema && (doc.records || []).length === s.recordCount && (doc.unattributed?.count ?? 0) === s.unattributedCount &&
        canonicalizeJson([...(s.models || [])].map((m) => m.sha256).sort()) === canonicalizeJson([...models.keys()].sort()), 'ai_provenance.json agrees with the signed summary');
      if ((doc.unattributed?.count ?? 0) > 0) warn('ai.unattributed', `${doc.unattributed.count} AI event(s) in the window carry no model provenance`);
      const unevaluated = (doc.models || []).filter((m) => m.evaluation === null).map((m) => `${m.name}@${m.version}`);
      if (unevaluated.length) warn('ai.models_unevaluated', `not evaluated on site data: ${unevaluated.join(', ')}`);
    }
  }

  // Derivation
  if (manifest.derivation) {
    const d0 = manifest.derivation;
    const art = artifacts.find((a) => a.path === d0.artifact && a.role === 'DERIVATION_RECORD');
    check('derivation.artifact_bound', Boolean(art), `${d0.artifact} listed with role DERIVATION_RECORD`);
    const d = art ? json(art.path) : null;
    if (d) {
      check('derivation.derivative_hash', d.derivativeSha256 === manifest.videoChecksumSha256, 'derivation.json names the primary media');
      check('derivation.parent', d.parentMasterEvidenceHash === d0.parentMasterEvidenceHash && d.parentMasterEvidenceHash === root, 'parent master hash equals the recomputed Merkle root of the listed leaves');
      const camLeaves = new Set(leaves.filter((l) => l.cameraId === d.cameraId).map((l) => `${l.segmentId}:${l.mediaSha256}`));
      const srcOk = (d.sourceSegments || []).length > 0 && d.sourceSegments.every((s) => camLeaves.has(`${s.segmentId}:${s.sha256}`));
      check('derivation.source_segments', srcOk, `${(d.sourceSegments || []).length} source segment(s) are leaves of the parent evidence`);
      if (d.detector) {
        const ai = manifest.aiProvenance?.models || [];
        check('derivation.detector_listed', ai.some((m) => m.sha256 === d.detector.modelSha256), `${d.detector.modelName}@${d.detector.modelVersion} is listed in the AI provenance`);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------- CLI
function main(argv) {
  const args = argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const target = args.find((a, i) => !a.startsWith('--') && !['--trusted-key', '--trusted-key-sha256'].includes(args[i - 1]));
  if (!target || args.includes('--help')) {
    console.error('usage: vigilone-verify <package.zip | dir> [--trusted-key key.pem | --trusted-key-sha256 HEX] [--require-ai-provenance] [--json]');
    return 2;
  }
  let files;
  try {
    files = fs.statSync(target).isDirectory() ? readDir(target) : readZip(fs.readFileSync(target));
  } catch (e) {
    console.error(`vigilone-verify: cannot read ${target}: ${e.message}`);
    return 2;
  }
  const opts = {
    trustedKeyPem: get('--trusted-key') ? fs.readFileSync(get('--trusted-key'), 'utf8') : undefined,
    trustedKeySha256: get('--trusted-key-sha256'),
    requireAiProvenance: args.includes('--require-ai-provenance'),
  };
  const results = verifyPackage(files, opts);
  const failed = results.filter((r) => r.status === 'FAIL');
  const verdict = failed.length ? 'INVALID' : 'VALID';
  if (args.includes('--json')) console.log(JSON.stringify({ tool: 'vigilone-verify', version: VERSION, target, verdict, results }, null, 2));
  else {
    for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.id}${r.detail ? `  (${r.detail})` : ''}`);
    console.log(`\n${verdict}: ${results.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'WARN').length} warning(s)`);
  }
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('vigilone-verify.mjs') || process.argv[1]?.endsWith('vigilone-verify')) {
  process.exitCode = main(process.argv);
}
