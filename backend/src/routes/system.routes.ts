import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense } from '../middleware/license';
import { authorize, Permission } from '../services/rbac/permissions';
import turnAuthService from '../services/webrtc/turnAuth.service';
import DisasterRecoveryService from '../services/system/disasterRecovery.service';

const router = Router();
const prisma = new PrismaClient();
const drService = new DisasterRecoveryService(prisma);

router.use(requireAuth);
router.use(loadTenantLicense);

/**
 * Returns dynamic STUN & Ephemeral TURN ICE configurations for WebRTC NAT/WAN traversal
 */
router.get('/webrtc-ice', authorize(Permission.CAMERA_VIEW), (req: Request, res: Response) => {
  try {
    const config = turnAuthService.generateIceServers(req.user!.id, 86400);
    return res.json(config);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Export encrypted appliance configuration backup archive
 * INVARIANT: Strictly configuration metadata (<5MB); video recordings are excluded.
 */
router.get('/backup', authorize(Permission.SYSTEM_BACKUP), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;

  try {
    const backup = await drService.exportApplianceBackup(tenantId);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vigilone-backup-${backup.applianceId}-${Date.now()}.json"`
    );
    return res.json(backup);
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Restore appliance configuration backup within transactional boundary
 */
router.post('/restore', authorize(Permission.SYSTEM_BACKUP), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const backupArchive = req.body;

  if (!backupArchive || !backupArchive.format || !backupArchive.encryptedPayload) {
    return res.status(400).json({
      error: 'Invalid backup payload: Must contain format, version, encryptedPayload, and checksumSha256',
    });
  }

  try {
    const summary = await drService.restoreApplianceBackup(
      backupArchive,
      tenantId,
      req.user!.id,
      req.ip || '127.0.0.1'
    );

    return res.json({ success: true, summary });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
