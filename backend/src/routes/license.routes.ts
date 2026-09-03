import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { verifyLicenseArtifact, isLicenseActive } from '../utils/license';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);

// Inspect current tenant license entitlements
router.get('/', async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;

    const license = await prisma.license.findFirst({
      where: { tenantId },
      orderBy: { appliedAt: 'desc' },
    });

    const cameraCount = await prisma.camera.count({
      where: { tenantId },
    });

    if (!license) {
      res.json({
        hasLicense: false,
        status: 'UNLICENSED',
        cameraCount,
        maxCameras: 0,
        tier: 'NONE',
        features: [],
      });
      return;
    }

    const verification = verifyLicenseArtifact(license.signedPayload, license.signatureEd25519);
    if (!verification.valid || !verification.claims) {
      res.json({
        hasLicense: false,
        status: 'INVALID_SIGNATURE',
        cameraCount,
        error: verification.error,
      });
      return;
    }

    const activeCheck = isLicenseActive(verification.claims);

    res.json({
      hasLicense: true,
      status: activeCheck.active ? 'ACTIVE' : 'EXPIRED',
      claims: verification.claims,
      cameraCount,
      maxCameras: verification.claims.maxCameras,
      tier: verification.claims.tier,
      features: verification.claims.features,
      expiresAt: verification.claims.expiresAt,
      appliedAt: license.appliedAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Apply new signed license artifact
const applyLicenseSchema = z.object({
  signedPayload: z.string().min(10),
  signatureEd25519: z.string().min(64),
});

router.post('/apply', authorize(Permission.LICENSE_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const userId = (req as any).user.id;
    const { signedPayload, signatureEd25519 } = applyLicenseSchema.parse(req.body);

    // Cryptographically verify the artifact offline against root vendor Ed25519 public key
    const verification = verifyLicenseArtifact(signedPayload, signatureEd25519);
    if (!verification.valid || !verification.claims) {
      res.status(400).json({
        error: `Invalid license artifact: ${verification.error}`,
        code: 'CRYPTOGRAPHIC_VERIFICATION_FAILED',
      });
      return;
    }

    const claims = verification.claims;

    // Verify tenant match if tenantId is specified in license
    if (claims.tenantId !== tenantId && claims.tenantId !== 'default-facility') {
      res.status(400).json({
        error: `License tenant mismatch: this artifact is issued for '${claims.tenantId}', but your current tenant is '${tenantId}'.`,
      });
      return;
    }

    // Save verified license
    const newLicense = await prisma.license.create({
      data: {
        tenantId,
        licenseId: claims.licenseId,
        tier: claims.tier,
        maxCameras: claims.maxCameras,
        features: claims.features,
        expiresAt: claims.expiresAt ? new Date(claims.expiresAt) : null,
        signedPayload,
        signatureEd25519,
        installationId: claims.installationId,
        deviceBinding: claims.deviceBinding,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId,
      action: 'LICENSE_APPLY',
      resourceType: 'License',
      resourceId: newLicense.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: {
        licenseId: claims.licenseId,
        tier: claims.tier,
        maxCameras: claims.maxCameras,
        features: claims.features,
      },
    });

    res.status(201).json({
      success: true,
      license: newLicense,
      claims,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
