/**
 * Enterprise single sign-on with OpenID Connect (Phase 8, behind OIDC_SSO).
 *
 *   GET/POST/PATCH/DELETE /providers     administrators configure providers (the client secret is stored
 *                                        encrypted and never returned; discovery is checked on save)
 *   GET  /login-options                  enabled providers for the login page (id and name only)
 *   GET  /authorize/:providerId          302 to the provider (authorization code + PKCE, state and nonce kept
 *                                        hashed in the database, single use, 10 minutes)
 *   GET  /callback                       code exchange, ID-token verification, account linking; 302 to
 *                                        <public URL>/sso/complete#code=<one-time code> (or #error=<code>)
 *   POST /exchange {code}                the one-time code (single use, 60 s) for a VigilOne session
 *
 * Accounts: an identity already linked (provider + sub) signs in as its user. Otherwise a user of the provider's
 * tenant with the same email is linked, but only when the provider says the email is verified and its domain is
 * allowed. Otherwise a user is created only when autoProvision is on. SUPER_ADMIN is never granted through SSO.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Role } from '@prisma/client';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { OidcService } from '../services/auth/oidc.service';
import { authorizationUrl, discover, exchangeCode, fetchUserinfo, OidcError, providerUrlProblem, verifyIdToken } from '../services/auth/oidcClient';
import { encryptCredential, decryptCredential } from '../utils/crypto';
import { AuditChainService } from '../services/audit/auditChain.service';
import { createAuthSession } from './auth.routes';
import { setting } from '../config/settings';

const router = Router();
const oidcService = new OidcService(prisma);

const AUTHORIZE_TTL_MS = 10 * 60_000;
const LOGIN_CODE_TTL_MS = 60_000;
const ROLE_RANK: Record<Role, number> = { VIEWER: 0, OPERATOR: 1, TENANT_ADMIN: 2, SUPER_ADMIN: 3 };
const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');
const grantable = z.enum(['VIEWER', 'OPERATOR', 'TENANT_ADMIN']);

const providerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    issuerUrl: z.string().trim().max(500).refine((v) => providerUrlProblem(v) === null, (v) => ({ message: `issuerUrl ${providerUrlProblem(v)}` })),
    clientId: z.string().trim().min(1).max(255),
    clientSecret: z.string().min(1).max(1000),
    scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/)).max(20).optional(),
    enabled: z.boolean().optional(),
    allowedEmailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).max(50).optional(),
    autoProvision: z.boolean().optional(),
    defaultRole: grantable.optional(),
    roleClaim: z.string().trim().min(1).max(100).nullable().optional(),
    roleMapping: z.record(z.string().min(1).max(200), grantable).nullable().optional(),
  })
  .strict();

const providerView = (p: any) => ({
  id: p.id,
  name: p.name,
  type: p.type,
  issuerUrl: p.issuerUrl,
  clientId: p.clientId,
  clientSecretSet: Boolean(p.clientSecretEncrypted),
  scopes: p.scopes,
  enabled: p.enabled,
  allowedEmailDomains: p.allowedEmailDomains,
  autoProvision: p.autoProvision,
  defaultRole: p.defaultRole,
  roleClaim: p.roleClaim,
  roleMapping: p.roleMappingJson,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** Base URL users reach VigilOne at. Required in production; elsewhere the request's own host is used. */
function publicBase(req: Request): string {
  const configured = setting('VIGILONE_PUBLIC_URL');
  if (configured) return configured;
  if (setting('NODE_ENV') === 'production') throw new OidcError('NO_PUBLIC_URL', 'set VIGILONE_PUBLIC_URL to the address users open VigilOne at');
  return `${req.protocol}://${req.get('host')}`;
}
const redirectUri = (req: Request) => `${publicBase(req)}/api/v1/sso/callback`;

async function audit(req: Request, tenantId: string, action: string, userId: string | null, resourceId: string, metadata: Record<string, unknown>) {
  await AuditChainService.record(prisma, {
    tenantId,
    userId: userId ?? undefined,
    action,
    resourceType: 'IdentityProvider',
    resourceId,
    ipAddress: req.ip || '127.0.0.1',
    userAgent: req.headers['user-agent'],
    metadata,
  });
}

// ---------------------------------------------------------------- provider administration

router.get('/providers', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  const providers = await prisma.identityProvider.findMany({ where: { tenantId: req.user!.tenantId }, orderBy: { createdAt: 'desc' } });
  return res.json(providers.map(providerView));
});

async function checkDiscovery(issuerUrl: string): Promise<string | null> {
  try {
    await discover(issuerUrl, { fresh: true });
    return null;
  } catch (e: any) {
    return e.message;
  }
}

router.post('/providers', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  const p = providerSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid request', issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const tenantId = req.user!.tenantId;
  if (await prisma.identityProvider.findFirst({ where: { tenantId, name: p.data.name } })) return res.status(409).json({ error: 'a provider with this name exists' });
  const problem = await checkDiscovery(p.data.issuerUrl);
  if (problem) return res.status(400).json({ error: `provider discovery failed: ${problem}` });
  const { clientSecret, roleMapping, ...rest } = p.data;
  const provider = await prisma.identityProvider.create({
    data: { ...rest, tenantId, clientSecretEncrypted: encryptCredential(clientSecret), roleMappingJson: roleMapping ?? undefined },
  });
  await audit(req, tenantId, 'SSO_PROVIDER_CREATED', req.user!.id, provider.id, { name: provider.name, issuerUrl: provider.issuerUrl, autoProvision: provider.autoProvision });
  return res.status(201).json(providerView(provider));
});

router.patch('/providers/:id', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  const p = providerSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid request', issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  const found = await prisma.identityProvider.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!found) return res.status(404).json({ error: 'Provider not found' });
  if (p.data.issuerUrl) {
    const problem = await checkDiscovery(p.data.issuerUrl);
    if (problem) return res.status(400).json({ error: `provider discovery failed: ${problem}` });
  }
  const { clientSecret, roleMapping, ...rest } = p.data;
  if (rest.enabled && !clientSecret && !found.clientSecretEncrypted) return res.status(400).json({ error: 'enter the client secret before enabling this provider' });
  const provider = await prisma.identityProvider.update({
    where: { id: found.id },
    data: { ...rest, ...(clientSecret ? { clientSecretEncrypted: encryptCredential(clientSecret) } : {}), ...(roleMapping !== undefined ? { roleMappingJson: roleMapping ?? undefined } : {}) },
  });
  const { clientSecret: _omit, ...logged } = p.data;
  await audit(req, provider.tenantId, 'SSO_PROVIDER_UPDATED', req.user!.id, provider.id, { changes: logged, clientSecretChanged: Boolean(clientSecret) });
  return res.json(providerView(provider));
});

router.delete('/providers/:id', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  const provider = await prisma.identityProvider.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!provider) return res.status(404).json({ error: 'Provider not found' });
  await prisma.identityProvider.delete({ where: { id: provider.id } });
  await audit(req, provider.tenantId, 'SSO_PROVIDER_DELETED', req.user!.id, provider.id, { name: provider.name });
  return res.json({ message: 'Identity provider deleted' });
});

// ---------------------------------------------------------------- login flow

router.get('/login-options', async (_req: Request, res: Response) => {
  const providers = await prisma.identityProvider.findMany({ where: { enabled: true, clientSecretEncrypted: { not: '' } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return res.json({ providers });
});

router.get('/authorize/:providerId', async (req: Request, res: Response) => {
  const provider = await prisma.identityProvider.findUnique({ where: { id: req.params.providerId } });
  if (!provider || !provider.enabled || !provider.clientSecretEncrypted) return res.status(404).json({ error: 'Identity provider not found or disabled' });
  try {
    const d = await discover(provider.issuerUrl);
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    await prisma.oidcLoginState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await prisma.oidcLoginState.create({ data: { id: sha256(state), kind: 'AUTHORIZE', providerId: provider.id, codeVerifier, nonce, expiresAt: new Date(Date.now() + AUTHORIZE_TTL_MS) } });
    const url = authorizationUrl(d, { clientId: provider.clientId, redirectUri: redirectUri(req), scopes: provider.scopes, state, nonce, codeChallenge });
    if (req.query.format === 'json') return res.json({ authorizationUrl: url });
    return res.redirect(302, url);
  } catch (e: any) {
    return res.status(502).json({ error: e.message, code: e.code ?? 'SSO_ERROR' });
  }
});

/** Consumes a single-use row: deleted in the same statement that finds it, so a replay finds nothing. */
async function consume(id: string, kind: 'AUTHORIZE' | 'LOGIN_CODE') {
  const rows = await prisma.$queryRaw<{ id: string; providerId: string; codeVerifier: string | null; nonce: string | null; userId: string | null; expiresAt: Date }[]>`
    DELETE FROM "OidcLoginState" WHERE "id" = ${id} AND "kind" = ${kind} RETURNING "id", "providerId", "codeVerifier", "nonce", "userId", "expiresAt"`;
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

function highestMappedRole(claims: Record<string, unknown>, roleClaim: string | null, mapping: unknown): Role | null {
  if (!roleClaim || !mapping || typeof mapping !== 'object') return null;
  const raw = claims[roleClaim];
  const groups = Array.isArray(raw) ? raw.filter((g): g is string => typeof g === 'string') : typeof raw === 'string' ? [raw] : [];
  let best: Role | null = null;
  for (const g of groups) {
    const r = (mapping as Record<string, string>)[g];
    if (r && r in ROLE_RANK && r !== 'SUPER_ADMIN' && (best === null || ROLE_RANK[r as Role] > ROLE_RANK[best])) best = r as Role;
  }
  return best;
}

class LoginRefused extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

router.get('/callback', async (req: Request, res: Response) => {
  let base: string;
  try {
    base = publicBase(req);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
  const fail = (code: string) => res.redirect(302, `${base}/sso/complete#error=${encodeURIComponent(code)}`);
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const pending = state ? await consume(sha256(state), 'AUTHORIZE') : null;
  if (!pending) return fail('LOGIN_EXPIRED_OR_REPLAYED');
  const provider = await prisma.identityProvider.findUnique({ where: { id: pending.providerId } });
  if (!provider || !provider.enabled) return fail('PROVIDER_DISABLED');
  const refuse = async (reason: string, detail: string, extra: Record<string, unknown> = {}) => {
    await audit(req, provider.tenantId, 'SSO_LOGIN_REFUSED', null, provider.id, { reason, detail, ...extra });
    return fail(reason);
  };
  if (typeof req.query.error === 'string') return refuse('PROVIDER_ERROR', `${req.query.error}: ${String(req.query.error_description ?? '').slice(0, 300)}`);
  if (!code) return refuse('NO_CODE', 'the provider returned no code');

  let claims: Record<string, unknown>;
  try {
    const d = await discover(provider.issuerUrl);
    // RFC 9207: when the provider names itself in the response, it must be this provider.
    if (typeof req.query.iss === 'string' && req.query.iss !== d.issuer) return refuse('ISSUER_MISMATCH', `iss ${req.query.iss}`);
    const { idToken, accessToken } = await exchangeCode(d, { clientId: provider.clientId, clientSecret: decryptCredential(provider.clientSecretEncrypted), code, redirectUri: redirectUri(req), codeVerifier: pending.codeVerifier! });
    const verified = await verifyIdToken(d, idToken, { clientId: provider.clientId, nonce: pending.nonce! });
    // Claims the ID token lacks come from userinfo; the ID token's own claims always win.
    const wanted = ['email', 'email_verified', 'name', ...(provider.roleClaim ? [provider.roleClaim] : [])];
    const extra = accessToken && wanted.some((k) => verified[k] === undefined) ? await fetchUserinfo(d, accessToken, verified.sub as string) : {};
    claims = { ...extra, ...verified };
  } catch (e: any) {
    return refuse(e instanceof OidcError ? e.code : 'SSO_ERROR', String(e.message).slice(0, 500));
  }

  const sub = claims.sub as string;
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
  const emailVerified = claims.email_verified === true;
  const mappedRole = highestMappedRole(claims, provider.roleClaim, provider.roleMappingJson);
  try {
    const user = await prisma.$transaction(async (tx) => {
      const linked = await tx.externalIdentity.findUnique({ where: { providerId_subject: { providerId: provider.id, subject: sub } }, include: { user: true } });
      let user = linked?.user ?? null;
      if (!user) {
        if (!email || !emailVerified) throw new LoginRefused('EMAIL_NOT_VERIFIED', 'the provider did not supply a verified email for an unlinked identity');
        const domain = email.split('@')[1] ?? '';
        if (provider.allowedEmailDomains.length > 0 && !provider.allowedEmailDomains.includes(domain)) throw new LoginRefused('EMAIL_DOMAIN_NOT_ALLOWED', `domain ${domain} is not allowed for this provider`);
        const existing = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
        if (existing && existing.tenantId !== provider.tenantId) throw new LoginRefused('ACCOUNT_IN_OTHER_TENANT', 'a user with this email belongs to another tenant');
        if (existing) user = existing;
        else if (provider.autoProvision) {
          user = await tx.user.create({
            data: {
              tenantId: provider.tenantId,
              email,
              name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : email,
              role: mappedRole ?? provider.defaultRole,
              passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10), // SSO-only: no usable password
            },
          });
        } else throw new LoginRefused('NO_ACCOUNT', 'no VigilOne user matches this identity and automatic provisioning is off');
        await tx.externalIdentity.create({ data: { tenantId: provider.tenantId, providerId: provider.id, subject: sub, userId: user.id, email } });
      }
      if (user.tenantId !== provider.tenantId) throw new LoginRefused('ACCOUNT_IN_OTHER_TENANT', 'the linked user belongs to another tenant');
      if (!user.active) throw new LoginRefused('ACCOUNT_DISABLED', 'the VigilOne user is disabled');
      if (user.role === 'SUPER_ADMIN') throw new LoginRefused('SUPER_ADMIN_NOT_VIA_SSO', 'super administrators sign in with their password');
      if (mappedRole && mappedRole !== user.role) user = await tx.user.update({ where: { id: user.id }, data: { role: mappedRole } });
      await tx.externalIdentity.update({ where: { providerId_subject: { providerId: provider.id, subject: sub } }, data: { lastLoginAt: new Date(), email } });
      return user;
    });
    const loginCode = crypto.randomBytes(32).toString('base64url');
    await prisma.oidcLoginState.create({ data: { id: sha256(loginCode), kind: 'LOGIN_CODE', providerId: provider.id, userId: user.id, expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_MS) } });
    return res.redirect(302, `${base}/sso/complete#code=${loginCode}`);
  } catch (e: any) {
    if (e instanceof LoginRefused) return refuse(e.code, e.message, { sub, email });
    return refuse('SSO_ERROR', String(e.message).slice(0, 500), { sub });
  }
});

router.post('/exchange', async (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const pending = code ? await consume(sha256(code), 'LOGIN_CODE') : null;
  if (!pending || !pending.userId) return res.status(401).json({ error: 'login code invalid, expired or already used' });
  const user = await prisma.user.findUnique({ where: { id: pending.userId }, include: { tenant: true } });
  if (!user || !user.active) return res.status(401).json({ error: 'login code invalid, expired or already used' });
  const { token } = await createAuthSession({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId }, res);
  await AuditChainService.record(prisma, {
    tenantId: user.tenantId,
    userId: user.id,
    action: 'LOGIN_SUCCESS',
    resourceType: 'User',
    resourceId: user.id,
    ipAddress: req.ip || '127.0.0.1',
    userAgent: req.headers['user-agent'],
    metadata: { method: 'OIDC_SSO', providerId: pending.providerId },
  });
  return res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenantId, tenantName: user.tenant.name } });
});

/**
 * List active sessions for user
 */
router.get('/sessions', requireAuth, async (req: Request, res: Response) => {
  try {
    const sessions = await prisma.userSession.findMany({
      where: {
        userId: req.user!.id,
        tenantId: req.user!.tenantId,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(sessions);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Unlock a locked session (Strict ownership / admin check)
 */
router.post('/sessions/:sessionId/unlock', requireAuth, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.userSession.findUnique({
      where: { id: req.params.sessionId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (existing.userId !== req.user!.id && req.user!.role !== 'SUPER_ADMIN' && req.user!.role !== 'TENANT_ADMIN') {
      return res.status(403).json({ error: 'Forbidden: Cannot unlock another user\'s session' });
    }
    const session = await oidcService.unlockSession(req.params.sessionId);
    return res.json({ message: 'Session unlocked', session });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Revoke specific session (Strict ownership / admin check)
 */
router.post('/sessions/:sessionId/revoke', requireAuth, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.userSession.findUnique({
      where: { id: req.params.sessionId },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (existing.userId !== req.user!.id && req.user!.role !== 'SUPER_ADMIN' && req.user!.role !== 'TENANT_ADMIN') {
      return res.status(403).json({ error: 'Forbidden: Cannot revoke another user\'s session' });
    }
    const session = await oidcService.revokeSession(req.params.sessionId);
    return res.json({ message: 'Session revoked', session });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Revoke all sessions for user
 */
router.post('/sessions/revoke-all', requireAuth, async (req: Request, res: Response) => {
  try {
    await oidcService.revokeAllUserSessions(req.user!.id);
    return res.json({ message: 'All user sessions revoked successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
