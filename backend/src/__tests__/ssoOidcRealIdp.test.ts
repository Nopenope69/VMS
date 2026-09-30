/**
 * Phase 8 single sign-on against a REAL OpenID Connect provider: tools/sim/oidc/server.mjs runs oidc-provider
 * (an independent, OpenID-certified implementation) in its own process. The test drives its login form the way a
 * browser would, then VigilOne's callback and code exchange, with the real database and API.
 *
 * ID-token verification is also checked on tokens crafted here (wrong nonce, audience, issuer, key, algorithm,
 * expiry), served from a local discovery document and JWKS.
 *
 * Needs tools/sim/oidc/node_modules (npm ci there). Skipped without it unless VIGILONE_REQUIRE_OIDC_SIM=1 (CI).
 */
import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { discover, verifyIdToken, providerUrlProblem, clearOidcCaches, OidcDiscovery } from '../services/auth/oidcClient';
import { createTenantWithCamera, startApp } from './helpers/realDb';
import { createUserWithToken } from './helpers/realDb';

const simDir = path.join(__dirname, '../../../tools/sim/oidc');
const available = fs.existsSync(path.join(simDir, 'node_modules/oidc-provider'));
const required = process.env.VIGILONE_REQUIRE_OIDC_SIM === '1';
jest.setTimeout(120000);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

describe('OIDC test provider', () => {
  it('is installed, or this run does not require it (VIGILONE_REQUIRE_OIDC_SIM)', () => {
    if (!available && required) throw new Error('run npm ci in tools/sim/oidc');
    expect(available || !required).toBe(true);
  });
});

describe('ID-token verification (crafted tokens)', () => {
  let server: http.Server;
  let issuer = '';
  let d: OidcDiscovery;
  let key: any;
  let otherKey: any;
  const clientId = 'vms-client';

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    key = kp.privateKey;
    otherKey = (await generateKeyPair('RS256')).privateKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const port = await freePort();
    issuer = `http://127.0.0.1:${port}`;
    let discoveryIssuer = issuer;
    server = http.createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ issuer: discoveryIssuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` }));
      } else if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [jwk] }));
      } else if (req.url === '/lying-issuer') {
        discoveryIssuer = 'https://someone-else.example';
        res.end('ok');
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
    clearOidcCaches();
    d = await discover(issuer);
  });
  afterAll(() => server.close());

  const token = (claims: Record<string, unknown>, opts: { k?: any; alg?: string; kid?: string } = {}) =>
    new SignJWT({ nonce: 'n-1', ...claims })
      .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1' })
      .setIssuer((claims.iss as string) ?? issuer)
      .setAudience((claims.aud as string | string[]) ?? clientId)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime((claims.exp as number) ?? '5m')
      .sign(opts.k ?? key);

  it('accepts a correct token', async () => {
    const p = await verifyIdToken(d, await token({}), { clientId, nonce: 'n-1' });
    expect(p.sub).toBe('user-1');
  });

  it.each([
    ['another nonce', async () => token({ nonce: 'n-2' }), /nonce/],
    ['another audience', async () => token({ aud: 'someone-else' }), /aud/],
    ['another issuer', async () => token({ iss: 'http://127.0.0.1:1' }), /iss/],
    ['expired', async () => token({ exp: Math.floor(Date.now() / 1000) - 3600 }), /exp/],
    ['signed by another key', async () => token({}, { k: otherKey }), /signature/],
    ['several audiences without azp', async () => token({ aud: [clientId, 'other'] }), /azp/],
    ['HS256 with a guessed secret', async () => new SignJWT({ nonce: 'n-1' }).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).setIssuer(issuer).setAudience(clientId).setSubject('u').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode('x'.repeat(32))), /alg|ALG/],
    ['alg none', async () => {
      const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b({ alg: 'none' })}.${b({ iss: issuer, aud: clientId, sub: 'u', nonce: 'n-1', iat: 1, exp: 9999999999 })}.`;
    }, /alg|ALG|JWS/],
  ])('rejects a token with %s', async (_name, make, why) => {
    await expect(verifyIdToken(d, await make(), { clientId, nonce: 'n-1' })).rejects.toThrow(why);
  });

  it('refuses a discovery document naming another issuer, and insecure provider URLs', async () => {
    await fetch(`${issuer}/lying-issuer`);
    await expect(discover(issuer, { fresh: true })).rejects.toThrow(/issuer/);
    expect(providerUrlProblem('http://idp.example.com')).toMatch(/https/);
    expect(providerUrlProblem('http://127.0.0.1:8080', 'production')).toMatch(/https/);
    expect(providerUrlProblem('https://user:pw@idp.example.com')).toMatch(/credentials/);
    expect(providerUrlProblem('https://idp.example.com/realms/x')).toBeNull();
  });
});

(available ? describe : describe.skip)('SSO end to end with oidc-provider', () => {
  const prisma = new PrismaClient();
  const sfx = crypto.randomBytes(4).toString('hex');
  const clientSecret = crypto.randomBytes(24).toString('hex');
  const mail = (who: string, domain = 'corp.example') => `${who}-${sfx}@${domain}`;
  let idp: ChildProcess;
  let issuer = '';
  let app: { url: string; close: () => Promise<void> };
  let tenantId = '';
  let otherTenant = '';
  let admin = '';
  let providerId = '';
  const saved = { flag: process.env.VIGILONE_FEATURE_OIDC_SSO };

  const api = async (method: string, url: string, token?: string, body?: unknown) => {
    const r = await fetch(`${app.url}/api/v1${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const text = await r.text();
    const isJson = (r.headers.get('content-type') || '').includes('json');
    return { status: r.status, location: r.headers.get('location'), json: text && isJson ? JSON.parse(text) : null };
  };

  /** Signs in at the provider like a browser: follows redirects, submits the login form. Returns the callback URL. */
  async function idpLogin(login: string): Promise<string> {
    const start = await api('GET', `/sso/authorize/${providerId}`);
    expect(start.status).toBe(302);
    const jar = new Map<string, string>();
    let url = start.location!;
    for (let i = 0; i < 20; i++) {
      if (url.startsWith(`${app.url}/api/v1/sso/callback`)) return url;
      const interaction = /\/interaction\/([^/?#]+)$/.exec(new URL(url).pathname);
      const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let r: Response;
      if (interaction) {
        const page = await fetch(url, { headers: { cookie }, redirect: 'manual' });
        const html = await page.text();
        const prompt = html.includes('name="login"') ? 'login' : 'consent';
        r = await fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ prompt, login, password: 'any' }).toString(), redirect: 'manual' });
      } else {
        r = await fetch(url, { headers: { cookie }, redirect: 'manual' });
      }
      for (const c of r.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`the provider stopped at ${url} with HTTP ${r.status}`);
      url = new URL(loc, url).toString();
    }
    throw new Error('too many redirects');
  }

  /** Full login; returns the #fragment of VigilOne's final redirect as an object. */
  async function login(who: string, callbackUrl?: string) {
    const cb = callbackUrl ?? (await idpLogin(who));
    const r = await fetch(cb, { redirect: 'manual' });
    expect(r.status).toBe(302);
    const loc = r.headers.get('location')!;
    expect(loc.startsWith(`${app.url}/sso/complete#`)).toBe(true);
    return { ...Object.fromEntries(new URLSearchParams(loc.split('#')[1])), callbackUrl: cb } as { code?: string; error?: string; callbackUrl: string };
  }
  const lastRefusal = () => prisma.auditEvent.findFirst({ where: { tenantId, action: 'SSO_LOGIN_REFUSED' }, orderBy: { sequenceNumber: 'desc' } });

  beforeAll(async () => {
    process.env.VIGILONE_FEATURE_OIDC_SSO = 'true';
    clearOidcCaches();
    app = await startApp();
    const port = await freePort();
    issuer = `http://127.0.0.1:${port}`;
    const cfg = {
      clients: [{ client_id: 'vigilone', client_secret: clientSecret, redirect_uris: [`${app.url}/api/v1/sso/callback`] }],
      accounts: {
        alice: { email: mail('alice'), email_verified: true, name: 'Alice' },
        bob: { email: mail('bob'), email_verified: false },
        carol: { email: mail('carol'), email_verified: true, name: 'Carol', groups: ['vms-operators', 'staff'] },
        dave: { email: mail('dave', 'elsewhere.example'), email_verified: true },
        erin: { email: mail('erin'), email_verified: true },
        frank: { email: mail('frank'), email_verified: true },
      },
    };
    idp = spawn(process.execPath, [path.join(simDir, 'server.mjs'), '--port', String(port), '--config', JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the OIDC provider did not start')), 20000);
      idp.stdout!.on('data', (b) => b.toString().includes('listening') && (clearTimeout(t), resolve()));
      idp.on('exit', (c) => reject(new Error(`the OIDC provider exited (${c})`)));
    });
    ({ tenantId } = await createTenantWithCamera(prisma, 'sso'));
    ({ tenantId: otherTenant } = await createTenantWithCamera(prisma, 'sso-other'));
    admin = (await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN')).token;
    await prisma.user.create({ data: { tenantId, email: mail('alice'), name: 'Alice (local)', role: 'OPERATOR', passwordHash: 'x' } });
    await prisma.user.create({ data: { tenantId: otherTenant, email: mail('erin'), name: 'Erin elsewhere', role: 'OPERATOR', passwordHash: 'x' } });
    await prisma.user.create({ data: { tenantId, email: mail('frank'), name: 'Frank', role: 'OPERATOR', passwordHash: 'x', active: false } });
  });

  afterAll(async () => {
    idp?.kill('SIGKILL');
    await app.close();
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenant] } } });
    await prisma.$disconnect();
    if (saved.flag === undefined) delete process.env.VIGILONE_FEATURE_OIDC_SSO;
    else process.env.VIGILONE_FEATURE_OIDC_SSO = saved.flag;
  });

  it('an administrator adds the provider: discovery is checked, the secret is stored encrypted and never returned', async () => {
    expect((await api('POST', '/sso/providers', admin, { name: 'bad', issuerUrl: 'http://idp.example.com', clientId: 'x', clientSecret: 'y' })).status).toBe(400);
    const unreachable = await api('POST', '/sso/providers', admin, { name: 'bad', issuerUrl: `http://127.0.0.1:${await freePort()}`, clientId: 'x', clientSecret: 'y' });
    expect(unreachable.json.error).toMatch(/discovery failed/);
    expect((await api('POST', '/sso/providers', admin, { name: 'bad', issuerUrl: issuer, clientId: 'x', clientSecret: 'y', roleMapping: { g: 'SUPER_ADMIN' } })).status).toBe(400);
    const created = await api('POST', '/sso/providers', admin, { name: 'Corp IdP', issuerUrl: issuer, clientId: 'vigilone', clientSecret, scopes: ['openid', 'email', 'profile', 'groups'] });
    expect(created.status).toBe(201);
    providerId = created.json.id;
    expect(JSON.stringify(created.json)).not.toContain(clientSecret);
    expect(created.json).toMatchObject({ clientSecretSet: true, autoProvision: false, defaultRole: 'VIEWER' });
    const row = await prisma.identityProvider.findUnique({ where: { id: providerId } });
    expect(row!.clientSecretEncrypted).not.toContain(clientSecret);
    expect(JSON.stringify((await api('GET', '/sso/providers', admin)).json)).not.toContain(clientSecret);
    expect((await api('GET', '/sso/login-options')).json.providers).toEqual(expect.arrayContaining([{ id: providerId, name: 'Corp IdP' }]));
  });

  it('a verified email links to the existing user; the one-time code gives a session once; later logins use the link', async () => {
    const first = await login('alice');
    expect(first.code).toBeDefined();
    const ex = await api('POST', '/sso/exchange', undefined, { code: first.code });
    expect(ex.status).toBe(200);
    expect(ex.json.user).toMatchObject({ email: mail('alice'), role: 'OPERATOR' });
    const me = await api('GET', '/auth/me', ex.json.token);
    expect(me.status).toBe(200);
    expect((await api('POST', '/sso/exchange', undefined, { code: first.code })).status).toBe(401);
    const link = await prisma.externalIdentity.findUnique({ where: { providerId_subject: { providerId, subject: 'alice' } }, include: { user: true } });
    expect(link!.user.email).toBe(mail('alice'));
    const audit = await prisma.auditEvent.findFirst({ where: { tenantId, action: 'LOGIN_SUCCESS', userId: link!.userId }, orderBy: { sequenceNumber: 'desc' } });
    expect(audit!.metadataJson).toMatchObject({ method: 'OIDC_SSO', providerId });
    // the same callback (state and code) cannot be used twice
    expect((await login('alice', first.callbackUrl)).error).toBe('LOGIN_EXPIRED_OR_REPLAYED');
    const second = await login('alice');
    expect((await api('POST', '/sso/exchange', undefined, { code: second.code })).json.user.email).toBe(mail('alice'));
    expect(await prisma.externalIdentity.count({ where: { providerId } })).toBe(1);
  });

  it('a tampered state is refused', async () => {
    const cb = new URL(await idpLogin('alice'));
    cb.searchParams.set('state', crypto.randomBytes(32).toString('base64url'));
    expect((await login('alice', cb.toString())).error).toBe('LOGIN_EXPIRED_OR_REPLAYED');
  });

  it('refuses unverified emails, unknown users (provisioning off), other tenants and disabled users, and audits why', async () => {
    expect((await login('bob')).error).toBe('EMAIL_NOT_VERIFIED');
    expect((await lastRefusal())!.metadataJson).toMatchObject({ reason: 'EMAIL_NOT_VERIFIED', sub: 'bob' });
    expect((await login('carol')).error).toBe('NO_ACCOUNT');
    expect((await login('erin')).error).toBe('ACCOUNT_IN_OTHER_TENANT');
    expect((await login('frank')).error).toBe('ACCOUNT_DISABLED');
    expect(await prisma.user.count({ where: { email: mail('carol') } })).toBe(0);
  });

  it('with provisioning on: an allowed domain creates the user with the mapped role; other domains are refused', async () => {
    const patch = await api('PATCH', `/sso/providers/${providerId}`, admin, { autoProvision: true, allowedEmailDomains: ['corp.example'], roleClaim: 'groups', roleMapping: { 'vms-operators': 'OPERATOR', 'vms-admins': 'TENANT_ADMIN' } });
    expect(patch.status).toBe(200);
    const c = await login('carol');
    const ex = await api('POST', '/sso/exchange', undefined, { code: c.code });
    expect(ex.json.user).toMatchObject({ email: mail('carol'), role: 'OPERATOR', name: 'Carol' });
    expect((await login('dave')).error).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
  });

  it('a wrong client secret fails the code exchange at the provider', async () => {
    await api('PATCH', `/sso/providers/${providerId}`, admin, { clientSecret: 'not-the-secret' });
    const r = await login('alice');
    expect(r.error).toBe('TOKEN_EXCHANGE_FAILED');
    expect((await lastRefusal())!.metadataJson).toMatchObject({ reason: 'TOKEN_EXCHANGE_FAILED' });
    expect(String(((await lastRefusal())!.metadataJson as any).detail)).toMatch(/invalid_client/);
    await api('PATCH', `/sso/providers/${providerId}`, admin, { clientSecret });
    expect((await login('alice')).code).toBeDefined();
  });

  it('a disabled provider is not offered and cannot start a login; other tenants cannot manage it', async () => {
    const other = (await createUserWithToken(prisma, otherTenant, 'TENANT_ADMIN')).token;
    expect((await api('PATCH', `/sso/providers/${providerId}`, other, { enabled: false })).status).toBe(404);
    expect((await api('GET', '/sso/providers', other)).json).toEqual([]);
    await api('PATCH', `/sso/providers/${providerId}`, admin, { enabled: false });
    expect((await api('GET', '/sso/login-options')).json.providers.map((p: any) => p.id)).not.toContain(providerId);
    expect((await api('GET', `/sso/authorize/${providerId}`)).status).toBe(404);
  });
});
