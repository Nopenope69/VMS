/**
 * TEST DOUBLES for camera event protocols (P3.1/P3.2). They implement just enough of each
 * device API to exercise VigilOne's clients over real HTTP: Digest auth challenges and
 * verification, long-lived multipart streams, and the ONVIF PullPoint SOAP exchange with
 * WS-Security verification against a camera clock that is deliberately offset. They are not
 * device emulators and prove nothing about specific firmware; see docs/STATUS.md.
 */
import http from 'http';
import crypto from 'crypto';
import net from 'net';

export interface StubHandle {
  port: number;
  requests: string[];
  close: () => Promise<void>;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)));
}

/** Digest (MD5, qop=auth) verification as a camera does it. */
function makeDigest(user: string, pass: string, realm: string) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
  return {
    challenge: `Digest realm="${realm}", qop="auth", nonce="${nonce}", opaque="stub", algorithm=MD5`,
    verify(req: http.IncomingMessage): boolean {
      const h = String(req.headers.authorization || '');
      if (!h.startsWith('Digest ')) return false;
      const f: Record<string, string> = {};
      h.slice(7).replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (_m, k, a, b) => ((f[k] = a ?? b), ''));
      if (f.username !== user || f.nonce !== nonce || f.realm !== realm) return false;
      const ha1 = md5(`${user}:${realm}:${pass}`);
      const ha2 = md5(`${req.method}:${f.uri}`);
      return f.response === md5(`${ha1}:${nonce}:${f.nc}:${f.cnonce}:${f.qop}:${ha2}`);
    },
  };
}

/**
 * Streams the given parts (each after `gapMs`) as multipart, then keeps the connection open
 * until closed. Requires Digest auth.
 */
export async function startMultipartCameraStub(opts: {
  path: string;
  user: string;
  pass: string;
  contentType: string;
  boundary: string;
  parts: Array<{ contentType: string; body: Buffer | string; withLength?: boolean }>;
  gapMs?: number;
}): Promise<StubHandle> {
  const requests: string[] = [];
  const digest = makeDigest(opts.user, opts.pass, 'IP Camera');
  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 'yes' : 'no'}`);
    if (!req.url!.startsWith(opts.path)) {
      res.statusCode = 404;
      return res.end();
    }
    if (!digest.verify(req)) {
      res.writeHead(401, { 'WWW-Authenticate': digest.challenge });
      return res.end('Unauthorized');
    }
    res.writeHead(200, { 'Content-Type': opts.contentType });
    let i = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (i >= opts.parts.length) return; // stay open
      const p = opts.parts[i++];
      const body = Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body);
      res.write(`--${opts.boundary}\r\nContent-Type: ${p.contentType}\r\n${p.withLength === false ? '' : `Content-Length: ${body.length}\r\n`}\r\n`);
      res.write(body);
      res.write('\r\n');
      setTimeout(tick, opts.gapMs ?? 20);
    };
    tick();
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const port = await listen(server);
  return {
    port,
    requests,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/**
 * ONVIF device + event service stub. Its clock runs `clockOffsetMs` ahead of the host clock and
 * WS-Security tokens are accepted only when Created is within 2 s of that clock, like devices
 * that enforce a replay window. Queued notification XML fragments are returned by PullMessages.
 */
export async function startOnvifStub(opts: { user: string; pass: string; clockOffsetMs: number; notifications: string[] }): Promise<StubHandle & { pulls: number; renewals: number; unsubscribed: boolean }> {
  const requests: string[] = [];
  const state = { pulls: 0, renewals: 0, unsubscribed: false };
  const camNow = () => new Date(Date.now() + opts.clockOffsetMs);
  const queue = [...opts.notifications];
  const env = (body: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:tev="http://www.onvif.org/ver10/events/wsdl" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:wsa="http://www.w3.org/2005/08/addressing"><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const fault = (reason: string) =>
    env(`<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>ter:NotAuthorized</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${reason}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`);
  const tokenOk = (xml: string) => {
    const g = (re: RegExp) => re.exec(xml)?.[1];
    const user = g(/<wsse:Username>([^<]*)</);
    const pw = g(/<wsse:Password[^>]*>([^<]*)</);
    const nonce = g(/<wsse:Nonce[^>]*>([^<]*)</);
    const created = g(/<wsu:Created>([^<]*)</);
    if (!user || !pw || !nonce || !created) return false;
    if (Math.abs(Date.parse(created) - camNow().getTime()) > 2000) return false;
    const expect = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(opts.pass)])).digest('base64');
    return user === opts.user && pw === expect;
  };
  let port = 0;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const op = /<s:Body><(?:\w+:)?(\w+)/.exec(raw)?.[1] || '?';
      requests.push(`${req.url} ${op}`);
      res.setHeader('content-type', 'application/soap+xml; charset=utf-8');
      const reply = (body: string, status = 200) => {
        res.statusCode = status;
        res.end(env(body));
      };
      if (op === 'GetSystemDateAndTime') {
        const n = camNow();
        return reply(
          `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings><tt:UTCDateTime><tt:Time><tt:Hour>${n.getUTCHours()}</tt:Hour><tt:Minute>${n.getUTCMinutes()}</tt:Minute><tt:Second>${n.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${n.getUTCFullYear()}</tt:Year><tt:Month>${n.getUTCMonth() + 1}</tt:Month><tt:Day>${n.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`
        );
      }
      if (!tokenOk(raw)) {
        res.statusCode = 400;
        return res.end(fault('Sender not Authorized'));
      }
      const t = camNow();
      switch (op) {
        case 'GetCapabilities':
          // Advertises the camera's LAN address, as cameras behind NAT do.
          return reply(`<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Events><tt:XAddr>http://192.168.1.64/onvif/event_service</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events></tds:Capabilities></tds:GetCapabilitiesResponse>`);
        case 'CreatePullPointSubscription':
          return reply(
            `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa:Address>http://192.168.1.64/onvif/subscription/1</wsa:Address></tev:SubscriptionReference><wsnt:CurrentTime>${iso(t)}</wsnt:CurrentTime><wsnt:TerminationTime>${iso(new Date(t.getTime() + 25000))}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`
          );
        case 'PullMessages': {
          state.pulls++;
          const msgs = queue.splice(0, queue.length).join('');
          const send = () =>
            reply(`<tev:PullMessagesResponse><tev:CurrentTime>${iso(camNow())}</tev:CurrentTime><tev:TerminationTime>${iso(new Date(camNow().getTime() + 15000))}</tev:TerminationTime>${msgs}</tev:PullMessagesResponse>`);
          return msgs ? send() : setTimeout(send, 150);
        }
        case 'Renew':
          state.renewals++;
          return reply(`<wsnt:RenewResponse><wsnt:TerminationTime>${iso(new Date(t.getTime() + 60000))}</wsnt:TerminationTime><wsnt:CurrentTime>${iso(t)}</wsnt:CurrentTime></wsnt:RenewResponse>`);
        case 'Unsubscribe':
          state.unsubscribed = true;
          return reply('<wsnt:UnsubscribeResponse/>');
        default:
          res.statusCode = 400;
          return res.end(fault(`unsupported ${op}`));
      }
    });
  });
  port = await listen(server);
  return {
    port,
    requests,
    get pulls() {
      return state.pulls;
    },
    get renewals() {
      return state.renewals;
    },
    get unsubscribed() {
      return state.unsubscribed;
    },
    push: (xml: string) => queue.push(xml),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  } as any;
}
