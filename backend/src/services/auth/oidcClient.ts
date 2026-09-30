/**
 * OpenID Connect relying party (Phase 8): discovery, authorization-code exchange with PKCE, and ID-token
 * verification with `jose` (signature against the provider's JWKS, issuer, audience, expiry, nonce, azp).
 *
 * Provider URLs must be https. Plain http is accepted only for loopback hosts outside production (tests and a
 * provider on the same machine). The discovery document's issuer must equal the configured issuer exactly
 * (OIDC Discovery 1.0, section 4.3), so a provider cannot hand out tokens under another issuer.
 */
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

export class OidcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** Returns an error message, or null when the URL may be used for a provider. */
export function providerUrlProblem(raw: string, env = process.env.NODE_ENV): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (u.username || u.password) return 'must not contain credentials';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname) && env !== 'production') return null;
  return 'must be https (http only for a loopback provider outside production)';
}

const discoveryCache = new Map<string, { doc: OidcDiscovery; at: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function discover(issuer: string, { fresh = false } = {}): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (!fresh && cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const problem = providerUrlProblem(issuer);
  if (problem) throw new OidcError('BAD_ISSUER', `issuer ${problem}`);
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  let r: Response;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (e: any) {
    throw new OidcError('DISCOVERY_FAILED', `cannot fetch ${url}: ${e.message}`);
  }
  if (!r.ok) throw new OidcError('DISCOVERY_FAILED', `${url} answered HTTP ${r.status}`);
  const doc = (await r.json().catch(() => null)) as Partial<OidcDiscovery> | null;
  if (!doc || typeof doc !== 'object') throw new OidcError('DISCOVERY_FAILED', `${url} is not JSON`);
  if (doc.issuer !== issuer) throw new OidcError('ISSUER_MISMATCH', `the provider says its issuer is ${JSON.stringify(doc.issuer)}, configured ${JSON.stringify(issuer)}`);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const v = doc[k];
    if (typeof v !== 'string') throw new OidcError('DISCOVERY_FAILED', `discovery has no ${k}`);
    const p = providerUrlProblem(v);
    if (p) throw new OidcError('DISCOVERY_FAILED', `${k} ${p}`);
  }
  const out: OidcDiscovery = { issuer: doc.issuer, authorization_endpoint: doc.authorization_endpoint!, token_endpoint: doc.token_endpoint!, jwks_uri: doc.jwks_uri! };
  if (typeof doc.userinfo_endpoint === 'string' && providerUrlProblem(doc.userinfo_endpoint) === null) out.userinfo_endpoint = doc.userinfo_endpoint;
  discoveryCache.set(issuer, { doc: out, at: Date.now() });
  return out;
}

export function authorizationUrl(d: OidcDiscovery, p: { clientId: string; redirectUri: string; scopes: string[]; state: string; nonce: string; codeChallenge: string }): string {
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', Array.from(new Set(['openid', ...p.scopes])).join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('nonce', p.nonce);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** Exchanges the code (client_secret_basic, PKCE) and returns the ID token and the access token (if any). */
export async function exchangeCode(d: OidcDiscovery, p: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string }): Promise<{ idToken: string; accessToken?: string }> {
  const basic = Buffer.from(`${encodeURIComponent(p.clientId)}:${encodeURIComponent(p.clientSecret)}`).toString('base64');
  let r: Response;
  try {
    r = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (e: any) {
    throw new OidcError('TOKEN_EXCHANGE_FAILED', `token endpoint unreachable: ${e.message}`);
  }
  const body = (await r.json().catch(() => ({}))) as { id_token?: unknown; access_token?: unknown; error?: string; error_description?: string };
  if (!r.ok) throw new OidcError('TOKEN_EXCHANGE_FAILED', `token endpoint answered HTTP ${r.status}${body.error ? ` (${body.error}${body.error_description ? `: ${body.error_description}` : ''})` : ''}`);
  if (typeof body.id_token !== 'string') throw new OidcError('TOKEN_EXCHANGE_FAILED', 'the token response has no id_token');
  return { idToken: body.id_token, accessToken: typeof body.access_token === 'string' ? body.access_token : undefined };
}

/**
 * Claims from the userinfo endpoint. Providers following the spec put profile claims (email, groups) there
 * rather than in the ID token for the code flow. Its `sub` must equal the ID token's (OIDC Core 5.3.2).
 */
export async function fetchUserinfo(d: OidcDiscovery, accessToken: string, sub: string): Promise<Record<string, unknown>> {
  if (!d.userinfo_endpoint) return {};
  let r: Response;
  try {
    r = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch (e: any) {
    throw new OidcError('USERINFO_FAILED', `userinfo endpoint unreachable: ${e.message}`);
  }
  if (!r.ok) throw new OidcError('USERINFO_FAILED', `userinfo endpoint answered HTTP ${r.status}`);
  if (!(r.headers.get('content-type') || '').includes('json')) throw new OidcError('USERINFO_FAILED', 'userinfo is not JSON (signed userinfo is not supported)');
  const u = (await r.json()) as Record<string, unknown>;
  if (u.sub !== sub) throw new OidcError('USERINFO_FAILED', 'userinfo sub differs from the ID token sub');
  return u;
}

export async function verifyIdToken(d: OidcDiscovery, idToken: string, p: { clientId: string; nonce: string }): Promise<JWTPayload & Record<string, unknown>> {
  let jwks = jwksCache.get(d.jwks_uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: TIMEOUT_MS });
    jwksCache.set(d.jwks_uri, jwks);
  }
  let payload: JWTPayload & Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, { issuer: d.issuer, audience: p.clientId, algorithms: ALGORITHMS, clockTolerance: 60, requiredClaims: ['sub', 'exp', 'iat'] }));
  } catch (e: any) {
    throw new OidcError('ID_TOKEN_INVALID', `ID token rejected: ${e.code ?? ''} ${e.message}`.trim());
  }
  if (payload.nonce !== p.nonce) throw new OidcError('ID_TOKEN_INVALID', 'ID token nonce does not match this login');
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== p.clientId) throw new OidcError('ID_TOKEN_INVALID', 'ID token has several audiences and azp is not this client');
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 255) throw new OidcError('ID_TOKEN_INVALID', 'ID token sub is missing or too long');
  return payload;
}

/** Test hook: forget cached discovery documents and key sets. */
export function clearOidcCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
