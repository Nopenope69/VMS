import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { NotificationChannelType, EventSeverity } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import { notificationDispatcher as dispatcher } from '../composition';
import {
  prepareChannelConfig,
  redactChannel,
  resolveChannelConfig,
  validateTargets,
  ChannelConfigError,
} from '../services/notification/channels/channelConfig';
import { verifyWebhookSignature, parseStatusCallback } from '../services/notification/channels/whatsappCloud';
import { MetricsService } from '../services/observability/metrics.service';
import crypto from 'crypto';

const router = Router();

// Queue worker managed by server lifecycle (server.ts)


/**
 * WhatsApp delivery-status webhook (P3.3). Public by necessity (Meta calls it), so it is
 * authenticated per channel: GET must echo the channel's verifyToken, POST must carry a valid
 * X-Hub-Signature-256 over the raw body with the channel's appSecret. A channel without those
 * secrets refuses both (fail closed).
 */
async function whatsappChannel(id: string) {
  const channel = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!channel || channel.type !== NotificationChannelType.WHATSAPP) return null;
  return { channel, cfg: resolveChannelConfig(channel.type, channel.configJson) };
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

router.get('/whatsapp/webhook/:channelId', async (req: Request, res: Response) => {
  try {
    const found = await whatsappChannel(req.params.channelId);
    if (!found) return res.status(404).json({ error: 'Channel not found' });
    if (!found.cfg.verifyToken) return res.status(403).json({ error: 'WEBHOOK_NOT_CONFIGURED: channel has no verifyToken' });
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    if (mode !== 'subscribe' || !safeEqual(token, found.cfg.verifyToken)) return res.status(403).json({ error: 'Verification failed' });
    return res.type('text/plain').send(challenge);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

const DELIVERY_ORDER: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

router.post('/whatsapp/webhook/:channelId', async (req: Request, res: Response) => {
  try {
    const found = await whatsappChannel(req.params.channelId);
    if (!found) return res.status(404).json({ error: 'Channel not found' });
    if (!found.cfg.appSecret) return res.status(403).json({ error: 'WEBHOOK_NOT_CONFIGURED: channel has no appSecret' });
    const raw: Buffer | undefined = (req as any).rawBody;
    if (!raw || !verifyWebhookSignature(raw, req.header('x-hub-signature-256'), found.cfg.appSecret)) {
      MetricsService.incCounter('vigilone_notification_receipts_total', 'Delivery receipts received', { channel_type: 'WHATSAPP', result: 'bad_signature' });
      return res.status(401).json({ error: 'Invalid signature' });
    }
    let applied = 0;
    for (const u of parseStatusCallback(req.body)) {
      const logs = await prisma.notificationLog.findMany({
        where: { channelId: found.channel.id, providerMessageId: u.providerMessageId },
      });
      for (const log of logs) {
        // Callbacks can arrive out of order: never move a receipt backwards (READ -> DELIVERED).
        if ((DELIVERY_ORDER[log.deliveryStatus || ''] || 0) >= DELIVERY_ORDER[u.status]) continue;
        await prisma.notificationLog.update({
          where: { id: log.id },
          data: { deliveryStatus: u.status, deliveryUpdatedAt: u.at, ...(u.error ? { error: u.error } : {}) },
        });
        applied++;
      }
      MetricsService.incCounter('vigilone_notification_receipts_total', 'Delivery receipts received', {
        channel_type: 'WHATSAPP',
        result: logs.length ? u.status.toLowerCase() : 'unknown_message',
      });
    }
    return res.json({ received: true, applied });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

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

    return res.json({ channels: channels.map(redactChannel) });
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
  if (!Object.values(NotificationChannelType).includes(type)) {
    return res.status(400).json({ error: `Unknown channel type ${type}` });
  }

  try {
    validateTargets(type, targetUrl);
    const storedConfig = prepareChannelConfig(type, configJson || {});
    const channel = await prisma.notificationChannel.create({
      data: {
        tenantId,
        name,
        type,
        targetUrl,
        secretToken: type === NotificationChannelType.WEBHOOK ? secretToken || null : null,
        configJson: storedConfig as any,
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

    return res.json({ success: true, channel: redactChannel(channel) });
  } catch (err: any) {
    if (err instanceof ChannelConfigError) return res.status(400).json({ error: err.message });
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Update a notification channel. Secret fields omitted from configJson keep their stored value.
 */
router.patch('/channels/:id', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  try {
    const channel = await prisma.notificationChannel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    assertTenantBoundary(channel.tenantId, tenantId);
    const { name, targetUrl, configJson, minSeverity, enabled, secretToken } = req.body || {};
    const data: any = {};
    if (name !== undefined) data.name = String(name);
    if (targetUrl !== undefined) {
      validateTargets(channel.type, targetUrl);
      data.targetUrl = targetUrl;
    }
    if (configJson !== undefined) data.configJson = prepareChannelConfig(channel.type, configJson, channel.configJson);
    if (minSeverity !== undefined) {
      if (!Object.values(EventSeverity).includes(minSeverity)) return res.status(400).json({ error: 'Invalid minSeverity' });
      data.minSeverity = minSeverity;
    }
    if (enabled !== undefined) data.enabled = !!enabled;
    if (secretToken !== undefined && channel.type === NotificationChannelType.WEBHOOK) data.secretToken = secretToken || null;
    const updated = await prisma.notificationChannel.update({ where: { id: channel.id }, data });
    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'NOTIFICATION_CHANNEL_UPDATE',
      resourceType: 'NotificationChannel',
      resourceId: channel.id,
      ipAddress: req.ip || '127.0.0.1',
      // Field names only: values may be secrets.
      metadata: { fields: Object.keys(data), configFields: configJson ? Object.keys(configJson) : [] },
    });
    return res.json({ success: true, channel: redactChannel(updated) });
  } catch (err: any) {
    if (err instanceof ChannelConfigError) return res.status(400).json({ error: err.message });
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

    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'NOTIFICATION_CHANNEL_TEST',
      resourceType: 'NotificationChannel',
      resourceId: channel.id,
      ipAddress: req.ip || '127.0.0.1',
      metadata: { type: channel.type, success: result.success, statusCode: result.statusCode ?? null },
    });

    return res.json({
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
      permanent: result.permanent ?? false,
      receipts: result.receipts || [],
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

/**
 * Dead-lettered notification jobs (P3.3): failures that exhausted retries or were permanent.
 */
router.get('/dead-letters', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  try {
    const jobs = await prisma.notificationJob.findMany({
      where: { tenantId, status: 'DEAD_LETTER' },
      select: {
        id: true,
        alarmId: true,
        attempts: true,
        maxAttempts: true,
        error: true,
        createdAt: true,
        processedAt: true,
        escalationStep: true,
        channel: { select: { id: true, name: true, type: true } },
      },
      orderBy: { processedAt: 'desc' },
      take: 100,
    });
    return res.json({ jobs });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Requeue a dead-lettered job with a fresh retry budget. Audited.
 */
router.post('/jobs/:id/retry', authorize(Permission.NOTIFICATION_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  try {
    const job = await prisma.notificationJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    assertTenantBoundary(job.tenantId, tenantId);
    if (job.status !== 'DEAD_LETTER') return res.status(409).json({ error: `Only DEAD_LETTER jobs can be retried (job is ${job.status})` });
    const updated = await prisma.notificationJob.updateMany({
      where: { id: job.id, status: 'DEAD_LETTER' },
      data: { status: 'PENDING', attempts: 0, nextRetryAt: null, processedAt: null },
    });
    if (updated.count !== 1) return res.status(409).json({ error: 'Job changed concurrently' });
    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'NOTIFICATION_JOB_RETRY',
      resourceType: 'NotificationJob',
      resourceId: job.id,
      ipAddress: req.ip || '127.0.0.1',
      metadata: { alarmId: job.alarmId, channelId: job.channelId, previousError: (job.error || '').slice(0, 300) },
    });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
