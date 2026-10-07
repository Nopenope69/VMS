import { Router, Request, Response } from 'express';
import { SegmentStatus } from '@prisma/client';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { FeatureFlag, isFeatureEnabled } from '../config/featureFlags';
import { INTEGRITY_FAILURE_REASONS } from '../services/recording/catalog/segmentRepository';
import { SABOTAGE_TITLES } from '../services/camera/cameraSabotage';

/**
 * Footage integrity overview, one row per camera of the caller's tenant (ADR 0019): camera-sabotage conditions (open
 * and recent), segment seals (ADR 0018) and recordings held by an integrity finding (audit F13). Reads only. Each part
 * says whether its feature is on; the page shows the switch to set when it is off. The chain itself is checked per
 * camera by `GET /api/v1/segment-seals/cameras/:cameraId/verify`.
 */
const router = Router();
router.use(requireAuth);

const RECENT_DAYS = 7;
const RECENT_PER_CAMERA = 10;

router.get('/cameras', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const sabotageEnabled = isFeatureEnabled(FeatureFlag.CAMERA_SABOTAGE);
    const sealingEnabled = isFeatureEnabled(FeatureFlag.FOOTAGE_SEALING);
    const cameras = await prisma.camera.findMany({ where: { tenantId }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    const ids = cameras.map((c) => c.id);
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);

    const [conditions, seals, held] = await Promise.all([
      prisma.cameraSabotageCondition.findMany({
        where: { tenantId, cameraId: { in: ids }, OR: [{ clearedAt: null }, { confirmedAt: { gte: since } }] },
        orderBy: { confirmedAt: 'desc' },
        take: 1000,
      }),
      prisma.segmentSeal.groupBy({ by: ['cameraId'], where: { cameraId: { in: ids } }, _count: { _all: true }, _max: { sealedAt: true } }),
      prisma.recordingSegment.groupBy({
        by: ['cameraId'],
        where: { cameraId: { in: ids }, status: SegmentStatus.CORRUPTED, quarantineReason: { in: INTEGRITY_FAILURE_REASONS } },
        _count: { _all: true },
      }),
    ]);

    const sealsBy = new Map(seals.map((s) => [s.cameraId, s]));
    const heldBy = new Map(held.map((h) => [h.cameraId, h._count._all]));
    const view = (c: (typeof conditions)[number]) => ({
      id: c.id,
      changeType: c.changeType,
      title: SABOTAGE_TITLES[c.changeType as keyof typeof SABOTAGE_TITLES] ?? c.changeType,
      startedAt: c.startedAt.toISOString(),
      confirmedAt: c.confirmedAt.toISOString(),
      clearedAt: c.clearedAt?.toISOString() ?? null,
      clearReason: c.clearReason,
      score: c.score,
      method: c.method,
      measurements: c.measurementsJson,
      eventId: c.eventId,
    });

    return res.json({
      features: { cameraSabotage: sabotageEnabled, footageSealing: sealingEnabled },
      recentDays: RECENT_DAYS,
      cameras: cameras.map((cam) => {
        const mine = conditions.filter((c) => c.cameraId === cam.id);
        const s = sealsBy.get(cam.id);
        return {
          cameraId: cam.id,
          name: cam.name,
          sabotage: {
            open: mine.filter((c) => !c.clearedAt).map(view),
            recent: mine.filter((c) => c.clearedAt).slice(0, RECENT_PER_CAMERA).map(view),
          },
          seals: { count: s?._count._all ?? 0, lastSealedAt: s?._max.sealedAt?.toISOString() ?? null },
          heldSegments: heldBy.get(cam.id) ?? 0,
        };
      }),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
