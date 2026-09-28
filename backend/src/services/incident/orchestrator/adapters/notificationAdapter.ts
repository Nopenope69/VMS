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
import { AuditChainService } from '../../../audit/auditChain.service';
import { MetricsService } from '../../../observability/metrics.service';
import { sendMail, SmtpError } from '../../../notification/smtp/smtpClient';
import { sendWhatsAppTemplate, WhatsAppError } from '../../../notification/channels/whatsappCloud';
import { GenericHttpSmsProvider, SmsProvider, SmsError } from '../../../notification/channels/smsProvider';
import { resolveChannelConfig, validateTargets } from '../../../notification/channels/channelConfig';

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
  /** Restrict to these channels (escalation steps); default: every enabled channel. */
  channelIds?: string[];
  /** Escalation step that queued the jobs (P3.4); part of the idempotency key. */
  escalationStep?: number;
}

export interface DispatchReceipt {
  target: string;
  providerMessageId: string | null;
  statusCode?: number;
}

export interface DispatchResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  /** A failure that retrying cannot fix (bad credentials, rejected recipient, blocked channel). */
  permanent?: boolean;
  /** One entry per target the provider accepted in this attempt. */
  receipts?: DispatchReceipt[];
}

/** Channels that need the internet. VIGILONE_AIR_GAPPED=true blocks them (fail closed). */
const EXTERNAL_CHANNEL_TYPES = new Set<string>(['WHATSAPP', 'SMS', 'SLACK', 'WEBHOOK']);

export function isAirGapped(): boolean {
  return process.env.VIGILONE_AIR_GAPPED === 'true';
}

const DEFAULT_RATE_PER_MINUTE = 10;
const DISPATCH_METRIC = 'vigilone_notification_dispatch_total';
const DISPATCH_HELP = 'Notification dispatch attempts by channel type and outcome';

function alarmText(payload: any) {
  const a = payload?.alarm || {};
  return {
    severity: String(a.severity || 'INFO'),
    title: String(a.title || 'Alarm'),
    camera: String(a.camera || 'System'),
    at: String(a.triggeredAt || payload?.timestamp || ''),
    description: a.description ? String(a.description) : '',
    id: String(a.id || ''),
  };
}

export class NotificationAdapter {
  private prisma: PrismaClient;
  private channelBuckets: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private smsProviderFactory: (cfg: any) => SmsProvider;

  constructor(prisma: PrismaClient, opts: { smsProviderFactory?: (cfg: any) => SmsProvider } = {}) {
    this.prisma = prisma;
    this.smsProviderFactory = opts.smsProviderFactory || ((cfg) => new GenericHttpSmsProvider(cfg));
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
        ...(req.channelIds ? { id: { in: req.channelIds } } : {}),
      },
    });

    let enqueued = 0;
    const severityHierarchy: Record<EventSeverity, number> = {
      INFO: 1,
      WARNING: 2,
      CRITICAL: 3,
    };

    for (const channel of channels) {
      // Escalation steps name their channels explicitly; the channel's own floor still applies.
      if (severityHierarchy[req.severity] < severityHierarchy[channel.minSeverity]) {
        continue;
      }

      // Deterministic idempotency key (escalation steps are distinct notifications)
      const idempotencyKey = crypto
        .createHash('sha256')
        .update(`${req.alarmId}_${channel.id}_${req.severity}${req.escalationStep !== undefined ? `_esc${req.escalationStep}` : ''}`)
        .digest('hex');

      const payload = {
        event: req.escalationStep !== undefined ? 'ALARM_ESCALATED' : 'ALARM_TRIGGERED',
        alarm: {
          id: req.alarmId,
          title: req.title,
          description: req.description,
          severity: req.severity,
          camera: req.cameraName || 'System',
          metadata: req.metadataJson,
          triggeredAt: new Date().toISOString(),
        },
        ...(req.escalationStep !== undefined ? { escalationStep: req.escalationStep } : {}),
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
            ...(req.escalationStep !== undefined ? { escalationStep: req.escalationStep } : {}),
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
   * Processes a batch of pending notification jobs: per-channel rate limit, retry with backoff,
   * permanent failures straight to DEAD_LETTER, one NotificationLog per provider receipt and an
   * audit entry per dispatch attempt.
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
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    let processedCount = 0;

    for (const job of jobs) {
      const channel: any = job.channel;
      if (!this.consumeRateToken(job.channelId, Number(channel?.configJson?.ratePerMinute) || DEFAULT_RATE_PER_MINUTE)) {
        MetricsService.incCounter(DISPATCH_METRIC, DISPATCH_HELP, { channel_type: String(channel?.type), outcome: 'rate_limited' });
        continue;
      }

      await this.prisma.notificationJob.update({
        where: { id: job.id },
        data: { status: NotificationJobStatus.PROCESSING },
      });

      const payload: any = job.payloadJson || {};
      const alreadyDelivered: string[] = Array.isArray(payload._deliveredTargets) ? payload._deliveredTargets : [];
      const startTime = Date.now();
      let result: DispatchResult;
      try {
        result = await this.dispatchToAdapter(channel, payload, { skipTargets: alreadyDelivered });
      } catch (err: any) {
        result = { success: false, error: err.message || 'Unknown network error', statusCode: err.response?.status };
      }
      const latencyMs = Date.now() - startTime;
      const receipts = result.receipts || [];
      const deliveredTargets = [...alreadyDelivered, ...receipts.map((r) => r.target)];

      for (const r of receipts) {
        await this.prisma.notificationLog.create({
          data: {
            tenantId: job.tenantId,
            channelId: job.channelId,
            alarmId: job.alarmId,
            status: 'DELIVERED',
            responseCode: r.statusCode ?? result.statusCode ?? 200,
            latencyMs,
            dispatchedAt: new Date(),
            providerMessageId: r.providerMessageId,
            // Provider accepted the message; WhatsApp callbacks later move this to DELIVERED/READ/FAILED.
            deliveryStatus: 'SENT',
            deliveryUpdatedAt: new Date(),
          },
        });
      }

      let outcome: 'delivered' | 'retry' | 'dead_letter';
      if (result.success) {
        outcome = 'delivered';
        await this.prisma.notificationJob.update({
          where: { id: job.id },
          data: {
            status: NotificationJobStatus.DELIVERED,
            processedAt: new Date(),
            attempts: job.attempts + 1,
            error: null,
            providerMessageId: receipts.find((r) => r.providerMessageId)?.providerMessageId ?? null,
            ...(alreadyDelivered.length || receipts.length > 1 ? { payloadJson: { ...payload, _deliveredTargets: deliveredTargets } } : {}),
          },
        });
      } else {
        const newAttempts = job.attempts + 1;
        const isDeadLetter = result.permanent === true || newAttempts >= job.maxAttempts;
        outcome = isDeadLetter ? 'dead_letter' : 'retry';

        const backoffSeconds = Math.min(120, Math.pow(newAttempts, 2) * 5);
        const nextRetry = new Date(Date.now() + backoffSeconds * 1000);

        await this.prisma.notificationJob.update({
          where: { id: job.id },
          data: {
            status: isDeadLetter ? NotificationJobStatus.DEAD_LETTER : NotificationJobStatus.PENDING,
            attempts: newAttempts,
            nextRetryAt: isDeadLetter ? null : nextRetry,
            error: result.error || 'Notification dispatch failed',
            processedAt: isDeadLetter ? new Date() : undefined,
            // Targets the provider already accepted are not messaged again on retry.
            ...(receipts.length ? { payloadJson: { ...payload, _deliveredTargets: deliveredTargets } } : {}),
          },
        });

        await this.prisma.notificationLog.create({
          data: {
            tenantId: job.tenantId,
            channelId: job.channelId,
            alarmId: job.alarmId,
            status: isDeadLetter ? 'DEAD_LETTER' : 'RETRY_PENDING',
            responseCode: result.statusCode || 500,
            latencyMs,
            error: result.error,
            dispatchedAt: new Date(),
          },
        });
      }

      MetricsService.incCounter(DISPATCH_METRIC, DISPATCH_HELP, { channel_type: String(channel?.type), outcome });
      await this.auditDispatch(job, channel, outcome, result, receipts);
      processedCount++;
    }

    return processedCount;
  }

  private async auditDispatch(job: any, channel: any, outcome: string, result: DispatchResult, receipts: DispatchReceipt[]) {
    try {
      await AuditChainService.record(this.prisma, {
        tenantId: job.tenantId,
        userId: null,
        action: 'NOTIFICATION_DISPATCH',
        resourceType: 'NotificationJob',
        resourceId: job.id,
        ipAddress: '127.0.0.1',
        metadata: {
          alarmId: job.alarmId,
          channelId: job.channelId,
          channelType: channel?.type,
          outcome,
          attempt: job.attempts + 1,
          statusCode: result.statusCode ?? null,
          error: result.success ? null : (result.error || '').slice(0, 300),
          providerMessageIds: receipts.map((r) => r.providerMessageId).filter(Boolean),
          recipients: receipts.length,
        },
      });
    } catch (err: any) {
      // The dispatch already happened; a missing audit row is surfaced, not hidden.
      MetricsService.incCounter('vigilone_notification_audit_failures_total', 'Notification dispatches whose audit entry failed to record');
      console.error(`[NotificationAdapter] Audit record failed for job ${job.id}: ${err.message}`);
    }
  }

  /**
   * Adapter dispatcher: Webhook (HMAC signed), Slack, Email (SMTP), WhatsApp Cloud API, SMS.
   */
  public async dispatchToAdapter(channel: any, payload: any, opts: { skipTargets?: string[] } = {}): Promise<DispatchResult> {
    if (isAirGapped() && EXTERNAL_CHANNEL_TYPES.has(channel.type)) {
      return {
        success: false,
        statusCode: 403,
        permanent: true,
        error: `AIR_GAPPED_CHANNEL_BLOCKED: ${channel.type} needs the internet and VIGILONE_AIR_GAPPED=true`,
      };
    }
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
      const ok = res.status >= 200 && res.status < 300;
      return { success: ok, statusCode: res.status, receipts: ok ? [{ target: channel.targetUrl, providerMessageId: null, statusCode: res.status }] : [] };
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
      const ok = res.status === 200;
      return { success: ok, statusCode: res.status, receipts: ok ? [{ target: channel.targetUrl, providerMessageId: null, statusCode: res.status }] : [] };
    }

    if (channel.type === NotificationChannelType.EMAIL) {
      return this.dispatchEmail(channel, payload);
    }

    if (channel.type === NotificationChannelType.WHATSAPP || channel.type === NotificationChannelType.SMS) {
      return this.dispatchPerRecipient(channel, payload, new Set(opts.skipTargets || []));
    }

    return {
      success: false,
      statusCode: 400,
      permanent: true,
      error: `Unsupported notification channel type: ${channel.type}`,
    };
  }

  private configOrError(channel: any): { cfg?: any; targets?: string[]; error?: DispatchResult } {
    try {
      const cfg = resolveChannelConfig(channel.type, channel.configJson);
      const targets = validateTargets(channel.type, channel.targetUrl);
      return { cfg, targets };
    } catch (e: any) {
      return { error: { success: false, statusCode: 400, permanent: true, error: `CHANNEL_MISCONFIGURED: ${e.message}` } };
    }
  }

  private async dispatchEmail(channel: any, payload: any): Promise<DispatchResult> {
    const { cfg, targets, error } = this.configOrError(channel);
    if (error) return error;
    if (!cfg.smtpHost || !cfg.smtpPort || !cfg.from) {
      return { success: false, statusCode: 400, permanent: true, error: 'CHANNEL_MISCONFIGURED: EMAIL channel needs smtpHost, smtpPort and from' };
    }
    const a = alarmText(payload);
    const text = [
      `Alarm: ${a.title}`,
      `Severity: ${a.severity}`,
      `Camera: ${a.camera}`,
      `Triggered at: ${a.at}`,
      a.description ? `Details: ${a.description}` : null,
      payload?.escalationStep !== undefined ? `Escalation step: ${payload.escalationStep}` : null,
      `Alarm id: ${a.id}`,
      '',
      'Sent by VigilOne. Acknowledge the alarm in the VigilOne console.',
    ]
      .filter((l) => l !== null)
      .join('\n');
    try {
      const res = await sendMail(
        {
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          security: cfg.security,
          username: cfg.username,
          password: cfg.password,
          rejectUnauthorized: cfg.rejectUnauthorized,
          timeoutMs: 15000,
        },
        {
          from: cfg.from,
          to: targets!,
          subject: `[VigilOne ${a.severity}] ${a.title}`,
          text,
          headers: { 'X-VigilOne-Alarm': a.id },
        }
      );
      // The receipt is the relay's queue id when it reports one; never a made-up value.
      return { success: true, statusCode: 250, receipts: [{ target: res.accepted.join(','), providerMessageId: res.queueId, statusCode: 250 }] };
    } catch (e: any) {
      if (e instanceof SmtpError) return { success: false, statusCode: e.code ?? 0, permanent: e.permanent, error: e.message };
      throw e;
    }
  }

  /** WhatsApp and SMS: one provider call per recipient, stopping at the first failure. */
  private async dispatchPerRecipient(channel: any, payload: any, skip: Set<string>): Promise<DispatchResult> {
    const { cfg, targets, error } = this.configOrError(channel);
    if (error) return error;
    const a = alarmText(payload);
    const receipts: DispatchReceipt[] = [];
    for (const to of targets!) {
      if (skip.has(to)) continue;
      try {
        if (channel.type === NotificationChannelType.WHATSAPP) {
          if (!cfg.accessToken || !cfg.phoneNumberId || !cfg.templateName) {
            return { success: false, statusCode: 400, permanent: true, error: 'CHANNEL_MISCONFIGURED: WHATSAPP channel needs phoneNumberId, accessToken and templateName', receipts };
          }
          // Template body parameters, in order: {{1}} severity, {{2}} title, {{3}} camera, {{4}} time.
          const r = await sendWhatsAppTemplate(
            { phoneNumberId: cfg.phoneNumberId, accessToken: cfg.accessToken, templateName: cfg.templateName, languageCode: cfg.languageCode || 'en', apiVersion: cfg.apiVersion || 'v21.0' },
            to,
            [a.severity, a.title, a.camera, a.at]
          );
          receipts.push({ target: to, providerMessageId: r.providerMessageId, statusCode: r.statusCode });
        } else {
          if (!cfg.providerUrl || !cfg.apiKey) {
            return { success: false, statusCode: 400, permanent: true, error: 'CHANNEL_MISCONFIGURED: SMS channel needs providerUrl and apiKey', receipts };
          }
          const r = await this.smsProviderFactory(cfg).send(to, `VigilOne ${a.severity}: ${a.title} (${a.camera}) ${a.at}`);
          receipts.push({ target: to, providerMessageId: r.providerMessageId, statusCode: r.statusCode });
        }
      } catch (e: any) {
        if (e instanceof WhatsAppError || e instanceof SmsError) {
          return { success: false, statusCode: e.statusCode, permanent: e.permanent, error: `${to}: ${e.message}`, receipts };
        }
        throw e;
      }
    }
    return { success: true, statusCode: receipts[receipts.length - 1]?.statusCode ?? 200, receipts };
  }

  private consumeRateToken(channelId: string, ratePerMinute: number): boolean {
    const now = Date.now();
    let bucket = this.channelBuckets.get(channelId);

    if (!bucket) {
      bucket = { tokens: ratePerMinute, lastRefill: now };
      this.channelBuckets.set(channelId, bucket);
    }

    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(ratePerMinute, bucket.tokens + (elapsedSec * ratePerMinute) / 60);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1.0) {
      bucket.tokens -= 1.0;
      return true;
    }
    return false;
  }
}
