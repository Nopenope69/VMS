import {
  PrismaClient,
  NotificationChannelType,
  NotificationJobStatus,
  EventSeverity,
} from '@prisma/client';
import crypto from 'crypto';
import dns from 'dns';
import net from 'net';
import axios from 'axios';

export async function validateWebhookUrl(urlString: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid webhook target URL: ${urlString}`);
  }

  // 1. Enforce http/https protocols
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Unsupported protocol for webhook dispatch: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Denylist internal appliance Docker container and local hostnames
  const dockerDenylist = [
    'postgres',
    'backend',
    'mediamtx',
    'caddy',
    'vigilone-backend',
    'vigilone-mediamtx',
    'vigilone-postgres',
    'vigilone-gateway',
    'vigilone-synthetic-camera',
    'localhost',
  ];

  if (dockerDenylist.includes(hostname) || hostname.endsWith('.internal') || hostname.endsWith('.local')) {
    throw new Error(`SSRF Violation: Target host '${hostname}' is an internal network destination`);
  }

  // Helper to test if an IP is private/loopback/metadata
  const isProhibitedIp = (ip: string): boolean => {
    let cleanIp = ip;
    if (cleanIp.startsWith('::ffff:')) {
      cleanIp = cleanIp.slice(7);
    }

    if (cleanIp.startsWith('127.') || cleanIp === '::1') return true; // Loopback
    if (cleanIp.startsWith('169.254.') || cleanIp.toLowerCase().startsWith('fe80:')) return true; // Link-local / Cloud metadata
    if (cleanIp === '0.0.0.0' || cleanIp === '::') return true; // Unspecified

    // RFC 1918 Private ranges
    if (
      cleanIp.startsWith('10.') ||
      cleanIp.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(cleanIp)
    ) {
      return true;
    }

    // IPv6 ULA (fc00::/7) or multicast (ff00::/8)
    if (/^f[cd][0-9a-f]{2}:/i.test(cleanIp) || /^ff[0-9a-f]{2}:/i.test(cleanIp)) {
      return true;
    }

    // IPv4 Multicast
    if (net.isIPv4(cleanIp)) {
      const firstOctet = parseInt(cleanIp.split('.')[0], 10);
      if (firstOctet >= 224) return true;
    }

    return false;
  };

  // If hostname is already a direct IP address
  if (net.isIP(hostname)) {
    if (isProhibitedIp(hostname)) {
      throw new Error(`SSRF Violation: Target IP '${hostname}' is a prohibited private/metadata destination`);
    }
    return;
  }

  // 3. Pre-flight DNS resolution
  try {
    const lookupPromise = dns.promises.lookup(hostname, { all: true });
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 2500);
    });
    const addresses = await Promise.race([lookupPromise, timeoutPromise]).finally(() => {
      clearTimeout(timer);
    });
    for (const record of addresses) {
      if (isProhibitedIp(record.address)) {
        throw new Error(`SSRF Violation: Target host '${hostname}' resolved to prohibited IP '${record.address}'`);
      }
    }
  } catch (err: any) {
    if (err.message?.includes('SSRF Violation')) throw err;
    throw new Error(`SSRF Guard: Unable to resolve webhook destination '${hostname}': ${err.message}`);
  }
}

export interface DispatchNotificationRequest {
  tenantId: string;
  alarmId: string;
  title: string;
  description?: string | null;
  severity: EventSeverity;
  cameraName?: string;
  metadataJson?: any;
}

export class NotificationAdapter {
  private prisma: PrismaClient;
  private channelBuckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

  // Rate limit: 10 per minute per channel
  private readonly MAX_TOKENS = 10;
  private readonly REFILL_RATE_PER_SEC = 10 / 60;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
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
      if (severityHierarchy[req.severity] < severityHierarchy[channel.minSeverity]) {
        continue;
      }

      // Deterministic idempotency key
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
          update: {},
        });
        enqueued++;
      } catch (err: any) {
        console.warn(`[NotificationAdapter] Upsert notice for ${idempotencyKey}:`, err.message);
      }
    }

    return enqueued;
  }

  /**
   * Processes a batch of pending notification jobs
   */
  public async processQueue(): Promise<number> {
    const now = new Date();

    const jobs = await this.prisma.notificationJob.findMany({
      where: {
        status: NotificationJobStatus.PENDING,
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      include: {
        channel: true,
      },
      take: 10,
    });

    let processedCount = 0;

    for (const job of jobs) {
      if (!this.consumeRateToken(job.channelId)) {
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
        if (!success) {
          errorMsg = result.error || 'Notification dispatch failed';
        }
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

      processedCount++;
    }

    return processedCount;
  }

  /**
   * Adapter dispatcher supporting Webhook (HMAC signed), Slack Markdown, and Email.
   */
  public async dispatchToAdapter(
    channel: any,
    payload: any
  ): Promise<{ success: boolean; statusCode?: number; error?: string }> {
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

      await validateWebhookUrl(channel.targetUrl);
      const res = await axios.post(channel.targetUrl, payload, {
        headers,
        timeout: 5000,
        maxRedirects: 0,
      });
      return { success: res.status >= 200 && res.status < 300, statusCode: res.status };
    }

    if (channel.type === NotificationChannelType.SLACK) {
      const alarm = payload.alarm || {};
      const color =
        alarm.severity === 'CRITICAL' ? '#e11d48' : alarm.severity === 'WARNING' ? '#f59e0b' : '#38bdf8';

      const slackPayload = {
        text: `*VigilOne Surveillance Alert*: ${alarm.title || 'Alert'}`,
        attachments: [
          {
            color,
            title: alarm.title,
            fields: [
              { title: 'Severity', value: alarm.severity, short: true },
              { title: 'Camera', value: alarm.camera || 'System', short: true },
              { title: 'Details', value: alarm.description || 'No additional details', short: false },
            ],
            footer: 'VigilOne Commercial Edge Appliance',
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      };

      await validateWebhookUrl(channel.targetUrl);
      const res = await axios.post(channel.targetUrl, slackPayload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
        maxRedirects: 0,
      });
      return { success: res.status === 200, statusCode: res.status };
    }

    if (channel.type === NotificationChannelType.EMAIL) {
      return {
        success: false,
        statusCode: 501,
        error: 'SMTP_TRANSPORT_NOT_CONFIGURED: Native SMTP delivery is deferred for v1. Use Webhook or Slack notifications.',
      };
    }

    return {
      success: false,
      statusCode: 400,
      error: `Unsupported notification channel type: ${channel.type}`,
    };
  }

  private consumeRateToken(channelId: string): boolean {
    const now = Date.now();
    let bucket = this.channelBuckets.get(channelId);

    if (!bucket) {
      bucket = { tokens: this.MAX_TOKENS, lastRefill: now };
      this.channelBuckets.set(channelId, bucket);
    }

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
