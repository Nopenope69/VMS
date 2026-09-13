import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { OidcService } from '../services/auth/oidc.service';

const router = Router();
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
 * HARD-DISABLED for v1 core edge appliance.
 */
router.post('/callback', async (_req: Request, res: Response) => {
  return res.status(501).json({
    error: 'SSO authentication is disabled in VigilOne v1 core edge appliance.',
    code: 'FEATURE_DISABLED_FOR_V1',
  });
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
