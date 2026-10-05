#!/usr/bin/env node
/**
 * vigilone-verify: offline verifier for VigilOne evidence packages (P4.5).
 *
 *   vigilone-verify <package.zip | extracted-dir> [--trusted-key key.pem | --trusted-key-sha256 HEX]
 *                   [--require-ai-provenance] [--require-explanations] [--require-incident-summaries] [--json]
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
 *   - explanations.json (Phase 5): every explanation record recomputes its facts, text and record
 *     hashes, its text equals what the named template renders from its facts, every explanation is
 *     for the package's camera and inside its time window, and the document agrees with the signed
 *     summary
 *   - incident_summaries.json (ADR 0016): hashes recompute, each record's sentences and citations equal what
 *     the template renders from its facts, every citation points at a fact and every fact is cited
 *
 * Exit codes: 0 all checks passed (warnings allowed), 1 a check failed, 2 usage or read error.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const VERSION = '1.1.0';
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

// ---------------------------------------------------------------- explanations (Phase 5, P5.2)
// The renderer below is an exact copy of backend/src/services/explanation/template.ts (explain-template.v1).
// backend/src/__tests__/explanationTemplateParity.test.ts runs both on the same inputs and requires the
// same bytes. Never edit a template version: add a new one.
export const EXPLAIN_RECORD_SCHEMA = 'vigilone.explanation.v1';
export const EXPLAIN_DOCUMENT_SCHEMA = 'vigilone.explanations.v1';
export const EXPLAIN_TEMPLATE_V1 = 'explain-template.v1';
const EXPL_MAX_LIST = 10;
const EXPL_MAX_TEXT = 200;
const EXPL_MAX_JSON = 240;
const xq = (v) => JSON.stringify(String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, EXPL_MAX_TEXT));
const xnum = (v) => String(v);
const xcj = (v) => {
  const s = canonicalizeJson(v);
  return s.length > EXPL_MAX_JSON ? `${s.slice(0, EXPL_MAX_JSON)}...` : s;
};
const xPresent = (v) =>
  v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
const xstr = (p, k) => (typeof p[k] === 'string' && p[k].length > 0 ? p[k] : null);
const xnumeric = (p, k) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : null);

function payloadSentence(payload) {
  if (!payload) return null;
  const kind = xstr(payload, 'kind');
  if (!kind) return `The trigger payload has no kind; recorded fields: ${xcj(payload)}.`;
  const generic = () => `The trigger payload of kind ${xq(kind)} is missing fields for a specific description; recorded fields: ${xcj(payload)}.`;
  switch (kind) {
    case 'TRIPWIRE_CROSS': {
      const track = xstr(payload, 'trackId');
      const wire = xstr(payload, 'tripwireId');
      const dir = xstr(payload, 'direction');
      if (!track || !wire || !dir) return generic();
      return `Track ${xq(track)} crossed tripwire ${xq(wire)} in direction ${dir}.`;
    }
    case 'LOITERING_DWELL': {
      const track = xstr(payload, 'trackId');
      const zone = xstr(payload, 'zoneId');
      const dwell = xnumeric(payload, 'dwellTimeSeconds');
      const limit = xnumeric(payload, 'thresholdSeconds');
      if (!track || !zone || dwell === null || limit === null) return generic();
      return `Track ${xq(track)} stayed in zone ${xq(zone)} for ${xnum(dwell)} seconds; the configured threshold is ${xnum(limit)} seconds.`;
    }
    case 'UNATTENDED_OBJECT': {
      const track = xstr(payload, 'trackId');
      const zone = xstr(payload, 'zoneId');
      const cls = xstr(payload, 'objectClass');
      const secs = xnumeric(payload, 'unattendedSeconds');
      const limit = xnumeric(payload, 'thresholdSeconds');
      if (!track || !zone || !cls || secs === null || limit === null) return generic();
      return `A ${xq(cls)} (track ${xq(track)}) lay still in zone ${xq(zone)} with no person near it for ${xnum(secs)} seconds; the configured threshold is ${xnum(limit)} seconds.`;
    }
    case 'WRONG_WAY': {
      const track = xstr(payload, 'trackId');
      const zone = xstr(payload, 'zoneId');
      const angle = xnumeric(payload, 'angleDegrees');
      const travel = xnumeric(payload, 'travel');
      if (!track || !zone || angle === null || travel === null) return generic();
      return `Track ${xq(track)} moved ${xnum(angle)} degrees against the allowed direction of zone ${xq(zone)} over a distance of ${xnum(travel)} of the picture.`;
    }
    case 'ANPR_MATCH': {
      const plate = xstr(payload, 'plateText');
      const conf = xnumeric(payload, 'confidence');
      if (!plate || conf === null) return generic();
      const cat = xstr(payload, 'watchlistCategory');
      return `Plate ${xq(plate)} was read with confidence ${xnum(conf)}${cat ? ` and matched watchlist category ${xq(cat)}` : ''}.`;
    }
    case 'AI_OBJECT_DETECTED': {
      const cls = xstr(payload, 'objectClass');
      const conf = xnumeric(payload, 'confidence');
      if (!cls || conf === null) return generic();
      return `A model detected ${xq(cls)} with confidence ${xnum(conf)}.`;
    }
    case 'CAMERA_OFFLINE': {
      const last = xstr(payload, 'lastSeenUtc');
      if (!last) return generic();
      return `The camera was last seen at ${last}${xstr(payload, 'reason') ? `; recorded reason ${xq(xstr(payload, 'reason'))}` : ''}.`;
    }
    case 'STREAM_DEGRADED': {
      const fps = xnumeric(payload, 'fps');
      const expected = xnumeric(payload, 'expectedFps');
      if (fps === null || expected === null) return generic();
      return `The stream ran at ${xnum(fps)} frames per second against an expected ${xnum(expected)}.`;
    }
    case 'MOTION': {
      const score = xnumeric(payload, 'score');
      if (score === null) return generic();
      return `Classical motion detection reported a score of ${xnum(score)}.`;
    }
    default:
      return `The trigger payload of kind ${xq(kind)} has no dedicated wording; recorded fields: ${xcj(payload)}.`;
  }
}

export function renderExplanationV1(facts) {
  const out = [];
  const { alarm, subject, trigger, rule } = facts;
  out.push(`Alarm ${xq(alarm.title)} with severity ${alarm.severity} was raised at ${alarm.triggeredAtUtc} on ${subject.cameraId ? `camera ${subject.cameraId}` : 'no specific camera'}.`);
  if (trigger.type) {
    out.push(
      `It was raised from a ${trigger.type} event${trigger.source ? ` from source ${xq(trigger.source)}` : ''}${trigger.eventId ? ` (event ${trigger.eventId})` : ''}${trigger.timestampUtc ? ` recorded at ${trigger.timestampUtc}` : ''}.`
    );
  } else {
    out.push('No triggering event is linked to this alarm.');
  }
  const p = payloadSentence(trigger.payload);
  if (p) out.push(p);
  if (rule) {
    out.push(
      `Rule ${xq(rule.name ?? rule.id)} (${rule.triggerType ?? 'unknown trigger type'}) matched${xPresent(rule.conditions) ? ` with conditions ${xcj(rule.conditions)}` : ''}${rule.cooldownSeconds !== null ? `; its cooldown is ${xnum(rule.cooldownSeconds)} seconds` : ''}.`
    );
  } else {
    out.push('No automation rule is linked to this alarm.');
  }
  if (facts.models.length > 0) {
    out.push(`Models involved: ${facts.models.map((m) => `${m.name}@${m.version} (sha256 ${m.sha256.slice(0, 12)}, ${m.evaluated ? 'evaluation published' : 'not evaluated on site data'})`).join('; ')}.`);
  } else {
    out.push('No AI model is recorded for this alarm.');
  }
  if (facts.detections.length > 0) {
    const shown = facts.detections.slice(0, EXPL_MAX_LIST).map((d) => `${xq(d.label)} with confidence ${xnum(d.confidence)} at ${d.frameTimestampUtc}`);
    const more = facts.detections.length > EXPL_MAX_LIST ? `; and ${facts.detections.length - EXPL_MAX_LIST} more` : '';
    out.push(`Detections recorded with this alarm: ${shown.join('; ')}${more}.`);
  }
  if (facts.correlated.length > 0) {
    const shown = facts.correlated.slice(0, EXPL_MAX_LIST).map((c) => `${c.type} at ${c.timestampUtc}`);
    const more = facts.correlated.length > EXPL_MAX_LIST ? `; and ${facts.correlated.length - EXPL_MAX_LIST} more` : '';
    out.push(`Earlier events in the same correlation chain: ${shown.join('; ')}${more}.`);
  }
  out.push(`Camera clock check: ${facts.cameraClock.status}.`);
  out.push(`This explanation was generated by template ${EXPLAIN_TEMPLATE_V1} from recorded facts. It is not a model opinion and does not by itself show that the event occurred.`);
  return out.join('\n');
}
const EXPLAIN_RENDERERS = { [EXPLAIN_TEMPLATE_V1]: renderExplanationV1 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const isoUtc = (s) => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === s;
const nonEmpty = (s) => typeof s === 'string' && s.length > 0;
const nullOr = (v, f) => v === null || f(v);

/** Same shape as the backend schema (strict keys). Returns a problem string or null. */
export function explanationFactsProblem(f) {
  if (!exactKeys(f, ['subject', 'alarm', 'trigger', 'rule', 'models', 'detections', 'correlated', 'cameraClock'])) return 'facts have missing or unexpected members';
  if (!exactKeys(f.subject, ['kind', 'id', 'tenantId', 'cameraId']) || f.subject.kind !== 'ALARM' || !nonEmpty(f.subject.id) || !nonEmpty(f.subject.tenantId) || !nullOr(f.subject.cameraId, nonEmpty)) return 'facts.subject is malformed';
  if (!exactKeys(f.alarm, ['title', 'severity', 'triggeredAtUtc']) || typeof f.alarm.title !== 'string' || !nonEmpty(f.alarm.severity) || !isoUtc(f.alarm.triggeredAtUtc)) return 'facts.alarm is malformed';
  const t = f.trigger;
  if (!exactKeys(t, ['eventId', 'type', 'source', 'timestampUtc', 'severity', 'payload']) || !nullOr(t.eventId, nonEmpty) || !nullOr(t.type, nonEmpty) || !nullOr(t.source, nonEmpty) || !nullOr(t.timestampUtc, isoUtc) || !nullOr(t.severity, nonEmpty) || !nullOr(t.payload, isObj)) return 'facts.trigger is malformed';
  if (f.rule !== null) {
    const r = f.rule;
    if (!exactKeys(r, ['kind', 'id', 'name', 'triggerType', 'cooldownSeconds', 'conditions', 'triggerConfig']) || !['AUTOMATION_RULE', 'EVENT_RULE'].includes(r.kind) || !nonEmpty(r.id) || !nullOr(r.name, (x) => typeof x === 'string') || !nullOr(r.triggerType, (x) => typeof x === 'string') || !nullOr(r.cooldownSeconds, Number.isFinite)) return 'facts.rule is malformed';
  }
  if (!Array.isArray(f.models) || !f.models.every((m) => exactKeys(m, ['name', 'version', 'sha256', 'task', 'evaluated']) && nonEmpty(m.name) && nonEmpty(m.version) && HEX64.test(m.sha256) && nullOr(m.task, (x) => typeof x === 'string') && typeof m.evaluated === 'boolean')) return 'facts.models is malformed';
  if (!Array.isArray(f.detections) || !f.detections.every((d) => exactKeys(d, ['id', 'label', 'confidence', 'frameTimestampUtc', 'modelSha256']) && nonEmpty(d.id) && nonEmpty(d.label) && Number.isFinite(d.confidence) && d.confidence >= 0 && d.confidence <= 1 && isoUtc(d.frameTimestampUtc) && nullOr(d.modelSha256, (x) => HEX64.test(x)))) return 'facts.detections is malformed';
  if (!Array.isArray(f.correlated) || !f.correlated.every((c) => exactKeys(c, ['eventId', 'type', 'timestampUtc']) && nonEmpty(c.eventId) && nonEmpty(c.type) && isoUtc(c.timestampUtc))) return 'facts.correlated is malformed';
  if (!exactKeys(f.cameraClock, ['status']) || !['OK', 'DRIFT', 'UNDETERMINED', 'UNKNOWN'].includes(f.cameraClock.status)) return 'facts.cameraClock is malformed';
  return null;
}

/** Problems found in one explanation record (empty = intact). */
export function explanationRecordProblems(r) {
  const problems = [];
  if (!isObj(r) || r.schema !== EXPLAIN_RECORD_SCHEMA) return ['unknown record schema'];
  const shape = explanationFactsProblem(r.facts);
  if (shape) return [shape];
  if (sha256(canonicalizeJson(r.facts)) !== r.factsSha256) problems.push('factsSha256 does not match the facts');
  if (typeof r.text !== 'string' || sha256(r.text) !== r.textSha256) problems.push('textSha256 does not match the text');
  const { recordSha256, ...rest } = r;
  if (sha256(canonicalizeJson(rest)) !== recordSha256) problems.push('recordSha256 does not match the record');
  if (r.explanationId !== sha256(`${r.facts.subject.kind}:${r.facts.subject.id}:${r.templateVersion}`)) problems.push('explanationId does not match the subject and template');
  const render = EXPLAIN_RENDERERS[r.templateVersion];
  if (!render) problems.push(`unknown template version ${r.templateVersion}`);
  else if (render(r.facts) !== r.text) problems.push('the text is not what the template renders from the facts');
  return problems;
}

/** The explanations section of verifyPackage, exported so it can be tested on its own. */
export function verifyExplanationsSection({ manifest, artifacts, json, check, warn, opts = {} }) {
  if (!manifest.explanations) {
    check('explain.present', false, 'the manifest has no explanations section', opts.requireExplanations ? 'FAIL' : 'WARN');
    return;
  }
  const s = manifest.explanations;
  const art = artifacts.find((a) => a.path === s.artifact && a.role === 'EXPLANATIONS');
  check('explain.artifact_bound', Boolean(art), `${s.artifact} listed with role EXPLANATIONS`);
  const doc = art ? json(art.path) : null;
  if (!doc) return;
  const records = Array.isArray(doc.explanations) ? doc.explanations : [];
  const digest = sha256(canonicalizeJson(records.map((r) => r.recordSha256).sort()));
  check('explain.summary_matches', doc.schema === EXPLAIN_DOCUMENT_SCHEMA && doc.schema === s.schema && records.length === s.recordCount && doc.digestSha256 === s.digestSha256 && digest === doc.digestSha256, 'explanations.json agrees with the signed summary and its own digest');
  const badRecords = records.map((r) => ({ id: isObj(r) ? r.explanationId : '(no id)', problems: explanationRecordProblems(r) })).filter((x) => x.problems.length);
  check('explain.records_intact', badRecords.length === 0, badRecords.length ? badRecords.slice(0, 5).map((b) => `${b.id}: ${b.problems.join(', ')}`).join(' | ') : `${records.length} record(s): hashes recompute and each text equals the template output for its facts`);
  const ids = records.map((r) => r?.explanationId);
  check('explain.unique', new Set(ids).size === ids.length, 'one explanation per alarm and template');
  const cam = manifest.camera?.id;
  const w = manifest.timeWindow;
  const from = Date.parse(w?.startUtc);
  const to = Date.parse(w?.endUtc);
  const outOfScope = records.filter((r) => {
    const t = isObj(r) && isObj(r.facts) ? Date.parse(r.facts.alarm?.triggeredAtUtc) : NaN;
    return !(r?.facts?.subject?.cameraId === cam && t >= from && t <= to);
  });
  check('explain.scope', doc.cameraId === cam && doc.window?.startUtc === w?.startUtc && doc.window?.endUtc === w?.endUtc && outOfScope.length === 0, outOfScope.length ? `${outOfScope.length} explanation(s) are for another camera or outside the export window` : 'every explanation is for this camera and inside the export window');
  if (manifest.aiProvenance) {
    const listed = new Set((manifest.aiProvenance.models || []).map((m) => m.sha256));
    const unlisted = new Set();
    for (const r of records) for (const m of r?.facts?.models || []) if (!listed.has(m.sha256)) unlisted.add(`${m.name}@${m.version}`);
    if (unlisted.size) warn('explain.models_in_ai_provenance', `model(s) named in explanations but not in the AI provenance: ${[...unlisted].join(', ')}`);
  }
}

// ---------------------------------------------------------------- incident summaries (ADR 0016)
// The renderer and the facts checks below are an exact copy of backend/src/services/incidentSummary (template.ts,
// types.ts, summary.ts; incident-summary.v1). backend/src/__tests__/incidentSummaryTemplateParity.test.ts runs both on the
// same inputs and requires the same bytes. Never edit a template version: add a new one.
export const ISUM_RECORD_SCHEMA = 'vigilone.incident-summary.v1';
export const ISUM_DOCUMENT_SCHEMA = 'vigilone.incident-summaries.v1';
export const ISUM_TEMPLATE_V1 = 'incident-summary.v1';
const ISUM_MAX_TEXT = 200;
const isClean = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, ISUM_MAX_TEXT);
const iq = (v) => JSON.stringify(isClean(v));
const iw = (v) => isClean(v);
const inum = (v) => String(v);
export const ISUM_CLOSING_V1 = `This summary was generated by template ${ISUM_TEMPLATE_V1} from the numbered recorded facts. It is not a model opinion; every statement cites the facts it rests on, and it does not by itself show that the event occurred.`;

export function joinIncidentSentences(sentences) {
  return sentences.map((s) => (s.cites.length ? `${s.text} [${s.cites.join(', ')}]` : s.text)).join('\n');
}

export function renderIncidentSummaryV1(facts) {
  const camName = new Map(facts.cameras.map((c) => [c.id, c.name]));
  const onCam = (id) => (id ? ` on camera ${iq(camName.has(id) ? camName.get(id) : id)}` : '');
  const sentences = [];
  const push = (text, ...cites) => sentences.push({ text, cites });
  const tl = facts.timeline;
  for (let i = 0; i < tl.length; i++) {
    const f = tl[i];
    if (f.kind === 'CORRELATED_EVENT' || f.kind === 'DETECTION') {
      const run = [];
      let j = i;
      while (j < tl.length && tl[j].kind === f.kind) run.push(tl[j++]);
      if (f.kind === 'CORRELATED_EVENT') push(`Earlier events in the same correlation chain: ${run.map((r) => `${iw(r.data.eventType)} at ${r.atUtc}`).join('; ')}.`, ...run.map((r) => r.id));
      else push(`Detections recorded with this alarm: ${run.map((r) => `${iq(r.data.label)} with confidence ${inum(r.data.confidence)} at ${r.atUtc}`).join('; ')}.`, ...run.map((r) => r.id));
      i = j - 1;
      continue;
    }
    const d = f.data;
    switch (f.kind) {
      case 'ALARM_RAISED':
        push(`At ${f.atUtc} the alarm ${iq(d.title)} with severity ${iw(d.severity)} was raised${onCam(f.cameraId)}.${d.source === 'JOURNEY' ? ' It was opened from a confirmed journey.' : ''}`, f.id);
        break;
      case 'TRIGGER_EVENT': {
        const cam = onCam(f.cameraId);
        let s = null;
        if (d.eventType === 'TRIPWIRE_CROSS' && d.trackId && d.direction) s = `At ${f.atUtc} track ${iq(d.trackId)} crossed a tripwire in direction ${iw(d.direction)}${cam}.`;
        else if (d.eventType === 'LOITERING_DWELL' && d.trackId && d.zoneId && d.dwellSeconds !== null && d.thresholdSeconds !== null)
          s = `At ${f.atUtc} track ${iq(d.trackId)} stayed in zone ${iq(d.zoneId)} for ${inum(d.dwellSeconds)} seconds; the configured threshold is ${inum(d.thresholdSeconds)} seconds${cam}.`;
        else if (d.eventType === 'UNATTENDED_OBJECT' && d.trackId && d.zoneId && d.objectClass && d.dwellSeconds !== null && d.thresholdSeconds !== null)
          s = `At ${f.atUtc} a ${iw(d.objectClass)} (track ${iq(d.trackId)}) lay still in zone ${iq(d.zoneId)} with no person near it for ${inum(d.dwellSeconds)} seconds; the configured threshold is ${inum(d.thresholdSeconds)} seconds${cam}.`;
        else if (d.eventType === 'WRONG_WAY' && d.trackId && d.zoneId) s = `At ${f.atUtc} track ${iq(d.trackId)} moved against the allowed direction of zone ${iq(d.zoneId)}${cam}.`;
        else if (d.eventType === 'ANPR_MATCH' && d.plateRead) s = `At ${f.atUtc} a number plate was read and a plate match was recorded${cam}; the plate text is withheld from this summary.`;
        else if (d.eventType === 'AI_OBJECT_DETECTED' && d.objectClass && d.confidence !== null) s = `At ${f.atUtc} a model detected ${iq(d.objectClass)} with confidence ${inum(d.confidence)}${cam}.`;
        else if (d.eventType === 'MOTION') s = `At ${f.atUtc} classical motion detection reported activity${cam}.`;
        push(s !== null ? s : `At ${f.atUtc} an event of type ${iq(d.eventType)}${d.source ? ` from source ${iq(d.source)}` : ''} was recorded${cam}.`, f.id);
        break;
      }
      case 'TRACK_SIGHTING': {
        const zones = d.zones.length ? `, visiting ${d.zones.map((z) => `zone ${iq(z.name)} from ${z.enteredUtc} to ${z.exitedUtc}`).join('; ')}` : '';
        push(`Track ${iq(d.trackId)} (${iw(d.objectClass)}) was seen${onCam(f.cameraId)} from ${d.firstSeenUtc} to ${d.lastSeenUtc}${d.direction ? `, moving ${iw(d.direction)}` : ''}${zones}.`, f.id);
        break;
      }
      case 'LINK_CONFIRMED':
        push(`At ${f.atUtc} an operator (user ${iq(d.userId)}) confirmed by ${d.method === 'PLATE' ? 'plate' : 'appearance'} that tracks ${iq(d.fromTrackId)} and ${iq(d.toTrackId)} are the same subject.`, f.id);
        break;
      case 'ALARM_REPEATED':
        push(`The alarm was triggered ${inum(d.occurrences)} times in total, the last at ${d.lastActivityUtc}.`, f.id);
        break;
      case 'SECOND_OPINION':
        push(`At ${f.atUtc} the advisory second-opinion model ${iw(d.modelName)}@${iw(d.modelVersion)} answered ${d.answer} to whether a ${iw(d.targetClass)} is visible in the picture; this is not a finding.`, f.id);
        break;
      case 'ACKNOWLEDGED':
        push(`At ${f.atUtc} the alarm was acknowledged by user ${iq(d.userId)}.`, f.id);
        break;
      case 'VERDICT':
        push(`At ${f.atUtc} user ${iq(d.userId)} recorded the verdict ${d.verdict}${d.hasReason ? ' with a written reason (not repeated here)' : ''}.`, f.id);
        break;
      case 'RESOLVED':
        push(`At ${f.atUtc} the alarm was resolved by user ${iq(d.userId)}${d.hasNotes ? ', with resolution notes (not repeated here)' : ''}.`, f.id);
        break;
      case 'EVIDENCE_HOLD':
        push(`At ${f.atUtc} an evidence hold was placed${onCam(f.cameraId)} covering ${d.windowStartUtc} to ${d.windowEndUtc} (status ${iw(d.status)}).`, f.id);
        break;
    }
  }
  push(ISUM_CLOSING_V1);
  return { sentences, text: joinIncidentSentences(sentences) };
}

const ISUM_RENDERERS = { [ISUM_TEMPLATE_V1]: renderIncidentSummaryV1 };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ISUM_DATA = {
  ALARM_RAISED: (d) => exactKeys(d, ['title', 'severity', 'source']) && typeof d.title === 'string' && nonEmpty(d.severity) && [null, 'RULE', 'JOURNEY'].includes(d.source),
  TRIGGER_EVENT: (d) =>
    exactKeys(d, ['eventType', 'source', 'trackId', 'zoneId', 'direction', 'dwellSeconds', 'thresholdSeconds', 'objectClass', 'confidence', 'plateRead']) &&
    nonEmpty(d.eventType) && nullOr(d.source, nonEmpty) && nullOr(d.trackId, nonEmpty) && nullOr(d.zoneId, nonEmpty) && nullOr(d.direction, nonEmpty) &&
    nullOr(d.dwellSeconds, isNum) && nullOr(d.thresholdSeconds, isNum) && nullOr(d.objectClass, nonEmpty) && nullOr(d.confidence, (x) => isNum(x) && x >= 0 && x <= 1) && typeof d.plateRead === 'boolean',
  CORRELATED_EVENT: (d) => exactKeys(d, ['eventType']) && nonEmpty(d.eventType),
  DETECTION: (d) => exactKeys(d, ['label', 'confidence', 'modelSha256']) && nonEmpty(d.label) && isNum(d.confidence) && d.confidence >= 0 && d.confidence <= 1 && nullOr(d.modelSha256, (x) => typeof x === 'string' && HEX64.test(x)),
  TRACK_SIGHTING: (d) =>
    exactKeys(d, ['trackId', 'objectClass', 'firstSeenUtc', 'lastSeenUtc', 'direction', 'zones']) && nonEmpty(d.trackId) && nonEmpty(d.objectClass) && isoUtc(d.firstSeenUtc) && isoUtc(d.lastSeenUtc) &&
    nullOr(d.direction, nonEmpty) && Array.isArray(d.zones) && d.zones.every((z) => exactKeys(z, ['name', 'enteredUtc', 'exitedUtc']) && typeof z.name === 'string' && isoUtc(z.enteredUtc) && isoUtc(z.exitedUtc)),
  LINK_CONFIRMED: (d) => exactKeys(d, ['method', 'fromTrackId', 'toTrackId', 'userId']) && ['PLATE', 'APPEARANCE'].includes(d.method) && nonEmpty(d.fromTrackId) && nonEmpty(d.toTrackId) && nonEmpty(d.userId),
  ALARM_REPEATED: (d) => exactKeys(d, ['occurrences', 'lastActivityUtc']) && Number.isInteger(d.occurrences) && d.occurrences >= 2 && isoUtc(d.lastActivityUtc),
  SECOND_OPINION: (d) => exactKeys(d, ['answer', 'targetClass', 'modelName', 'modelVersion', 'modelSha256']) && ['yes', 'no', 'unclear'].includes(d.answer) && nonEmpty(d.targetClass) && nonEmpty(d.modelName) && nonEmpty(d.modelVersion) && typeof d.modelSha256 === 'string' && HEX64.test(d.modelSha256),
  ACKNOWLEDGED: (d) => exactKeys(d, ['userId']) && nonEmpty(d.userId),
  VERDICT: (d) => exactKeys(d, ['verdict', 'userId', 'hasReason']) && ['FALSE_ALARM', 'TRUE_ALARM'].includes(d.verdict) && nonEmpty(d.userId) && typeof d.hasReason === 'boolean',
  RESOLVED: (d) => exactKeys(d, ['userId', 'hasNotes']) && nonEmpty(d.userId) && typeof d.hasNotes === 'boolean',
  EVIDENCE_HOLD: (d) => exactKeys(d, ['windowStartUtc', 'windowEndUtc', 'status']) && isoUtc(d.windowStartUtc) && isoUtc(d.windowEndUtc) && nonEmpty(d.status),
};

/** Same shape and rules as the backend schema (strict keys). Returns a problem string or null. */
export function incidentSummaryFactsProblem(f) {
  if (!exactKeys(f, ['subject', 'cameras', 'timeline'])) return 'facts have missing or unexpected members';
  if (!exactKeys(f.subject, ['kind', 'id', 'tenantId', 'cameraId']) || f.subject.kind !== 'ALARM' || !nonEmpty(f.subject.id) || !nonEmpty(f.subject.tenantId) || !nullOr(f.subject.cameraId, nonEmpty)) return 'facts.subject is malformed';
  if (!Array.isArray(f.cameras) || !f.cameras.every((c) => exactKeys(c, ['id', 'name']) && nonEmpty(c.id) && typeof c.name === 'string')) return 'facts.cameras is malformed';
  if (!Array.isArray(f.timeline) || f.timeline.length < 1) return 'facts.timeline is empty or malformed';
  for (let i = 0; i < f.timeline.length; i++) {
    const t = f.timeline[i];
    if (!exactKeys(t, ['id', 'atUtc', 'kind', 'cameraId', 'data']) || !isoUtc(t.atUtc) || !nullOr(t.cameraId, nonEmpty) || typeof t.kind !== 'string' || !Object.prototype.hasOwnProperty.call(ISUM_DATA, t.kind) || !isObj(t.data) || !ISUM_DATA[t.kind](t.data)) return `fact ${i + 1} is malformed`;
    if (t.id !== `F${i + 1}`) return `fact ${i + 1} must be numbered F${i + 1}`;
    if (i > 0 && Date.parse(t.atUtc) < Date.parse(f.timeline[i - 1].atUtc)) return 'facts must be in time order';
  }
  if (f.timeline.filter((t) => t.kind === 'ALARM_RAISED').length !== 1) return 'there must be exactly one ALARM_RAISED fact';
  if (f.timeline.filter((t) => t.kind === 'TRIGGER_EVENT').length > 1) return 'there can be at most one TRIGGER_EVENT fact';
  const ids = f.cameras.map((c) => c.id);
  if (new Set(ids).size !== ids.length) return 'cameras must be unique';
  for (const t of f.timeline) if (t.cameraId && !ids.includes(t.cameraId)) return `fact ${t.id} names a camera that is not in the camera list`;
  return null;
}

/** Problems found in one incident summary record (empty = intact). */
export function incidentSummaryRecordProblems(r) {
  const problems = [];
  if (!isObj(r) || r.schema !== ISUM_RECORD_SCHEMA) return ['unknown record schema'];
  const shape = incidentSummaryFactsProblem(r.facts);
  if (shape) return [shape];
  const factsSha = sha256(canonicalizeJson(r.facts));
  if (factsSha !== r.factsSha256) problems.push('factsSha256 does not match the facts');
  if (typeof r.text !== 'string' || sha256(r.text) !== r.textSha256) problems.push('textSha256 does not match the text');
  const { recordSha256, ...rest } = r;
  if (sha256(canonicalizeJson(rest)) !== recordSha256) problems.push('recordSha256 does not match the record');
  if (r.summaryId !== sha256(`ALARM:${r.facts.subject.id}:${r.templateVersion}:${factsSha}`)) problems.push('summaryId does not match the alarm, template and facts');
  const known = new Set(r.facts.timeline.map((t) => t.id));
  const cited = new Set();
  const sentences = Array.isArray(r.sentences) ? r.sentences : [];
  sentences.forEach((s, i) => {
    const cites = isObj(s) && Array.isArray(s.cites) ? s.cites : [];
    for (const c of cites) {
      if (!known.has(c)) problems.push(`sentence ${i + 1} cites unknown fact ${c}`);
      cited.add(c);
    }
    const last = i === sentences.length - 1;
    if (!last && cites.length === 0) problems.push(`sentence ${i + 1} has no citation`);
    if (last && (cites.length !== 0 || !isObj(s) || s.text !== ISUM_CLOSING_V1)) problems.push('the last sentence must be the fixed closing statement, with no citation');
  });
  for (const t of r.facts.timeline) if (!cited.has(t.id)) problems.push(`fact ${t.id} is not cited by any sentence`);
  const render = ISUM_RENDERERS[r.templateVersion];
  if (!render) problems.push(`unknown template version ${r.templateVersion}`);
  else {
    const out = render(r.facts);
    if (canonicalizeJson(out.sentences) !== canonicalizeJson(sentences) || out.text !== r.text || joinIncidentSentences(sentences) !== r.text) problems.push('the sentences and citations are not what the template renders from the facts');
  }
  return problems;
}

/** The incident summaries section of verifyPackage, exported so it can be tested on its own. */
export function verifyIncidentSummariesSection({ manifest, artifacts, json, check, opts = {} }) {
  if (!manifest.incidentSummaries) {
    check('summary.present', false, 'the manifest has no incident summaries section', opts.requireIncidentSummaries ? 'FAIL' : 'WARN');
    return;
  }
  const s = manifest.incidentSummaries;
  const art = artifacts.find((a) => a.path === s.artifact && a.role === 'INCIDENT_SUMMARIES');
  check('summary.artifact_bound', Boolean(art), `${s.artifact} listed with role INCIDENT_SUMMARIES`);
  const doc = art ? json(art.path) : null;
  if (!doc) return;
  const records = Array.isArray(doc.summaries) ? doc.summaries : [];
  const digest = sha256(canonicalizeJson(records.map((r) => r?.recordSha256).sort()));
  check('summary.summary_matches', doc.schema === ISUM_DOCUMENT_SCHEMA && doc.schema === s.schema && records.length === s.recordCount && doc.digestSha256 === s.digestSha256 && digest === doc.digestSha256, 'incident_summaries.json agrees with the signed summary and its own digest');
  const bad = records.map((r) => ({ id: isObj(r) ? r.summaryId : '(no id)', problems: incidentSummaryRecordProblems(r) })).filter((x) => x.problems.length);
  check('summary.records_intact', bad.length === 0, bad.length ? bad.slice(0, 5).map((b) => `${b.id}: ${b.problems.join(', ')}`).join(' | ') : `${records.length} record(s): hashes recompute, each text equals the template output for its facts, every sentence cites facts that exist and every fact is cited`);
  const alarmIds = records.map((r) => r?.facts?.subject?.id);
  check('summary.unique', new Set(alarmIds).size === alarmIds.length && new Set(records.map((r) => r?.summaryId)).size === records.length, 'one summary per alarm');
  const cam = manifest.camera?.id;
  const w = manifest.timeWindow;
  const from = Date.parse(w?.startUtc);
  const to = Date.parse(w?.endUtc);
  const outOfScope = records.filter((r) => {
    const raised = isObj(r?.facts) && Array.isArray(r.facts.timeline) ? r.facts.timeline.find((t) => t?.kind === 'ALARM_RAISED') : null;
    const t = raised ? Date.parse(raised.atUtc) : NaN;
    return !(r?.facts?.subject?.cameraId === cam && t >= from && t <= to);
  });
  check('summary.scope', doc.cameraId === cam && doc.window?.startUtc === w?.startUtc && doc.window?.endUtc === w?.endUtc && outOfScope.length === 0, outOfScope.length ? `${outOfScope.length} summary(ies) are for another camera or outside the export window` : 'every summary is for this camera and inside the export window');
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

  // Explanations (Phase 5)
  verifyExplanationsSection({ manifest, artifacts, json, check, warn, opts });
  // Incident summaries (ADR 0016)
  verifyIncidentSummariesSection({ manifest, artifacts, json, check, opts });

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
    console.error('usage: vigilone-verify <package.zip | dir> [--trusted-key key.pem | --trusted-key-sha256 HEX] [--require-ai-provenance] [--require-explanations] [--require-incident-summaries] [--json]');
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
    requireExplanations: args.includes('--require-explanations'),
    requireIncidentSummaries: args.includes('--require-incident-summaries'),
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
