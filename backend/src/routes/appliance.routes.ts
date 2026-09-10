import { Router, Request, Response } from "express";
import path from "path";
import os from "os";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { ApplianceService } from "../services/system/appliance.service";

const router = Router();
const prisma = new PrismaClient();
const applianceService = new ApplianceService(prisma);

/**
 * GET /api/v1/system/appliance/identity
 * Authenticated appliance identification
 */
router.get("/identity", requireAuth, async (req: Request, res: Response) => {
  try {
    const identity = await applianceService.getApplianceIdentity();
    return res.status(200).json(identity);
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to retrieve appliance identity: ${err.message}` });
  }
});

/**
 * GET /api/v1/system/appliance/vitals
 * Authenticated host telemetry, storage, and container diagnostics
 */
router.get("/vitals", requireAuth, async (req: Request, res: Response) => {
  try {
    const vitals = await applianceService.getSystemVitals();
    return res.status(200).json(vitals);
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to retrieve system vitals: ${err.message}` });
  }
});

/**
 * GET /api/v1/system/appliance/support-bundle
 * Authenticated generation and streaming of sanitized diagnostics archive
 */
router.get("/support-bundle", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user || (user.role !== "SUPER_ADMIN" && user.role !== "TENANT_ADMIN")) {
    return res.status(403).json({ error: "Forbidden: Support bundle export requires administrative privilege." });
  }

  const bundleFilename = `vigilone-support-${Date.now()}.tar.gz`;
  const tempBundlePath = path.join(os.tmpdir(), bundleFilename);

  try {
    await applianceService.generateSupportBundle(tempBundlePath);

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", `attachment; filename="${bundleFilename}"`);

    const fileStream = fs.createReadStream(tempBundlePath);
    fileStream.pipe(res);

    fileStream.on("end", () => {
      try {
        fs.unlinkSync(tempBundlePath);
      } catch {}
    });

    fileStream.on("error", () => {
      try {
        fs.unlinkSync(tempBundlePath);
      } catch {}
    });
  } catch (err: any) {
    try {
      if (fs.existsSync(tempBundlePath)) fs.unlinkSync(tempBundlePath);
    } catch {}
    return res.status(500).json({ error: `Failed to generate support bundle: ${err.message}` });
  }
});

export default router;
