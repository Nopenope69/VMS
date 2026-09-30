/**
 * Minimal S3 client (Phase 6 archive): AWS Signature Version 4, PUT from a file with a known SHA-256, HEAD,
 * GET and DELETE. Works with AWS S3 and S3-compatible stores (MinIO and others) using path-style addressing
 * when an endpoint is given. No SDK: the signing is small, and it is checked against botocore's own signer on
 * committed reference cases (tools/reference/s3_sigv4_reference.py) and against a real S3-compatible server.
 *
 * The payload is signed with its real SHA-256 (never UNSIGNED-PAYLOAD), so the store rejects a body that
 * changed in transit, and the SHA-256 is also stored as object metadata so a HEAD can prove what is stored.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { Transform, TransformCallback } from 'stream';

export interface S3Config {
  /** e.g. https://minio.example:9000 ; omitted means AWS (virtual-hosted style). */
  endpoint?: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class S3Error extends Error {
  constructor(public readonly status: number, public readonly s3Code: string, message: string) {
    super(message);
    this.name = 'S3Error';
  }
}

const hmac = (key: Buffer | string, data: string) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const EMPTY_SHA256 = sha256hex('');

/** RFC 3986 encoding as SigV4 requires (every byte except A-Z a-z 0-9 - . _ ~); '/' kept when encodeSlash is false. */
export function uriEncode(s: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (c === '/' && !encodeSlash)) out += c;
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export interface SignInput {
  method: string;
  host: string;
  /** Unencoded path, starting with '/'. */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to send and sign (lower- or mixed-case names). */
  headers?: Record<string, string>;
  payloadSha256: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  now: Date;
}

/** Returns the headers to send: the given ones plus host, x-amz-date, x-amz-content-sha256 and Authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const service = i.service ?? 's3';
  const amzDate = i.now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.headers ?? {})) headers[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  headers['host'] = i.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = i.payloadSha256;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = Object.entries(i.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [i.method.toUpperCase(), uriEncode(i.path, false), query, canonicalHeaders, signedHeaders, i.payloadSha256].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** Limits a stream to `kbps` kilobits per second (0 = unlimited). */
class Throttle extends Transform {
  private sentBytes = 0;
  private readonly started = Date.now();
  constructor(private readonly bytesPerSecond: number) {
    super();
  }
  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.sentBytes += chunk.length;
    const due = (this.sentBytes / this.bytesPerSecond) * 1000 - (Date.now() - this.started);
    if (due > 0) setTimeout(() => cb(null, chunk), due);
    else cb(null, chunk);
  }
}

export interface HeadResult {
  sizeBytes: number;
  sha256: string | null;
  etag: string | null;
}

export class S3Client {
  constructor(private readonly cfg: S3Config, private readonly nowFn: () => Date = () => new Date()) {
    if (!cfg.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new S3Error(0, 'InvalidBucketName', `bucket '${cfg.bucket}' is not a valid S3 bucket name`);
    if (!cfg.accessKeyId || !cfg.secretAccessKey) throw new S3Error(0, 'MissingCredentials', 'access key and secret key are required');
  }

  private target(key: string): { url: URL; host: string; path: string } {
    if (this.cfg.endpoint) {
      const base = new URL(this.cfg.endpoint);
      if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new S3Error(0, 'InvalidEndpoint', 'endpoint must be http(s)');
      const path = `/${this.cfg.bucket}/${key}`;
      const url = new URL(base.toString());
      url.pathname = uriEncode(path, false);
      return { url, host: base.host, path };
    }
    const host = `${this.cfg.bucket}.s3.${this.cfg.region}.amazonaws.com`;
    const path = `/${key}`;
    return { url: new URL(`https://${host}${uriEncode(path, false)}`), host, path };
  }

  private request(method: string, key: string, opts: { headers?: Record<string, string>; payloadSha256?: string; body?: NodeJS.ReadableStream; timeoutMs?: number } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    const t = this.target(key);
    const signed = signV4({
      method,
      host: t.host,
      path: t.path,
      headers: opts.headers,
      payloadSha256: opts.payloadSha256 ?? EMPTY_SHA256,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      now: this.nowFn(),
    });
    const lib = t.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(t.url, { method, headers: signed, timeout: opts.timeoutMs ?? 600_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`S3 ${method} timed out`)));
      req.on('error', reject);
      if (opts.body) {
        opts.body.on('error', (e: Error) => req.destroy(e));
        opts.body.pipe(req);
      } else req.end();
    });
  }

  private static fail(method: string, key: string, r: { status: number; body: Buffer }): never {
    const text = r.body.toString('utf8');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP${r.status}`;
    const msg = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? '';
    throw new S3Error(r.status, code, `S3 ${method} ${key} failed: ${code}${msg ? ` (${msg})` : ''}`);
  }

  /** HEAD: size and the stored SHA-256 metadata, or null when the object does not exist. */
  async head(key: string): Promise<HeadResult | null> {
    const r = await this.request('HEAD', key, { timeoutMs: 30_000 });
    if (r.status === 404) return null;
    if (r.status !== 200) S3Client.fail('HEAD', key, r);
    return { sizeBytes: Number(r.headers['content-length'] ?? -1), sha256: (r.headers['x-amz-meta-vigilone-sha256'] as string) ?? null, etag: (r.headers['etag'] as string) ?? null };
  }

  /**
   * Uploads a file whose SHA-256 is already known. The payload is signed with that hash, so if the file on
   * disk does not match it the store refuses the upload (XAmzContentSHA256Mismatch) instead of storing it.
   */
  async putFile(key: string, file: string, sha256: string, sizeBytes: number, opts: { bandwidthKbps?: number; contentType?: string } = {}): Promise<void> {
    const body = fs.createReadStream(file);
    const stream = opts.bandwidthKbps && opts.bandwidthKbps > 0 ? body.pipe(new Throttle((opts.bandwidthKbps * 1000) / 8)) : body;
    const r = await this.request('PUT', key, {
      headers: { 'content-length': String(sizeBytes), 'content-type': opts.contentType ?? 'application/octet-stream', 'x-amz-meta-vigilone-sha256': sha256 },
      payloadSha256: sha256,
      body: stream,
    });
    if (r.status !== 200) S3Client.fail('PUT', key, r);
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.request('GET', key);
    if (r.status !== 200) S3Client.fail('GET', key, r);
    return r.body;
  }

  async delete(key: string): Promise<void> {
    const r = await this.request('DELETE', key, { timeoutMs: 30_000 });
    if (r.status !== 204 && r.status !== 200) S3Client.fail('DELETE', key, r);
  }

  /** Creates the bucket (tests and first setup); an existing bucket owned by us is fine. */
  async createBucket(): Promise<void> {
    const t = this.target('');
    void t;
    const r = await this.request('PUT', '', { timeoutMs: 30_000 });
    if (r.status !== 200 && !(r.status === 409 && /BucketAlreadyOwnedByYou/.test(r.body.toString()))) S3Client.fail('PUT bucket', '', r);
  }
}
