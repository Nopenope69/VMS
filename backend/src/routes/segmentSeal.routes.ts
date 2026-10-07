import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { SegmentSealer } from '../services/recording/catalog/segmentSeal';

/**
 * Segment seals (feature FOOTAGE_SEALING, ADR 0018). Read-only: walks a camera's seal chain and reports links, gaps,
 * signatures, stored hashes and the last audit-chain anchor. Needs CAMERA_VIEW; a camera of another tenant is not found.
 */
const router = Router();
router.use(requireAuth);

router.get('/cameras/:cameraId/verify', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const camera = await prisma.camera.findFirst({ where: { id: req.params.cameraId, tenantId: req.user!.tenantId }, select: { id: true } });
    if (!camera) return res.status(404).json({ error: 'Camera not found', code: 'CAMERA_NOT_FOUND' });
    const report = await new SegmentSealer(prisma).verifyCameraChain(camera.id);
    return res.json({ report });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
