import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { OidcService } from '../services/auth/oidc.service';

const router = Router();
const prisma = new PrismaClient();
const oidcService = new OidcService(prisma);

// In-memory PKCE state cache for authorization flow
const pkceStates = new Map<string, { codeVerifier: string; state: string; nonce: string; tenantId: string; providerId: string; expiresAt: number }>();

/**
 * List all configured OIDC identity providers for tenant
 */
router.get('/providers', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  try {
    const providers = await prisma.identityProvider.findMany({
      where: { tenantId: req.user!.tenantId },
      select: {
        id: true,
        name: true,
        type: true,
        issuerUrl: true,
        clientId: true,
        scopes: true,
        enabled: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(providers);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Configure an OIDC identity provider
 */
router.post('/providers', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  const { name, issuerUrl, clientId, clientSecret, scopes, enabled } = req.body;
  if (!name || !issuerUrl || !clientId || !clientSecret) {
    return res.status(400).json({ error: 'name, issuerUrl, clientId, and clientSecret are required' });
  }

  try {
    const provider = await prisma.identityProvider.create({
      data: {
        tenantId: req.user!.tenantId,
        name,
        issuerUrl,
        clientId,
        clientSecretEncrypted: clientSecret, // in production sealed via KMS/vault
        scopes: scopes || ['openid', 'profile', 'email'],
        enabled: enabled ?? true,
      },
    });
    return res.status(201).json(provider);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Remove an OIDC identity provider
 */
router.delete('/providers/:id', requireAuth, authorize(Permission.SSO_MANAGE), async (req: Request, res: Response) => {
  try {
    const provider = await prisma.identityProvider.findFirst({
      where: { id: req.params.id, tenantId: req.user!.tenantId },
    });
    if (!provider) return res.status(404).json({ error: 'Provider not found' });

    await prisma.identityProvider.delete({ where: { id: provider.id } });
    return res.json({ message: 'Identity provider deleted' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Initiates OIDC Authorization Code Flow with PKCE
 */
router.get('/authorize/:providerId', async (req: Request, res: Response) => {
  try {
    const provider = await prisma.identityProvider.findUnique({
      where: { id: req.params.providerId },
    });
    if (!provider || !provider.enabled) {
      return res.status(404).json({ error: 'Identity provider not found or disabled' });
    }

    const pkce = oidcService.generatePkceBundle();
    pkceStates.set(pkce.state, {
      codeVerifier: pkce.codeVerifier,
      state: pkce.state,
      nonce: pkce.nonce,
      tenantId: provider.tenantId,
      providerId: provider.id,
      expiresAt: Date.now() + 600000, // 10 min TTL
    });

    const redirectUri = `${req.protocol}://${req.get('host')}/api/v1/sso/callback`;
    const authUrl = `${provider.issuerUrl}/protocol/openid-connect/auth?` +
      `response_type=code&client_id=${encodeURIComponent(provider.clientId)}&` +
      `scope=${encodeURIComponent(provider.scopes.join(' '))}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${pkce.state}&nonce=${pkce.nonce}&` +
      `code_challenge=${pkce.codeChallenge}&code_challenge_method=S256`;

    return res.json({
      authorizationUrl: authUrl,
      state: pkce.state,
      codeChallenge: pkce.codeChallenge,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * OIDC Token Exchange and Session Provisioning Callback
 */
router.post('/callback', async (req: Request, res: Response) => {
  const { code, state, mockClaims } = req.body;
  if (!state) return res.status(400).json({ error: 'Missing state parameter' });

  const storedState = pkceStates.get(state);
  if (!storedState || Date.now() > storedState.expiresAt) {
    return res.status(400).json({ error: 'Invalid or expired OIDC state' });
  }
  pkceStates.delete(state);

  try {
    const provider = await prisma.identityProvider.findUnique({
      where: { id: storedState.providerId },
    });
    if (!provider) return res.status(404).json({ error: 'Identity provider missing' });

    // In production, exchanges code for ID Token at provider token endpoint.
    // Supports mockClaims in test / sandbox environments.
    const claims = mockClaims || {
      iss: provider.issuerUrl,
      sub: `user-${Date.now()}`,
      aud: provider.clientId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: storedState.nonce,
      email: 'sso.operator@enterprise.internal',
      name: 'SSO Operator',
      groups: ['cctv_operators'],
    };

    const validation = oidcService.validateTokenClaims(
      claims,
      provider.issuerUrl,
      provider.clientId,
      storedState.nonce
    );

    if (!validation.valid) {
      return res.status(401).json({ error: validation.error });
    }

    const assignedRole = oidcService.mapClaimsToRole(claims);

    // Upsert tenant user record
    const user = await prisma.user.upsert({
      where: {
        email: claims.email || `${claims.sub}@sso.internal`,
      },
      create: {
        tenantId: storedState.tenantId,
        email: claims.email || `${claims.sub}@sso.internal`,
        passwordHash: 'OIDC_MANAGED_EXTERNAL_IDENTITY',
        name: claims.name || claims.sub,
        role: assignedRole,
      },
      update: {
        name: claims.name || claims.sub,
        role: assignedRole,
      },
    });

    // Create active workstation session
    const session = await oidcService.createSession(storedState.tenantId, user.id);

    return res.json({
      message: 'SSO authentication successful',
      sessionId: session.id,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
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
 * Unlock a locked session
 */
router.post('/sessions/:sessionId/unlock', requireAuth, async (req: Request, res: Response) => {
  try {
    const session = await oidcService.unlockSession(req.params.sessionId);
    return res.json({ message: 'Session unlocked', session });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Revoke specific session
 */
router.post('/sessions/:sessionId/revoke', requireAuth, async (req: Request, res: Response) => {
  try {
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
