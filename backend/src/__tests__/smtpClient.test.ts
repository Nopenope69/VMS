/**
 * SMTP client (P3.3): protocol paths against an in-process test double (STARTTLS with a real
 * self-signed certificate, AUTH PLAIN/LOGIN, rejections) and interop against a real MailHog
 * binary when one is available (MAILHOG_BIN; required when VIGILONE_REQUIRE_MAILHOG=1).
 */
import fs from 'fs';
import net from 'net';
import { spawn, ChildProcess } from 'child_process';
import { sendMail, buildMessage, SmtpError } from '../services/notification/smtp/smtpClient';
import { selfSignedCert, startSmtpTestServer } from './helpers/smtpTestServer';

const cert = selfSignedCert();
const msg = { from: 'VigilOne <alerts@site.test>', to: ['ops@site.test'], subject: 'Intrusion — gate 2', text: 'Person crossed the tripwire.\n.leading dot line' };

function decodeBody(data: string): string {
  const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('SMTP client against the in-process test double', () => {
  it('upgrades with STARTTLS, verifies the certificate against the given CA and authenticates', async () => {
    const srv = await startSmtpTestServer({ offerStartTls: true, tlsCert: cert, auth: { user: 'alerts', pass: 's3cret-pass' } });
    try {
      const res = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'starttls', username: 'alerts', password: 's3cret-pass', ca: cert.cert }, msg);
      expect(res.queueId).toBe('TESTQ123');
      expect(res.accepted).toEqual(['ops@site.test']);
      expect(srv.mails).toHaveLength(1);
      expect(srv.mails[0].overTls).toBe(true);
      expect(srv.mails[0].authUser).toBe('alerts');
      expect(srv.mails[0].from).toBe('alerts@site.test');
      expect(decodeBody(srv.mails[0].data)).toBe(msg.text);
      expect(srv.mails[0].data).toContain('Subject: =?UTF-8?B?');
      // AUTH happened after the upgrade, never in clear text.
      expect(srv.commands.indexOf('STARTTLS')).toBeLessThan(srv.commands.findIndex((c) => c.startsWith('AUTH')));
    } finally {
      await srv.close();
    }
  });

  it('rejects an untrusted certificate unless verification is disabled explicitly', async () => {
    const srv = await startSmtpTestServer({ offerStartTls: true, tlsCert: cert });
    try {
      await expect(sendMail({ host: '127.0.0.1', port: srv.port, security: 'starttls' }, msg)).rejects.toThrow(/STARTTLS handshake failed/);
      expect(srv.mails).toHaveLength(0);
      const ok = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'starttls', rejectUnauthorized: false }, msg);
      expect(ok.queueId).toBe('TESTQ123');
    } finally {
      await srv.close();
    }
  });

  it('fails closed when STARTTLS is required but not offered (permanent)', async () => {
    const srv = await startSmtpTestServer({ offerStartTls: false });
    try {
      const err = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'starttls' }, msg).catch((e) => e);
      expect(err).toBeInstanceOf(SmtpError);
      expect(err.permanent).toBe(true);
      expect(err.message).toMatch(/does not offer STARTTLS/);
      expect(srv.mails).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it('refuses to send credentials over plaintext', async () => {
    const srv = await startSmtpTestServer({ auth: { user: 'a', pass: 'b' } });
    try {
      const err = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'none', username: 'a', password: 'b' }, msg).catch((e) => e);
      expect(err.message).toMatch(/without TLS/);
      expect(srv.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('uses implicit TLS and AUTH LOGIN; a wrong password is a permanent failure', async () => {
    const srv = await startSmtpTestServer({ implicitTls: true, tlsCert: cert, auth: { user: 'u1', pass: 'right' } });
    try {
      const err = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'tls', ca: cert.cert, username: 'u1', password: 'wrong' }, msg).catch((e) => e);
      expect(err.code).toBe(535);
      expect(err.permanent).toBe(true);
      expect(err.message).not.toContain('wrong');
      const ok = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'tls', ca: cert.cert, username: 'u1', password: 'right' }, msg);
      expect(ok.accepted).toEqual(['ops@site.test']);
      expect(srv.mails[0].overTls).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('classifies a rejected recipient as permanent and a 4xx on DATA as temporary', async () => {
    const srv = await startSmtpTestServer({ rejectRecipients: ['nobody@site.test'] });
    try {
      const err = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'none' }, { ...msg, to: ['nobody@site.test'] }).catch((e) => e);
      expect(err.code).toBe(550);
      expect(err.permanent).toBe(true);
    } finally {
      await srv.close();
    }
    const tmp = await startSmtpTestServer({ dataReplyCode: 451 });
    try {
      const err = await sendMail({ host: '127.0.0.1', port: tmp.port, security: 'none' }, msg).catch((e) => e);
      expect(err.code).toBe(451);
      expect(err.permanent).toBe(false);
    } finally {
      await tmp.close();
    }
  });

  it('reports no receipt when the server gives no queue id (never invents one)', async () => {
    const srv = await startSmtpTestServer({ queueId: null });
    try {
      const res = await sendMail({ host: '127.0.0.1', port: srv.port, security: 'none' }, msg);
      expect(res.queueId).toBeNull();
      expect(res.response).toBe('250 2.0.0 Ok');
    } finally {
      await srv.close();
    }
  });

  it('fails with a temporary error when nothing listens', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const err = await sendMail({ host: '127.0.0.1', port, security: 'none', timeoutMs: 2000 }, msg).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.permanent).toBe(false);
  });

  it('strips CR/LF from headers so alarm titles cannot inject headers', () => {
    const raw = buildMessage({ ...msg, subject: 'x\r\nBcc: evil@x.test', headers: { 'X-A': 'v\r\nBcc: evil@x.test', 'Bad Header': 'x' } }, 'id@test');
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).not.toContain('Bad Header');
  });
});

const MAILHOG = process.env.MAILHOG_BIN || '/tmp/mailhog/MailHog';
const haveMailhog = fs.existsSync(MAILHOG);
if (!haveMailhog && process.env.VIGILONE_REQUIRE_MAILHOG === '1') {
  throw new Error(`VIGILONE_REQUIRE_MAILHOG=1 but no MailHog binary at ${MAILHOG}`);
}
if (!haveMailhog) console.warn(`[smtpClient.test] MailHog interop SKIPPED: no binary at ${MAILHOG} (set MAILHOG_BIN)`);

(haveMailhog ? describe : describe.skip)('SMTP client interop with MailHog (real third-party SMTP server)', () => {
  let proc: ChildProcess;
  let smtpPort = 0;
  let apiPort = 0;
  const freePort = async () => {
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const p = (s.address() as net.AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return p;
  };

  beforeAll(async () => {
    smtpPort = await freePort();
    apiPort = await freePort();
    proc = spawn(MAILHOG, ['-smtp-bind-addr', `127.0.0.1:${smtpPort}`, '-api-bind-addr', `127.0.0.1:${apiPort}`, '-ui-bind-addr', `127.0.0.1:${apiPort}`], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${apiPort}/api/v2/messages`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('MailHog did not start');
  });
  afterAll(() => {
    proc?.kill('SIGKILL');
  });

  it('delivers a message MailHog accepts, with the queue id MailHog reports', async () => {
    const res = await sendMail({ host: '127.0.0.1', port: smtpPort, security: 'none' }, { ...msg, to: ['ops@site.test', 'guard@site.test'], headers: { 'X-VigilOne-Alarm': 'alarm-123' } });
    expect(res.accepted).toEqual(['ops@site.test', 'guard@site.test']);
    expect(res.response).toMatch(/^250 /);
    const list: any = await (await fetch(`http://127.0.0.1:${apiPort}/api/v2/messages`)).json();
    expect(list.total).toBe(1);
    const m = list.items[0];
    expect(m.Raw.From).toBe('alerts@site.test');
    expect(m.Raw.To.sort()).toEqual(['guard@site.test', 'ops@site.test']);
    expect(m.Content.Headers['X-Vigilone-Alarm'] || m.Content.Headers['X-VigilOne-Alarm']).toEqual(['alarm-123']);
    expect(Buffer.from(m.Content.Body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe(msg.text);
    // MailHog answers "250 Ok: queued as <id>"; the id must be MailHog's own message id.
    expect(res.queueId).toBe(m.ID);
  });
});
