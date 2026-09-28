import http from 'http';
import https from 'https';
import crypto from 'crypto';

/**
 * HTTP request with Digest authentication (RFC 7616: MD5 / SHA-256, qop=auth) and Basic as a
 * fallback only over HTTPS. Returns the live response so long-lived event streams (Hikvision
 * alertStream, Dahua eventManager) can be consumed incrementally.
 */
export interface Credentials {
  username: string;
  password: string;
}

export interface DigestRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  /** Idle timeout on the response socket (streams: longer than the device heartbeat). */
  idleTimeoutMs?: number;
  rejectUnauthorized?: boolean;
  signal?: AbortSignal;
  /** Return 4xx/5xx responses (other than an unanswerable 401) instead of throwing, e.g. SOAP faults. */
  allowErrorStatus?: boolean;
}

export class CameraHttpError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly permanent: boolean) {
    super(message);
  }
}

export function parseDigestChallenge(header: string): Record<string, string> | null {
  const m = /^\s*Digest\s+(.*)$/i.exec(header);
  if (!m) return null;
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1]))) out[x[1].toLowerCase()] = x[2] !== undefined ? x[2].replace(/\\(.)/g, '$1') : x[3];
  return out.nonce && out.realm !== undefined ? out : null;
}

export function digestAuthorization(
  chal: Record<string, string>,
  creds: Credentials,
  method: string,
  uri: string,
  nc = 1,
  cnonce = crypto.randomBytes(8).toString('hex')
): string {
  const algo = (chal.algorithm || 'MD5').toUpperCase();
  const hashName = algo.startsWith('SHA-256') ? 'sha256' : algo.startsWith('MD5') ? 'md5' : null;
  if (!hashName) throw new CameraHttpError(401, `Unsupported digest algorithm ${algo}`, true);
  const H = (s: string) => crypto.createHash(hashName).update(s).digest('hex');
  let ha1 = H(`${creds.username}:${chal.realm}:${creds.password}`);
  if (algo.endsWith('-SESS')) ha1 = H(`${ha1}:${chal.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qops = (chal.qop || '').split(',').map((s) => s.trim());
  const ncHex = nc.toString(16).padStart(8, '0');
  const useQop = qops.includes('auth');
  const response = useQop ? H(`${ha1}:${chal.nonce}:${ncHex}:${cnonce}:auth:${ha2}`) : H(`${ha1}:${chal.nonce}:${ha2}`);
  const parts = [
    `username="${creds.username}"`,
    `realm="${chal.realm}"`,
    `nonce="${chal.nonce}"`,
    `uri="${uri}"`,
    `algorithm=${algo}`,
    `response="${response}"`,
  ];
  if (useQop) parts.push('qop=auth', `nc=${ncHex}`, `cnonce="${cnonce}"`);
  if (chal.opaque !== undefined) parts.push(`opaque="${chal.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

function send(url: URL, req: DigestRequest, authorization?: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { ...(req.headers || {}) };
    if (authorization) headers.authorization = authorization;
    if (req.body !== undefined) headers['content-length'] = String(Buffer.byteLength(req.body));
    const r = lib.request(
      url,
      { method: req.method || 'GET', headers, ...(url.protocol === 'https:' ? { rejectUnauthorized: req.rejectUnauthorized !== false } : {}), signal: req.signal },
      (res) => {
        clearTimeout(timer);
        if (req.idleTimeoutMs) {
          res.socket.setTimeout(req.idleTimeoutMs, () => res.destroy(new Error(`no data for ${req.idleTimeoutMs} ms`)));
        }
        resolve(res);
      }
    );
    const timer = setTimeout(() => r.destroy(new Error(`request timed out after ${req.timeoutMs ?? 10000} ms`)), req.timeoutMs ?? 10000);
    r.on('error', (e) => {
      clearTimeout(timer);
      reject(new CameraHttpError(0, `${url.host}: ${e.message}`, false));
    });
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

async function drain(res: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Performs the request, answering one Digest challenge. Non-2xx statuses throw. */
export async function digestRequest(urlStr: string, creds: Credentials | null, req: DigestRequest = {}): Promise<http.IncomingMessage> {
  const url = new URL(urlStr);
  let res = await send(url, req);
  if (res.statusCode === 401 && creds) {
    const header = ([] as string[]).concat(res.headers['www-authenticate'] || []);
    await drain(res);
    const digest = header.map(parseDigestChallenge).find(Boolean);
    let authorization: string;
    if (digest) {
      authorization = digestAuthorization(digest, creds, req.method || 'GET', url.pathname + url.search);
    } else if (header.some((h) => /^\s*Basic/i.test(h))) {
      if (url.protocol !== 'https:') {
        throw new CameraHttpError(401, `${url.host} offers only Basic auth over plain HTTP; refusing to send the password in clear`, true);
      }
      authorization = `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`;
    } else {
      throw new CameraHttpError(401, `${url.host} sent no supported authentication challenge`, true);
    }
    res = await send(url, req, authorization);
  }
  const status = res.statusCode || 0;
  if ((status < 200 || status >= 300) && !(req.allowErrorStatus && status !== 401)) {
    const body = (await drain(res).catch(() => '')).slice(0, 300);
    throw new CameraHttpError(status, `${url.host} ${req.method || 'GET'} ${url.pathname} -> ${status} ${body}`.trim(), status === 401 || status === 403 || status === 404);
  }
  return res;
}

export async function digestText(urlStr: string, creds: Credentials | null, req: DigestRequest = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const res = await digestRequest(urlStr, creds, req);
  return { status: res.statusCode || 0, body: await drain(res), headers: res.headers };
}
