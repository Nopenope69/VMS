/**
 * The offline verifier carries its own copy of the segment-seal.v1 format (tools/vigilone-verify is dependency-free). This
 * runs both on the same generated seals: the verifier must derive the same seal hash from the body the backend writes, and
 * reject a body with a key added or removed. If the two drift, exported seals would stop verifying, and this fails first.
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import path from 'path';
import { keyFingerprint, sealBodyV1, sealHashOf, SealFields, SEAL_GENESIS } from '../services/recording/catalog/segmentSeal';

const VERIFIER = path.resolve(__dirname, '../../../tools/vigilone-verify/vigilone-verify.mjs');
const run = (script: string, input: unknown) =>
  JSON.parse(execFileSync('node', ['--input-type=module', '-e', script], { input: JSON.stringify(input), maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));

function seal(i: number, prev: string): SealFields {
  return {
    cameraId: i % 3 === 0 ? 'cam-"quoted"-नई' : `cam-${i % 5}`,
    sequence: i + 1,
    segmentId: crypto.randomUUID(),
    startUtc: new Date(1790000000000 + i * 600_123),
    endUtc: new Date(1790000000000 + i * 600_123 + 599_999),
    sizeBytes: BigInt(i) * 9_007_199_254_740_993n, // past 2^53: kept as a decimal string, not a lossy number
    mediaSha256: crypto.createHash('sha256').update(String(i)).digest('hex'),
    prevSealHash: prev,
    sealedAt: new Date(1790000000000 + i * 600_123 + 601_000),
    keyFingerprint: 'a'.repeat(64),
  };
}

describe('segment seal format parity with the offline verifier (ADR 0018)', () => {
  it('the verifier derives the same seal hash from 300 backend-built bodies, and rejects altered key sets', () => {
    let prev = SEAL_GENESIS;
    const fields = Array.from({ length: 300 }, (_, i) => {
      const f = seal(i, prev);
      prev = sealHashOf(f);
      return f;
    });
    const bodies = fields.map((f) => sealBodyV1(f));
    const script = `
      import { sealHashV1 } from ${JSON.stringify('file://' + VERIFIER)};
      let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => (input += c));
      process.stdin.on('end', () => {
        const bodies = JSON.parse(input);
        const extra = bodies.slice(0, 5).map((b) => sealHashV1({ ...b, note: 'added' }));
        const missing = bodies.slice(0, 5).map((b) => { const c = { ...b }; delete c.sizeBytes; return sealHashV1(c); });
        process.stdout.write(JSON.stringify({ hashes: bodies.map(sealHashV1), extra, missing }));
      });`;
    const out = run(script, bodies);
    expect(out.hashes).toEqual(fields.map(sealHashOf));
    expect(out.extra).toEqual([null, null, null, null, null]);
    expect(out.missing).toEqual([null, null, null, null, null]);
    expect(bodies[5].sizeBytes).toBe('45035996273704965');
  });

  it('the key fingerprint is the SHA-256 of the SPKI DER, as vigilone-verify prints it', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    expect(keyFingerprint(publicKey)).toBe(crypto.createHash('sha256').update(der).digest('hex'));
  });
});
