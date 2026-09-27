/**
 * TEST DOUBLE: a small in-process SMTP server for exercising the SMTP client's protocol paths
 * (STARTTLS upgrade, AUTH, rejections) that MailHog does not cover. Never used outside tests.
 */
import net from 'net';
import tls from 'tls';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  overTls: boolean;
  authUser: string | null;
}

export interface SmtpTestServerOptions {
  offerStartTls?: boolean;
  implicitTls?: boolean;
  tlsCert?: { key: string; cert: string };
  auth?: { user: string; pass: string };
  rejectRecipients?: string[];
  queueId?: string | null;
  /** Reply code for the message body, e.g. 451 for a temporary failure. */
  dataReplyCode?: number;
}

/** Self-signed certificate for 127.0.0.1 / localhost, generated with the system openssl. */
export function selfSignedCert(): { key: string; cert: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-smtp-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'key.pem'), 'utf8'), cert: fs.readFileSync(path.join(dir, 'cert.pem'), 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function startSmtpTestServer(opts: SmtpTestServerOptions = {}) {
  const mails: ReceivedMail[] = [];
  const commands: string[] = [];

  const handle = (initial: net.Socket | tls.TLSSocket, startedTls: boolean) => {
    let sock: net.Socket | tls.TLSSocket = initial;
    let overTls = startedTls;
    let buf = '';
    let inData = false;
    let from = '';
    let to: string[] = [];
    let authUser: string | null = null;
    let loginStage: null | 'user' | 'pass' = null;
    let loginUser = '';
    const send = (l: string) => sock.write(l + '\r\n');

    const onLine = (line: string) => {
      commands.push(line.startsWith('AUTH') ? line.split(' ').slice(0, 2).join(' ') : line);
      if (loginStage === 'user') {
        loginUser = Buffer.from(line, 'base64').toString();
        loginStage = 'pass';
        return send('334 UGFzc3dvcmQ6');
      }
      if (loginStage === 'pass') {
        loginStage = null;
        const pass = Buffer.from(line, 'base64').toString();
        if (opts.auth && loginUser === opts.auth.user && pass === opts.auth.pass) {
          authUser = loginUser;
          return send('235 2.7.0 Authentication successful');
        }
        return send('535 5.7.8 Authentication credentials invalid');
      }
      const [verb, ...rest] = line.split(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const caps = ['250-test.smtp.local'];
          if (opts.offerStartTls && !overTls) caps.push('250-STARTTLS');
          if (opts.auth) caps.push('250-AUTH PLAIN LOGIN');
          caps.push('250 8BITMIME');
          return send(caps.join('\r\n'));
        }
        case 'STARTTLS': {
          send('220 2.0.0 Ready to start TLS');
          sock.removeAllListeners('data');
          const secure = new tls.TLSSocket(sock, { isServer: true, key: opts.tlsCert!.key, cert: opts.tlsCert!.cert });
          sock = secure;
          overTls = true;
          buf = '';
          secure.on('data', onData);
          secure.on('error', () => undefined);
          return;
        }
        case 'AUTH': {
          if (rest[0] === 'PLAIN') {
            const [, u, p] = Buffer.from(rest[1] || '', 'base64').toString().split('\0');
            if (opts.auth && u === opts.auth.user && p === opts.auth.pass) {
              authUser = u;
              return send('235 2.7.0 Authentication successful');
            }
            return send('535 5.7.8 Authentication credentials invalid');
          }
          if (rest[0] === 'LOGIN') {
            loginStage = 'user';
            return send('334 VXNlcm5hbWU6');
          }
          return send('504 5.5.4 Unrecognized authentication type');
        }
        case 'MAIL':
          if (opts.auth && !authUser) return send('530 5.7.0 Authentication required');
          from = /<([^>]*)>/.exec(line)?.[1] || '';
          return send('250 2.1.0 Ok');
        case 'RCPT': {
          const r = /<([^>]*)>/.exec(line)?.[1] || '';
          if (opts.rejectRecipients?.includes(r)) return send('550 5.1.1 User unknown');
          to.push(r);
          return send('250 2.1.5 Ok');
        }
        case 'DATA':
          inData = true;
          return send('354 End data with <CR><LF>.<CR><LF>');
        case 'QUIT':
          send('221 2.0.0 Bye');
          return sock.end();
        default:
          return send('502 5.5.2 Command not recognized');
      }
    };

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          if (opts.dataReplyCode && opts.dataReplyCode !== 250) {
            send(`${opts.dataReplyCode} 4.3.0 Try again later`);
          } else {
            mails.push({ from, to, data, overTls, authUser });
            send(opts.queueId === null ? '250 2.0.0 Ok' : `250 2.0.0 Ok: queued as ${opts.queueId ?? 'TESTQ123'}`);
          }
          from = '';
          to = [];
          continue;
        }
        const idx = buf.indexOf('\r\n');
        if (idx < 0) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        onLine(line);
      }
    };

    sock.on('data', onData);
    sock.on('error', () => undefined);
    send('220 test.smtp.local ESMTP test double');
  };

  const server = opts.implicitTls
    ? tls.createServer({ key: opts.tlsCert!.key, cert: opts.tlsCert!.cert }, (s) => handle(s, true))
    : net.createServer((s) => handle(s, false));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    mails,
    commands,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
