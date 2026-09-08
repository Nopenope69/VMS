import { Router, Request, Response } from 'express';
import { PrismaClient, NotificationChannelType, EventSeverity } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import NotificationDispatcherService from '../services/notification/notificationDispatcher.service';

const router = Router();
const prisma = new PrismaClient();
const dispatcher = new NotificationDispatcherService(prisma);

// Queue worker managed by server lifecycle (server.ts)

router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('NOTIFICATIONS'));

/**
 * List notification channels for tenant
 */
router.get('/channels', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;

  try {
    const channels = await prisma.notificationChannel.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ channels });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Create a new notification channel
 */
router.post('/channels', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const {
    name,
    type = NotificationChannelType.WEBHOOK,
    targetUrl,
    secretToken,
    configJson,
    minSeverity = EventSeverity.WARNING,
    enabled = true,
  } = req.body;

  if (!name || !targetUrl) {
    return res.status(400).json({ error: 'name and targetUrl are required' });
  }

  try {
    const channel = await prisma.notificationChannel.create({
      data: {
        tenantId,
        name,
        type,
        targetUrl,
        secretToken,
        configJson,
        minSeverity,
        enabled,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'NOTIFICATION_CHANNEL_CREATE',
      resourceType: 'NotificationChannel',
      resourceId: channel.id,
      ipAddress: req.ip || '127.0.0.1',
      metadata: { name, type, targetUrl },
    });

    return res.json({ success: true, channel });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Delete a notification channel
 */
router.delete('/channels/:id', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { id } = req.params;

  try {
    const channel = await prisma.notificationChannel.findUnique({ where: { id } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    assertTenantBoundary(channel.tenantId, tenantId);

    await prisma.notificationChannel.delete({ where: { id } });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'NOTIFICATION_CHANNEL_DELETE',
      resourceType: 'NotificationChannel',
      resourceId: id,
      ipAddress: req.ip || '127.0.0.1',
      metadata: { name: channel.name, type: channel.type },
    });

    return res.json({ success: true, message: 'Notification channel removed' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Test notification ping to channel
 */
router.post('/channels/:id/test', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { id } = req.params;

  try {
    const channel = await prisma.notificationChannel.findUnique({ where: { id } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    assertTenantBoundary(channel.tenantId, tenantId);

    const testPayload = {
      event: 'TEST_NOTIFICATION_PING',
      alarm: {
        id: `test_alarm_${Date.now()}`,
        title: 'VigilOne Test Alert Notification',
        description: 'Verification ping confirming end-to-end webhook delivery.',
        severity: EventSeverity.INFO,
        camera: 'Test Ingest Camera',
        triggeredAt: new Date().toISOString(),
      },
      tenantId,
      timestamp: new Date().toISOString(),
    };

    const startTime = Date.now();
    const result = await dispatcher.dispatchToAdapter(channel, testPayload);
    const latencyMs = Date.now() - startTime;

    return res.json({
      success: result.success,
      statusCode: result.statusCode,
      latencyMs,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * List recent notification logs
 */
router.get('/logs', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;

  try {
    const logs = await prisma.notificationLog.findMany({
      where: { tenantId },
      include: {
        channel: { select: { id: true, name: true, type: true } },
      },
      orderBy: { dispatchedAt: 'desc' },
      take: 50,
    });

    return res.json({ logs });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export { dispatcher };
export default router;
