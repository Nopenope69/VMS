/**
 * Canonical JSON: object keys sorted (by UTF-16 code units, as Array.prototype.sort does),
 * no whitespace. Input is first normalised through JSON semantics, so Dates become ISO strings,
 * undefined object members are dropped and undefined array items become null, exactly as
 * JSON.stringify would do. The same bytes therefore come out of a value and of that value after a
 * round trip through JSON or PostgreSQL JSONB (which reorders keys). The offline verifier
 * (tools/vigilone-verify) implements the same function.
 */
export function canonicalizeJson(value: unknown): string {
  const normalised = value === undefined ? null : JSON.parse(JSON.stringify(value));
  return canon(normalised);
}

function canon(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
