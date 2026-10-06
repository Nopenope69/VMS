import { Router, Request, Response } from 'express';
import { TripwireDirection } from '@prisma/client';
import { z } from 'zod';
import { UnattendedObjectParams, WrongWayParams, PersonDownParams, FenceClimbParams } from '../services/spatial/threatRuleParams';
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

const Pt = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict();
const Polygon = z.array(Pt).min(3).max(32);
const Line = z.tuple([Pt, Pt]).refine(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y) >= 0.01, 'the two points must be apart');
const common = {
  cameraId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  cooldownSeconds: z.coerce.number().int().min(1).max(86400).optional(),
  enabled: z.boolean().optional(),
};

/** The rule body per type. Coordinates are normalised to the camera image (0..1). */
export const SpatialRuleBody = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('TRIPWIRE'), direction: z.nativeEnum(TripwireDirection).optional(), lineCoordinates: Line }).strict(),
  z.object({ ...common, type: z.literal('LOITERING'), polygonCoordinates: Polygon, dwellThresholdSeconds: z.coerce.number().int().min(1).max(86400).optional() }).strict(),
  z
    .object({
      ...common,
      type: z.literal('UNATTENDED_OBJECT'),
      polygonCoordinates: Polygon,
      /** How long a bag must lie there with nobody near it. */
      dwellThresholdSeconds: z.coerce.number().int().min(10).max(86400).optional(),
      params: UnattendedObjectParams.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('WRONG_WAY'),
      polygonCoordinates: Polygon,
      /** The allowed direction: an arrow from the first point to the second. */
      lineCoordinates: Line,
      params: WrongWayParams.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('PERSON_DOWN'),
      /** Where a person going down matters. Leave out places where lying is normal. */
      polygonCoordinates: Polygon,
      /** How long a person who fell must stay down before the alarm. */
      dwellThresholdSeconds: z.coerce.number().int().min(3).max(3600).optional(),
      params: PersonDownParams.optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      type: z.literal('FENCE_CLIMB'),
      /** The area around the fence the rule applies to. */
      polygonCoordinates: Polygon,
      /** The fence base on the ground. The fence top and the protected side are in `params`. */
      lineCoordinates: Line,
      params: FenceClimbParams,
    })
    .strict(),
]);

/**
 * POST /api/v1/spatial-rules
 * Create a spatial analytics rule: TRIPWIRE, LOITERING, UNATTENDED_OBJECT, WRONG_WAY, PERSON_DOWN or FENCE_CLIMB.
 */
router.post(
  '/',
  requireAuth,
  authorize(Permission.SPATIAL_RULES_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const p = SpatialRuleBody.safeParse(req.body);
      if (!p.success) {
        res.status(400).json({ error: 'INVALID_SPATIAL_RULE', details: p.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) });
        return;
      }
      const b = p.data;
      const camera = await prisma.camera.findFirst({ where: { id: b.cameraId, tenantId }, select: { id: true } });
      if (!camera) {
        res.status(404).json({ error: 'CAMERA_NOT_FOUND' });
        return;
      }
      const defaults = { TRIPWIRE: { cooldown: 10, dwell: 30 }, LOITERING: { cooldown: 30, dwell: 30 }, UNATTENDED_OBJECT: { cooldown: 300, dwell: 60 }, WRONG_WAY: { cooldown: 10, dwell: 30 }, PERSON_DOWN: { cooldown: 120, dwell: 10 }, FENCE_CLIMB: { cooldown: 60, dwell: 30 } }[b.type];

      const rule = await prisma.spatialAnalyticsRule.create({
        data: {
          tenantId,
          cameraId: b.cameraId,
          name: b.name,
          type: b.type,
          direction: b.type === 'TRIPWIRE' && b.direction ? b.direction : 'BIDIRECTIONAL',
          lineCoordinatesJson: 'lineCoordinates' in b ? (b.lineCoordinates as any) : undefined,
          polygonCoordinatesJson: 'polygonCoordinates' in b ? (b.polygonCoordinates as any) : undefined,
          dwellThresholdSeconds: 'dwellThresholdSeconds' in b && b.dwellThresholdSeconds ? b.dwellThresholdSeconds : defaults.dwell,
          paramsJson: 'params' in b && b.params ? (b.params as any) : undefined,
          cooldownSeconds: b.cooldownSeconds ?? defaults.cooldown,
          enabled: b.enabled ?? true,
        },
      });

      res.status(201).json({ rule });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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
