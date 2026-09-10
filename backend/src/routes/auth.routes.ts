import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient, LicenseTier } from '@prisma/client';
import config from '../config/env';
import { requireAuth } from '../middleware/auth';
import { signLicensePayload, LicenseClaims } from '../utils/license';
import { AuditChainService } from '../services/audit/auditChain.service';
import { loginRateLimiter, bootstrapRateLimiter, AuthRateLimiter } from '../middleware/rateLimiter';

const router = Router();
let prisma = new PrismaClient();

export function setAuthPrismaClient(client: any) {
  prisma = client;
}

function getCookie(req: Request, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

async function createAuthSession(
  user: { id: string; email: string; role: string; tenantId: string },
  res: Response
) {
  let sessionId: string | undefined;
  if ((prisma as any).userSession) {
    try {
      const session = await (prisma as any).userSession.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          state: 'ACTIVE',
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days session validity
        },
      });
      sessionId = session.id;
    } catch (err) {
      console.warn('[Auth] Unable to create userSession record, falling back to stateless token:', err);
    }
  }

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      ...(sessionId ? { sessionId } : {}),
    },
    config.JWT_SECRET,
    { expiresIn: '15m' }
  );

  const refreshToken = jwt.sign(
    {
      id: user.id,
      ...(sessionId ? { sessionId } : {}),
      type: 'refresh',
    },
    config.JWT_SECRET,
    { expiresIn: '7d' }
  );

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return { token, refreshToken, sessionId };
}

/**
 * Minimal unauthenticated bootstrap status check for frontend router.
 * Strictly returns { isBootstrapped: boolean } without leaking internal stats.
 */
router.get('/bootstrap/status', async (_req: Request, res: Response) => {
  try {
    let isBootstrapped = false;
    if (typeof (prisma as any).applianceState?.findUnique === 'function') {
      const state = await (prisma as any).applianceState.findUnique({
        where: { id: 'SINGLETON' },
      });
      if (state) {
        isBootstrapped = state.isBootstrapped;
      }
    }

    if (!isBootstrapped && typeof prisma.user?.count === 'function') {
      const count = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
      isBootstrapped = count > 0;
    }

    return res.status(200).json({ isBootstrapped });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to query bootstrap status' });
  }
});

/**
 * Bootstrap endpoint for initial appliance deployment.
 * Automatically provisions Tenant, Site, Super Admin, and signs an evaluation Enterprise license.
 * Enforces atomic one-time lifecycle with PostgreSQL transactional advisory lock and ApplianceState singleton.
 * Permanently returns 410 Gone once initialized.
 */
router.post('/bootstrap', bootstrapRateLimiter, async (req: Request, res: Response) => {
  const setupHeader = req.headers['x-setup-token'];
  if (!setupHeader || setupHeader !== config.SETUP_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid setup token' });
  }

  const { tenantName, adminEmail, adminPassword, adminName, siteTimezone } = req.body;

  if (!tenantName || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: 'tenantName, adminEmail, and adminPassword are required' });
  }

  try {
    // Wrap entire bootstrap execution in an interactive transaction with PostgreSQL advisory lock
    const result = await prisma.$transaction(async (tx) => {
      // 1. Acquire transactional advisory lock to eliminate concurrent bootstrap race conditions
      if (typeof (tx as any).$executeRawUnsafe === 'function') {
        try {
          await (tx as any).$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('vigilone_bootstrap_lock'))`);
        } catch {}
      }

      // 2. Check durable ApplianceState singleton
      if (typeof (tx as any).applianceState?.findUnique === 'function') {
        const state = await (tx as any).applianceState.findUnique({
          where: { id: 'SINGLETON' },
        });
        if (state?.isBootstrapped) {
          const err: any = new Error('Appliance already initialized. Bootstrap is permanently disabled.');
          err.statusCode = 410;
          err.code = 'BOOTSTRAP_ALREADY_COMPLETED';
          throw err;
        }
      }

      // Also verify SUPER_ADMIN count as defense-in-depth
      const superAdminCount = await tx.user.count({ where: { role: 'SUPER_ADMIN' } });
      if (superAdminCount > 0) {
        const err: any = new Error('Appliance already initialized. Bootstrap is permanently disabled.');
        err.statusCode = 410;
        err.code = 'BOOTSTRAP_ALREADY_COMPLETED';
        throw err;
      }

      const existing = await tx.user.findUnique({ where: { email: adminEmail } });
      if (existing) {
        const err: any = new Error('User with this email already exists');
        err.statusCode = 400;
        throw err;
      }

      const tenantSlug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName,
          slug: `${tenantSlug}-${Date.now()}`,
          sites: {
            create: {
              name: 'Primary Site',
              timezone: siteTimezone || 'Asia/Kolkata',
            },
          },
        },
        include: { sites: true },
      });

      // Automatically mint an initial evaluation Enterprise License (16 cameras)
      const now = new Date();
      const evaluationClaims: LicenseClaims = {
        licenseId: `lic_eval_${Date.now()}`,
        tenantId: tenant.id,
        tier: 'ENTERPRISE',
        maxCameras: 16,
        features: ['EVIDENCE_EXPORT', 'ADVANCED_PTZ', 'MULTI_SITE', 'ANPR', 'AUDIT_INTEGRITY'],
        issuedAt: now.toISOString(),
        expiresAt: null, // Perpetual evaluation on appliance
      };

      const licenseArtifact = signLicensePayload(evaluationClaims);

      await tx.license.create({
        data: {
          tenantId: tenant.id,
          licenseId: evaluationClaims.licenseId,
          tier: LicenseTier.ENTERPRISE,
          maxCameras: 16,
          features: evaluationClaims.features,
          signedPayload: licenseArtifact.signedPayload,
          signatureEd25519: licenseArtifact.signatureEd25519,
        },
      });

      const passwordHash = await bcrypt.hash(adminPassword, 12);
      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          passwordHash,
          name: adminName || 'System Admin',
          role: 'SUPER_ADMIN',
          active: true,
        },
      });

      // Mark appliance as durably initialized
      if (typeof (tx as any).applianceState?.upsert === 'function') {
        try {
          await (tx as any).applianceState.upsert({
            where: { id: 'SINGLETON' },
            create: {
              id: 'SINGLETON',
              isBootstrapped: true,
              bootstrappedAt: now,
              initializationVersion: '1.0.0',
            },
            update: {
              isBootstrapped: true,
              bootstrappedAt: now,
            },
          });
        } catch {}
      }

      return { tenant, user };
    });

    // Record bootstrap audit event
    try {
      await AuditChainService.record(prisma, {
        tenantId: result.tenant.id,
        userId: result.user.id,
        action: 'SYSTEM_BOOTSTRAP',
        resourceType: 'Tenant',
        resourceId: result.tenant.id,
        ipAddress: req.ip || '127.0.0.1',
        userAgent: req.headers['user-agent'],
        metadata: { adminEmail: result.user.email, tenantName: result.tenant.name },
      });
    } catch {}

    const { token, refreshToken } = await createAuthSession(
      { id: result.user.id, email: result.user.email, role: result.user.role, tenantId: result.tenant.id },
      res
    );

    return res.status(201).json({
      message: 'Appliance bootstrapped successfully with Enterprise evaluation license',
      tenant: { id: result.tenant.id, name: result.tenant.name },
      site: result.tenant.sites[0],
      user: { id: result.user.id, email: result.user.email, role: result.user.role, name: result.user.name },
      token,
      refreshToken,
    });
  } catch (err: any) {
    if (err.statusCode === 410 || err.code === 'BOOTSTRAP_ALREADY_COMPLETED') {
      return res.status(410).json({
        error: 'Appliance already initialized. Bootstrap is permanently disabled.',
        code: 'BOOTSTRAP_ALREADY_COMPLETED',
      });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: `Bootstrap failed: ${err.message}` });
  }
});

/**
 * Operator login endpoint
 */
router.post('/login', loginRateLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const clientIp = AuthRateLimiter.getClientIp(req);

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { tenant: true },
    });

    // Uniform anti-enumeration response:
    // If user does not exist, account is inactive, or password does not match, return identical 401.
    let passwordMatches = false;
    if (user && user.active) {
      passwordMatches = await bcrypt.compare(password, user.passwordHash);
    } else {
      // Constant-time dummy comparison to prevent response timing analysis
      await bcrypt.compare(password, '$2a$12$e80yqVbB7f45bZkJbC1U5.YpUf71y4Zq/qM1sL2e8pP5dO4tF4z1e');
    }

    if (!user || !user.active || !passwordMatches) {
      AuthRateLimiter.recordFailedLogin(clientIp, email);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Clear failed attempt tracking upon successful authentication
    AuthRateLimiter.recordSuccessfulLogin(clientIp, email);

    const { token, refreshToken } = await createAuthSession(
      { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId },
      res
    );

    // Record login audit event
    await AuditChainService.record(prisma, {
      tenantId: user.tenantId,
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
    });

    return res.json({
      token,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: user.tenant.name,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Login error: ${err.message}` });
  }
});

/**
 * Refresh access token using HttpOnly cookie or body refreshToken.
 * Validates against server-side user session and active status.
 */
router.post('/refresh', async (req: Request, res: Response) => {
  const cookieToken = getCookie(req, 'refreshToken');
  const refreshToken = cookieToken || req.body?.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Unauthorized: Missing refresh token' });
  }

  try {
    const decoded = jwt.verify(refreshToken, config.JWT_SECRET) as any;
    if (decoded.type !== 'refresh' || !decoded.id) {
      return res.status(401).json({ error: 'Unauthorized: Invalid refresh token claims' });
    }

    // Verify user exists and is active
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      include: { tenant: true },
    });

    if (!user || !user.active) {
      return res.status(401).json({
        error: 'Unauthorized: Account is deactivated or invalid',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }

    // If session ID was attached, verify session is active
    if (decoded.sessionId && (prisma as any).userSession) {
      const session = await (prisma as any).userSession.findUnique({
        where: { id: decoded.sessionId },
      });

      if (
        !session ||
        session.state !== 'ACTIVE' ||
        session.revokedAt ||
        (session.expiresAt && session.expiresAt < new Date())
      ) {
        return res.status(401).json({
          error: 'Unauthorized: Session revoked or expired',
          code: 'SESSION_REVOKED',
        });
      }

      // Update session activity
      (prisma as any).userSession
        .update({
          where: { id: decoded.sessionId },
          data: { lastActivityAt: new Date() },
        })
        .catch(() => {});
    }

    // Mint fresh 15m access token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        ...(decoded.sessionId ? { sessionId: decoded.sessionId } : {}),
      },
      config.JWT_SECRET,
      { expiresIn: '15m' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: user.tenant.name,
      },
    });
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Refresh token expired or invalid' });
  }
});

/**
 * Logout endpoint: revokes active session and clears HttpOnly refresh cookie.
 */
router.post('/logout', async (req: Request, res: Response) => {
  try {
    const cookieToken = getCookie(req, 'refreshToken');
    const refreshToken = cookieToken || req.body?.refreshToken;
    let sessionId: string | undefined;

    if (refreshToken) {
      try {
        const decoded = jwt.verify(refreshToken, config.JWT_SECRET) as any;
        sessionId = decoded.sessionId;
      } catch {}
    }

    const authHeader = req.headers.authorization;
    if (!sessionId && authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], config.JWT_SECRET) as any;
        sessionId = decoded.sessionId;
      } catch {}
    }

    if (sessionId && (prisma as any).userSession) {
      await (prisma as any).userSession.updateMany({
        where: { id: sessionId },
        data: {
          state: 'REVOKED',
          revokedAt: new Date(),
        },
      });
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
    });

    return res.json({ message: 'Logged out successfully' });
  } catch (err: any) {
    return res.status(500).json({ error: `Logout failed: ${err.message}` });
  }
});

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: { tenant: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    return res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantName: user.tenant.name,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
