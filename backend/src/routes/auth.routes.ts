import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient, LicenseTier } from '@prisma/client';
import config from '../config/env';
import { requireAuth } from '../middleware/auth';
import { signLicensePayload, LicenseClaims } from '../utils/license';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();

/**
 * Bootstrap endpoint for initial appliance deployment.
 * Automatically provisions Tenant, Site, Super Admin, and signs an evaluation Enterprise license.
 */
router.post('/bootstrap', async (req: Request, res: Response) => {
  const setupHeader = req.headers['x-setup-token'];
  if (!setupHeader || setupHeader !== config.SETUP_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid setup token' });
  }

  const { tenantName, adminEmail, adminPassword, adminName } = req.body;

  if (!tenantName || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: 'tenantName, adminEmail, and adminPassword are required' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    const tenantSlug = tenantName.toLowerCase().replace(/[^a-z0-9]/g, '-');
    const tenant = await prisma.tenant.create({
      data: {
        name: tenantName,
        slug: `${tenantSlug}-${Date.now()}`,
        sites: {
          create: {
            name: 'Primary Site',
            timezone: 'Asia/Kolkata',
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

    await prisma.license.create({
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
    const user = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        email: adminEmail,
        passwordHash,
        name: adminName || 'System Admin',
        role: 'SUPER_ADMIN',
        active: true,
      },
    });

    // Record bootstrap audit event
    await AuditChainService.record(prisma, {
      tenantId: tenant.id,
      userId: user.id,
      action: 'SYSTEM_BOOTSTRAP',
      resourceType: 'Tenant',
      resourceId: tenant.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { adminEmail: user.email, tenantName: tenant.name },
    });

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: tenant.id,
      },
      config.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: 'Appliance bootstrapped successfully with Enterprise evaluation license',
      tenant: { id: tenant.id, name: tenant.name },
      site: tenant.sites[0],
      user: { id: user.id, email: user.email, role: user.role, name: user.name },
      token,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Bootstrap failed: ${err.message}` });
  }
});

/**
 * Operator login endpoint
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: { tenant: true },
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.active) {
      return res.status(403).json({
        error: 'Account has been deactivated. Please contact your security administrator.',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
      },
      config.JWT_SECRET,
      { expiresIn: '7d' }
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
