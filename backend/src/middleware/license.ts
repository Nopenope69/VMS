import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { verifyLicenseArtifact, isLicenseActive, LicenseClaims } from '../utils/license';

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      licenseClaims?: LicenseClaims;
      isLicenseExpired?: boolean;
    }
  }
}

/**
 * Loads tenant license from the database and derives validity from the signed artifact.
 * INVARIANT: This middleware MUST NEVER be mounted in front of /api/v1/media/auth.
 * Surveillance continuity dictates that live view and recording must never depend on license checks.
 */
export async function loadTenantLicense(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = (req as any).user?.tenantId;
  if (!tenantId) {
    next();
    return;
  }

  try {
    const licenseRecord = await prisma.license.findFirst({
      where: { tenantId },
      orderBy: { appliedAt: 'desc' },
    });

    if (!licenseRecord) {
      req.licenseClaims = undefined;
      req.isLicenseExpired = false;
      next();
      return;
    }

    // Cryptographic verification against root vendor Ed25519 key
    const verification = verifyLicenseArtifact(
      licenseRecord.signedPayload,
      licenseRecord.signatureEd25519
    );

    if (!verification.valid || !verification.claims) {
      console.warn(`[Licensing] Invalid cryptographic license artifact for tenant ${tenantId}: ${verification.error}`);
      req.licenseClaims = undefined;
      req.isLicenseExpired = false;
      next();
      return;
    }

    req.licenseClaims = verification.claims;
    const activeCheck = isLicenseActive(verification.claims);
    req.isLicenseExpired = !activeCheck.active;

    next();
  } catch (err) {
    console.error('[Licensing] Error evaluating tenant license:', err);
    next();
  }
}

/**
 * Enforces the commercial license matrix on new camera onboarding.
 * Live view and existing recordings are never blocked.
 */
export async function enforceCameraQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
  const tenantId = (req as any).user?.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: 'Unauthorized: Missing tenant context' });
    return;
  }

  const claims = req.licenseClaims;

  // 1. Check for missing or invalid license
  if (!claims) {
    res.status(402).json({
      error: 'License Required: No valid signed commercial license found for this tenant.',
      code: 'LICENSE_MISSING',
      matrixStatus: 'NEW_CAMERAS_BLOCKED_LIVE_VIEW_CONTINUES',
    });
    return;
  }

  // 2. Check for expired license
  if (req.isLicenseExpired) {
    res.status(402).json({
      error: `License Expired: Your ${claims.tier} license expired on ${claims.expiresAt}. Live view and existing recording remain active, but new camera onboarding is blocked.`,
      code: 'LICENSE_EXPIRED',
      expiresAt: claims.expiresAt,
      matrixStatus: 'NEW_CAMERAS_BLOCKED_LIVE_VIEW_CONTINUES',
    });
    return;
  }

  // 3. Check camera capacity quota
  const currentCount = await prisma.camera.count({
    where: { tenantId },
  });

  if (currentCount >= claims.maxCameras) {
    res.status(402).json({
      error: `Camera Quota Reached: Your current ${claims.tier} license allows up to ${claims.maxCameras} cameras (currently using ${currentCount}). Please upgrade license to onboard additional cameras.`,
      code: 'QUOTA_EXCEEDED',
      currentCount,
      maxCameras: claims.maxCameras,
      tier: claims.tier,
    });
    return;
  }

  next();
}

/**
 * Gating middleware for optional enterprise features (ANPR, MULTI_SITE, ADVANCED_PTZ, EVIDENCE_EXPORT).
 */
export function requireFeature(featureName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const claims = req.licenseClaims;
    if (!claims) {
      res.status(402).json({
        error: `Feature '${featureName}' requires a valid commercial license.`,
        code: 'LICENSE_MISSING',
      });
      return;
    }

    if (req.isLicenseExpired) {
      res.status(402).json({
        error: `Feature '${featureName}' is unavailable because your commercial license is expired.`,
        code: 'LICENSE_EXPIRED',
      });
      return;
    }

    if (!claims.features.includes(featureName)) {
      res.status(403).json({
        error: `Feature '${featureName}' is not entitled under your ${claims.tier} license.`,
        code: 'FEATURE_NOT_ENTITLED',
        tier: claims.tier,
        entitledFeatures: claims.features,
      });
      return;
    }

    next();
  };
}
