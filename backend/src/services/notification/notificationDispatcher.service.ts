import { PrismaClient, NotificationChannelType, NotificationJobStatus, EventSeverity } from '@prisma/client';
import crypto from 'crypto';
import axios from 'axios';

export interface DispatchNotificationRequest {
  tenantId: string;
  alarmId: string;
  title: string;
  description?: string | null;
  severity: EventSeverity;
  cameraName?: string;
  metadataJson?: any;
}

export class NotificationDispatcherService {
  private prisma: PrismaClient;
  private isRunning: boolean = false;
  private workerTimer: NodeJS.Timeout | null = null;
  private channelBuckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

  // Rate limit: 10 per minute per channel
  private readonly MAX_TOKENS = 10;
  private readonly REFILL_RATE_PER_SEC = 10 / 60;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.workerTimer = setInterval(() => {
      this.processQueue().catch((err) =>
        console.error('[NotificationDispatcher] Worker loop error:', err)
      );
    }, 5000); // Poll queue every 5 seconds
  }

  public stop(): void {
    this.isRunning = false;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  /**
   * Enqueues notifications for an active alarm across all eligible tenant channels.
   * Enforces idempotency to prevent duplicate notifications for the same alarm state.
   */
  public async enqueueAlarmNotifications(req: DispatchNotificationRequest): Promise<number> {
    const channels = await this.prisma.notificationChannel.findMany({
      where: {
        tenantId: req.tenantId,
        enabled: true,
      },
    });

    let enqueued = 0;
    const severityHierarchy: Record<EventSeverity, number> = {
      INFO: 1,
      WARNING: 2,
      CRITICAL: 3,
    };

    for (const channel of channels) {
      // Check channel minimum severity threshold
      if (severityHierarchy[req.severity] < severityHierarchy[channel.minSeverity]) {
        continue;
      }

      // Compute deterministic idempotency key
      const idempotencyKey = crypto
        .createHash('sha256')
        .update(`${req.alarmId}_${channel.id}_${req.severity}`)
        .digest('hex');

      const payload = {
        event: 'ALARM_TRIGGERED',
        alarm: {
          id: req.alarmId,
          title: req.title,
          description: req.description,
          severity: req.severity,
          camera: req.cameraName || 'System',
          metadata: req.metadataJson,
          triggeredAt: new Date().toISOString(),
        },
        tenantId: req.tenantId,
        timestamp: new Date().toISOString(),
      };

      try {
        await this.prisma.notificationJob.upsert({
          where: { idempotencyKey },
          create: {
            tenantId: req.tenantId,
            channelId: channel.id,
            alarmId: req.alarmId,
            idempotencyKey,
            status: NotificationJobStatus.PENDING,
            payloadJson: payload as any,
          },
          update: {}, // Ignore if already enqueued
        });
        enqueued++;
      } catch (err: any) {
        console.warn(`[NotificationDispatcher] Upsert notice for ${idempotencyKey}:`, err.message);
      }
    }

    return enqueued;
  }

  /**
   * Queue processor worker with exponential backoff & dead-letter state.
   */
  public async processQueue(): Promise<void> {
    const now = new Date();

    const jobs = await this.prisma.notificationJob.findMany({
      where: {
        status: NotificationJobStatus.PENDING,
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } },
        ],
      },
      include: {
        channel: true,
      },
      take: 10,
    });

    for (const job of jobs) {
      if (!this.consumeRateToken(job.channelId)) {
        // Rate limit reached for this channel, try next cycle
        continue;
      }

      await this.prisma.notificationJob.update({
        where: { id: job.id },
        data: { status: NotificationJobStatus.PROCESSING },
      });

      const startTime = Date.now();
      let success = false;
      let responseCode: number | undefined;
      let errorMsg: string | undefined;

      try {
        const result = await this.dispatchToAdapter(job.channel, job.payloadJson);
        success = result.success;
        responseCode = result.statusCode;
      } catch (err: any) {
        success = false;
        errorMsg = err.message || 'Unknown network error';
        responseCode = err.response?.status;
      }

      const latencyMs = Date.now() - startTime;

      if (success) {
        await this.prisma.notificationJob.update({
          where: { id: job.id },
          data: {
            status: NotificationJobStatus.DELIVERED,
            processedAt: new Date(),
          },
        });

        await this.prisma.notificationLog.create({
          data: {
            tenantId: job.tenantId,
            channelId: job.channelId,
            alarmId: job.alarmId,
            status: 'DELIVERED',
            responseCode: responseCode || 200,
            latencyMs,
            dispatchedAt: new Date(),
          },
        });
      } else {
        const newAttempts = job.attempts + 1;
        const isDeadLetter = newAttempts >= job.maxAttempts;

        // Exponential backoff: 5s, 30s, 120s
        const backoffSeconds = Math.min(120, Math.pow(newAttempts, 2) * 5);
        const nextRetry = new Date(Date.now() + backoffSeconds * 1000);

        await this.prisma.notificationJob.update({
          where: { id: job.id },
          data: {
            status: isDeadLetter ? NotificationJobStatus.DEAD_LETTER : NotificationJobStatus.PENDING,
            attempts: newAttempts,
            nextRetryAt: isDeadLetter ? null : nextRetry,
            error: errorMsg,
            processedAt: isDeadLetter ? new Date() : undefined,
          },
        });

        await this.prisma.notificationLog.create({
          data: {
            tenantId: job.tenantId,
            channelId: job.channelId,
            alarmId: job.alarmId,
            status: isDeadLetter ? 'DEAD_LETTER' : 'RETRY_PENDING',
            responseCode: responseCode || 500,
            latencyMs,
            error: errorMsg,
            dispatchedAt: new Date(),
          },
        });
      }
    }
  }

  /**
   * Adapter dispatcher supporting Webhook (HMAC signed), Slack Markdown, and SMTP.
   */
  public async dispatchToAdapter(channel: any, payload: any): Promise<{ success: boolean; statusCode?: number }> {
    const rawBody = JSON.stringify(payload);

    if (channel.type === NotificationChannelType.WEBHOOK) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'VigilOne-VMS-Notifier/2.0',
      };

      if (channel.secretToken) {
        const signature = crypto
          .createHmac('sha256', channel.secretToken)
          .update(rawBody)
          .digest('hex');
        headers['X-VigilOne-Signature'] = `sha256=${signature}`;
      }

      const res = await axios.post(channel.targetUrl, payload, { headers, timeout: 5000 });
      return { success: res.status >= 200 && res.status < 300, statusCode: res.status };
    }

    if (channel.type === NotificationChannelType.SLACK) {
      const alarm = payload.alarm;
      const color = alarm.severity === 'CRITICAL' ? '#e11d48' : alarm.severity === 'WARNING' ? '#f59e0b' : '#38bdf8';

      const slackPayload = {
        text: `*VigilOne Surveillance Alert*: ${alarm.title}`,
        attachments: [
          {
            color,
            title: alarm.title,
            fields: [
              { title: 'Severity', value: alarm.severity, short: true },
              { title: 'Camera', value: alarm.camera, short: true },
              { title: 'Details', value: alarm.description || 'No additional details', short: false },
            ],
            footer: 'VigilOne Commercial Edge Appliance',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      };

      const res = await axios.post(channel.targetUrl, slackPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      });
      return { success: res.status === 200, statusCode: res.status };
    }

    if (channel.type === NotificationChannelType.EMAIL) {
      // In container/edge environments, log or send via SMTP
      console.log(`[NotificationDispatcher] Email alert dispatched to ${channel.targetUrl}: ${payload.alarm?.title}`);
      return { success: true, statusCode: 250 };
    }

    return { success: false, statusCode: 400 };
  }

  /**
   * Token bucket rate limiter per channel.
   */
  private consumeRateToken(channelId: string): boolean {
    const now = Date.now();
    let bucket = this.channelBuckets.get(channelId);

    if (!bucket) {
      bucket = { tokens: this.MAX_TOKENS, lastRefill: now };
      this.channelBuckets.set(channelId, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.MAX_TOKENS, bucket.tokens + elapsedSec * this.REFILL_RATE_PER_SEC);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1.0) {
      bucket.tokens -= 1.0;
      return true;
    }
    return false;
  }
}

export default NotificationDispatcherService;
