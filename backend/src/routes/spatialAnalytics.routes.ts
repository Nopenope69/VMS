import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';

const router = Router();

/**
 * GET /api/v1/spatial-rules/:cameraId
 * List spatial rules (Tripwires & Loitering zones) for a camera
 */
router.get(
  '/:cameraId',
  requireAuth,
  authorize(Permission.SPATIAL_RULES_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const rules = await prisma.spatialAnalyticsRule.findMany({
        where: { cameraId: req.params.cameraId, tenantId },
      });
      res.json({ rules });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/spatial-rules
 * Create or update a spatial analytics rule
 */
router.post(
  '/',
  requireAuth,
  authorize(Permission.SPATIAL_RULES_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const {
        cameraId,
        name,
        type,
        direction,
        lineCoordinates,
        polygonCoordinates,
        dwellThresholdSeconds,
        cooldownSeconds,
        enabled,
      } = req.body;

      if (!cameraId || !name || !type) {
        res.status(400).json({ error: 'cameraId, name, and type are required' });
        return;
      }

      const rule = await prisma.spatialAnalyticsRule.create({
        data: {
          tenantId,
          cameraId,
          name,
          type,
          direction: direction || 'BIDIRECTIONAL',
          lineCoordinatesJson: lineCoordinates || null,
          polygonCoordinatesJson: polygonCoordinates || null,
          dwellThresholdSeconds: dwellThresholdSeconds ? Number(dwellThresholdSeconds) : 30,
          cooldownSeconds: cooldownSeconds ? Number(cooldownSeconds) : 10,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
        },
      });

      res.status(201).json({ rule });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * DELETE /api/v1/spatial-rules/:id
 * Delete a spatial analytics rule
 */
router.delete(
  '/:id',
  requireAuth,
  authorize(Permission.SPATIAL_RULES_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      await prisma.spatialAnalyticsRule.deleteMany({
        where: { id: req.params.id, tenantId },
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default router;
