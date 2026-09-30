/**
 * SigV4 signing equals botocore's S3 signer on committed reference cases (tools/reference/s3_sigv4_reference.py,
 * AWS's documented example credentials; not real keys).
 */
import fs from 'fs';
import path from 'path';
import { signV4, uriEncode, S3Client } from '../services/storage/s3Client';

const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 's3', 'sigv4.reference.json'), 'utf8'));

describe('SigV4 equals botocore', () => {
  for (const c of ref.cases) {
    it(c.name, () => {
      const d: string = c.expectedAmzDate; // the time botocore signed at, e.g. 20260930T122635Z
      const now = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
      const h = signV4({ method: c.method, host: c.host, path: c.path, headers: c.headers, payloadSha256: c.payload, accessKeyId: ref.accessKeyId, secretAccessKey: ref.secretAccessKey, region: c.region, now });
      expect(h['x-amz-date']).toBe(c.expectedAmzDate);
      expect(h.authorization).toBe(c.expectedAuthorization);
    });
  }

  it('encodes as RFC 3986 requires', () => {
    expect(uriEncode('a b+c/ü~', false)).toBe('a%20b%2Bc/%C3%BC~');
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });

  it('refuses a bad bucket name or missing credentials', () => {
    expect(() => new S3Client({ region: 'us-east-1', bucket: 'Bad_Bucket', accessKeyId: 'a', secretAccessKey: 'b' })).toThrow(/not a valid S3 bucket name/);
    expect(() => new S3Client({ region: 'us-east-1', bucket: 'ok-bucket', accessKeyId: '', secretAccessKey: 'b' })).toThrow(/required/);
  });
});
