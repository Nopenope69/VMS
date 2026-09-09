import { EventSeverity, NotificationChannelType, NotificationJobStatus } from '@prisma/client';
import { NotificationDispatcherService } from '../services/notification/notificationDispatcher.service';
import crypto from 'crypto';
import axios from 'axios';
import dns from 'dns';

jest.mock('axios');
jest.mock('dns', () => ({
  promises: {
    lookup: jest.fn().mockImplementation((hostname: string) => {
      return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    }),
  },
}));

describe('NotificationDispatcherService - Reliable Alert Queue & HMAC Signing', () => {
  let service: NotificationDispatcherService;
  let mockPrisma: any;
  let channelsStore: any[] = [];
  let jobsStore: any[] = [];
  let logsStore: any[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    channelsStore = [];
    jobsStore = [];
    logsStore = [];

    mockPrisma = {
      notificationChannel: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(channelsStore.filter((c) => c.tenantId === where.tenantId && c.enabled));
        }),
      },
      notificationJob: {
        upsert: jest.fn().mockImplementation(({ where, create }) => {
          const existing = jobsStore.find((j) => j.idempotencyKey === where.idempotencyKey);
          if (existing) return Promise.resolve(existing);
          const job = { id: `job_${jobsStore.length + 1}`, ...create };
          jobsStore.push(job);
          return Promise.resolve(job);
        }),
        findMany: jest.fn().mockImplementation(() => Promise.resolve(jobsStore.filter((j) => j.status === NotificationJobStatus.PENDING))),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const idx = jobsStore.findIndex((j) => j.id === where.id);
          if (idx >= 0) {
            jobsStore[idx] = { ...jobsStore[idx], ...data };
            return Promise.resolve(jobsStore[idx]);
          }
          return Promise.resolve(null);
        }),
      },
      notificationLog: {
        create: jest.fn().mockImplementation(({ data }) => {
          logsStore.push(data);
          return Promise.resolve(data);
        }),
      },
    };

    service = new NotificationDispatcherService(mockPrisma);
  });

  afterEach(() => {
    service.stop();
  });

  it('enqueues notifications with deterministic idempotency keys (deduplication invariant)', async () => {
    channelsStore.push({
      id: 'chan_webhook_01',
      tenantId: 'tenant_01',
      name: 'Security NOC Webhook',
      type: NotificationChannelType.WEBHOOK,
      targetUrl: 'https://noc.example.com/alerts',
      secretToken: 'secret_hmac_123',
      minSeverity: EventSeverity.WARNING,
      enabled: true,
    });

    const enqueued1 = await service.enqueueAlarmNotifications({
      tenantId: 'tenant_01',
      alarmId: 'alarm_999',
      title: 'Perimeter Intrusion Detected',
      severity: EventSeverity.CRITICAL,
    });
    expect(enqueued1).toBe(1);
    expect(jobsStore).toHaveLength(1);

    // Re-triggering the same alarm must NOT produce duplicate jobs
    const enqueued2 = await service.enqueueAlarmNotifications({
      tenantId: 'tenant_01',
      alarmId: 'alarm_999',
      title: 'Perimeter Intrusion Detected',
      severity: EventSeverity.CRITICAL,
    });
    expect(jobsStore).toHaveLength(1);
  });

  it('dispatches webhook with HMAC-SHA256 signature in X-VigilOne-Signature header', async () => {
    const channel = {
      id: 'chan_01',
      type: NotificationChannelType.WEBHOOK,
      targetUrl: 'https://api.example.com/webhook',
      secretToken: 'my_super_secret',
    };

    const payload = { test: 'data', timestamp: 12345 };
    (axios.post as jest.Mock).mockResolvedValue({ status: 200 });

    const result = await service.dispatchToAdapter(channel, payload);
    expect(result.success).toBe(true);

    const callHeaders = (axios.post as jest.Mock).mock.calls[0][2].headers;
    expect(callHeaders['X-VigilOne-Signature']).toBeDefined();

    // Verify HMAC-SHA256 calculation
    const expectedSig = crypto
      .createHmac('sha256', 'my_super_secret')
      .update(JSON.stringify(payload))
      .digest('hex');

    expect(callHeaders['X-VigilOne-Signature']).toBe(`sha256=${expectedSig}`);
  });

  it('handles delivery failure with retry backoff and transitions to DEAD_LETTER on exhaustion', async () => {
    const channel = {
      id: 'chan_01',
      type: NotificationChannelType.WEBHOOK,
      targetUrl: 'https://bad.example.com/endpoint',
    };

    jobsStore.push({
      id: 'job_fail_01',
      tenantId: 'tenant_01',
      channelId: channel.id,
      alarmId: 'alarm_01',
      idempotencyKey: 'key_fail_01',
      status: NotificationJobStatus.PENDING,
      attempts: 2, // Last attempt before dead-letter (max 3)
      maxAttempts: 3,
      channel,
      payloadJson: { test: true },
    });

    (axios.post as jest.Mock).mockRejectedValue(new Error('Connection refused'));

    await service.processQueue();

    expect(jobsStore[0].status).toBe(NotificationJobStatus.DEAD_LETTER);
    expect(logsStore).toHaveLength(1);
    expect(logsStore[0].status).toBe('DEAD_LETTER');
  });
});
