import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import os from 'os';

/**
 * Minimal SMTP submission client (RFC 5321, 3207 STARTTLS, 4954 AUTH) with no dependencies.
 * Written in-house because the common Node mail libraries are MIT-0, which is outside the
 * product's licence allowlist (docs/STATUS.md, "Licence questions").
 *
 * - security 'tls': implicit TLS (port 465); 'starttls': STARTTLS is required (fails closed if the
 *   server does not offer it); 'none': plaintext, only for a local relay (MailHog-class test sink).
 * - Certificates are verified unless rejectUnauthorized=false is set explicitly.
 * - AUTH PLAIN or LOGIN when credentials are given; never sent over plaintext unless
 *   allowPlaintextAuth is set.
 * - Returns the server's final reply to DATA, whose text usually carries the queue id: the
 *   delivery receipt stored with the notification.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string;
  password?: string;
  rejectUnauthorized?: boolean;
  /** Extra CA certificates (PEM) for private relays. */
  ca?: string | string[];
  allowPlaintextAuth?: boolean;
  clientName?: string;
  timeoutMs?: number;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  /** Extra headers, e.g. { 'X-VigilOne-Alarm': id } */
  headers?: Record<string, string>;
}

export interface SmtpSendResult {
  accepted: string[];
  /** Final reply to the message body, e.g. "250 2.0.0 Ok: queued as 4F2A1C" */
  response: string;
  /** Queue id parsed from the response when the server gives one. */
  queueId: string | null;
  messageId: string;
}

export class SmtpError extends Error {
  constructor(public readonly code: number | null, message: string, public readonly permanent: boolean) {
    super(message);
  }
}

interface Reply {
  code: number;
  lines: string[];
}

class SmtpConnection {
  private buffer = '';
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private pending: Reply[] = [];
  private current: string[] = [];
  private closedError: Error | null = null;

  constructor(public socket: net.Socket | tls.TLSSocket, private timeoutMs: number) {
    this.attach(socket);
  }

  attach(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeoutMs);
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('timeout', () => this.fail(new SmtpError(null, `SMTP timeout after ${this.timeoutMs} ms`, false)));
    socket.on('error', (e) => this.fail(new SmtpError(null, `SMTP socket error: ${e.message}`, false)));
    socket.on('close', () => this.fail(new SmtpError(null, 'SMTP connection closed by server', false)));
  }

  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('timeout');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }

  private fail(e: Error) {
    if (this.closedError) return;
    this.closedError = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) continue;
      this.current.push(m[3]);
      if (m[2] === ' ') {
        const reply = { code: Number(m[1]), lines: this.current };
        this.current = [];
        const w = this.waiters.shift();
        if (w) w.resolve(reply);
        else this.pending.push(reply);
      }
    }
  }

  read(): Promise<Reply> {
    if (this.pending.length) return Promise.resolve(this.pending.shift()!);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async command(cmd: string, expect: number[], redacted?: string): Promise<Reply> {
    this.socket.write(cmd + '\r\n');
    const r = await this.read();
    if (!expect.includes(r.code)) {
      throw new SmtpError(r.code, `SMTP ${redacted ?? cmd.split(' ')[0]} failed: ${r.code} ${r.lines.join(' ')}`, r.code >= 500);
    }
    return r;
  }
}

function connect(cfg: SmtpConfig): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(new SmtpError(null, `SMTP connect to ${cfg.host}:${cfg.port} failed: ${e.message}`, false));
    const sock =
      cfg.security === 'tls'
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false, ca: cfg.ca }, () => resolve(sock))
        : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(sock));
    sock.once('error', onErr);
    sock.setTimeout(cfg.timeoutMs ?? 15000, () => {
      sock.destroy();
      reject(new SmtpError(null, `SMTP connect to ${cfg.host}:${cfg.port} timed out`, false));
    });
  });
}

function upgrade(sock: net.Socket, cfg: SmtpConfig): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect(
      { socket: sock, servername: net.isIP(cfg.host) ? undefined : cfg.host, rejectUnauthorized: cfg.rejectUnauthorized !== false, ca: cfg.ca },
      () => resolve(t)
    );
    t.once('error', (e) => reject(new SmtpError(null, `STARTTLS handshake failed: ${e.message}`, false)));
  });
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+$/;

/** RFC 2047 encoded-word for non-ASCII subjects. */
function encodeHeader(v: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

export function buildMessage(msg: SmtpMessage, messageId: string, date = new Date()): string {
  const headers: string[] = [
    `From: ${msg.from}`,
    `To: ${msg.to.join(', ')}`,
    `Subject: ${encodeHeader(msg.subject.replace(/[\r\n]+/g, ' '))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  for (const [k, v] of Object.entries(msg.headers || {})) {
    if (/^[A-Za-z0-9-]+$/.test(k)) headers.push(`${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`);
  }
  const body = (Buffer.from(msg.text, 'utf8').toString('base64').match(/.{1,76}/g) || ['']).join('\r\n');
  // Dot-stuffing: base64 lines never start with '.', headers are sanitised above.
  return headers.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

export async function sendMail(cfg: SmtpConfig, msg: SmtpMessage): Promise<SmtpSendResult> {
  const fromAddr = msg.from.match(/<([^>]+)>\s*$/)?.[1] ?? msg.from;
  if (!EMAIL.test(fromAddr) || /[\r\n]/.test(msg.from) || msg.to.length === 0 || !msg.to.every((a) => EMAIL.test(a))) {
    throw new SmtpError(null, 'Invalid sender or recipient address', true);
  }
  const timeoutMs = cfg.timeoutMs ?? 15000;
  const name = cfg.clientName || os.hostname() || 'vigilone.local';
  const sock = await connect(cfg);
  const conn = new SmtpConnection(sock, timeoutMs);
  let secure = cfg.security === 'tls';
  try {
    const greet = await conn.read();
    if (greet.code !== 220) throw new SmtpError(greet.code, `SMTP greeting rejected: ${greet.code} ${greet.lines.join(' ')}`, false);
    let ehlo = await conn.command(`EHLO ${name}`, [250]);
    const caps = () => ehlo.lines.map((l) => l.toUpperCase());

    if (cfg.security === 'starttls') {
      if (!caps().some((c) => c.startsWith('STARTTLS'))) {
        throw new SmtpError(null, 'SMTP server does not offer STARTTLS; refusing to continue without TLS', true);
      }
      await conn.command('STARTTLS', [220]);
      conn.detach();
      const tlsSock = await upgrade(sock as net.Socket, cfg);
      conn.attach(tlsSock);
      secure = true;
      ehlo = await conn.command(`EHLO ${name}`, [250]);
    }

    if (cfg.username) {
      if (!secure && !cfg.allowPlaintextAuth) {
        throw new SmtpError(null, 'Refusing to send SMTP credentials without TLS', true);
      }
      const auth = caps().find((c) => c.startsWith('AUTH')) || '';
      if (auth.includes('PLAIN')) {
        const token = Buffer.from(`\0${cfg.username}\0${cfg.password ?? ''}`, 'utf8').toString('base64');
        await conn.command(`AUTH PLAIN ${token}`, [235], 'AUTH PLAIN');
      } else if (auth.includes('LOGIN')) {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(Buffer.from(cfg.username).toString('base64'), [334], 'AUTH LOGIN user');
        await conn.command(Buffer.from(cfg.password ?? '').toString('base64'), [235], 'AUTH LOGIN password');
      } else {
        throw new SmtpError(null, 'SMTP server offers no supported AUTH mechanism (PLAIN, LOGIN)', true);
      }
    }

    await conn.command(`MAIL FROM:<${fromAddr}>`, [250]);
    const accepted: string[] = [];
    for (const rcpt of msg.to) {
      await conn.command(`RCPT TO:<${rcpt}>`, [250, 251]);
      accepted.push(rcpt);
    }
    await conn.command('DATA', [354]);
    const messageId = `${crypto.randomUUID()}@${name}`;
    const final = await conn.command(buildMessage(msg, messageId) + '.', [250], 'DATA body');
    const response = `${final.code} ${final.lines.join(' ')}`;
    const queueId = /queued as (\S+)/i.exec(response)?.[1] ?? /id=([A-Za-z0-9._-]+)/i.exec(response)?.[1] ?? null;
    try {
      await conn.command('QUIT', [221]);
    } catch {
      /* the message is already accepted; a failed QUIT does not change that */
    }
    return { accepted, response, queueId, messageId };
  } finally {
    conn.socket.destroy();
  }
}
