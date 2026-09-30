/**
 * The site-to-headquarters record log (Phase 6). Each record is hash-chained to the one before it:
 *
 *   hash = SHA-256( prevHash + "\n" + canonical({ seq, kind, sourceId, occurredAt, data }) )
 *
 * where canonical() is JSON with object keys sorted at every level. The first record's prevHash is GENESIS.
 * Headquarters recomputes every hash and requires each batch to continue from the last hash it accepted, so a
 * lost, reordered, repeated or altered record is detected instead of silently stored. The site keeps its
 * records until headquarters has acknowledged them.
 */
import crypto from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);
export const RECORD_KINDS = ['EVENT', 'ALARM', 'AUDIT'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface LogRecord {
  seq: string; // decimal string on the wire (BigInt in the database)
  kind: RecordKind;
  sourceId: string;
  occurredAt: string; // ISO-8601 UTC
  data: unknown;
  prevHash: string;
  hash: string;
}

/** JSON with sorted object keys; arrays keep their order. Undefined values are dropped, as JSON.stringify does. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in a record');
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function recordHash(prevHash: string, r: Pick<LogRecord, 'seq' | 'kind' | 'sourceId' | 'occurredAt' | 'data'>): string {
  const body = canonicalJson({ seq: r.seq, kind: r.kind, sourceId: r.sourceId, occurredAt: r.occurredAt, data: r.data });
  return crypto.createHash('sha256').update(`${prevHash}\n${body}`).digest('hex');
}

/**
 * Checks that `records` continue a chain whose last accepted record was (lastSeq, lastHash): strictly
 * increasing seq, each prevHash equal to the previous hash, each hash recomputed. Returns null or the reason.
 */
export function chainProblem(records: LogRecord[], lastSeq: bigint, lastHash: string): string | null {
  let prevSeq = lastSeq;
  let prevHash = lastHash;
  for (const [i, r] of records.entries()) {
    if (!RECORD_KINDS.includes(r.kind)) return `record ${i}: unknown kind '${r.kind}'`;
    if (!/^\d{1,19}$/.test(r.seq)) return `record ${i}: seq is not a decimal integer`;
    const seq = BigInt(r.seq);
    if (seq <= prevSeq) return `record ${i}: seq ${seq} does not follow ${prevSeq}`;
    if (typeof r.sourceId !== 'string' || !r.sourceId || r.sourceId.length > 200) return `record ${i}: bad sourceId`;
    if (typeof r.occurredAt !== 'string' || !Number.isFinite(Date.parse(r.occurredAt))) return `record ${i}: bad occurredAt`;
    if (r.prevHash !== prevHash) return `record ${i}: prevHash does not continue the chain`;
    if (recordHash(r.prevHash, r) !== r.hash) return `record ${i}: hash does not match its content`;
    prevSeq = seq;
    prevHash = r.hash;
  }
  return null;
}
