import { PrismaClient, RelayConfirmationMode, RelayCommandState, NotificationChannelType } from '@prisma/client';
import { RelayAdapter } from '../services/incident/orchestrator/adapters/relayAdapter';
import { NotificationAdapter } from '../services/incident/orchestrator/adapters/notificationAdapter';
import { PtzAdapter } from '../services/incident/orchestrator/adapters/ptzAdapter';
import { ObjectStorageArchiveService } from '../services/storage/objectStorageArchive.service';
import { ActionOutbox } from '../services/incident/orchestrator/actionOutbox';
import { RuleActionType } from '@prisma/client';

describe('Systemic Fake-Success Elimination & Adapter Hardening (C-013)', () => {
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      digitalIoPin: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      relayCommandLog: {
        create: jest.fn(),
        update: jest.fn(),
      },
      camera: {
        findUnique: jest.fn(),
      },
      notificationChannel: {
        findMany: jest.fn(),
      },
      notificationJob: {
        upsert: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      notificationLog: {
        create: jest.fn(),
      },
      archiveJob: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      actionExecutionRecord: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      ruleExecutionRecord: {
        update: jest.fn(),
      },
      $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
    };
  });

  describe('RelayAdapter Hardening', () => {
    it('fails closed with NO_PHYSICAL_RELAY_DRIVER_ATTACHED when no driver configured', async () => {
      const adapter = new RelayAdapter(mockPrisma);
      mockPrisma.digitalIoPin.findUnique.mockResolvedValue({
        id: 'pin_01',
        pinNumber: 1,
        tenantId: 't1',
        direction: 'OUTPUT',
        confirmationMode: RelayConfirmationMode.STATE_FEEDBACK,
      });
      mockPrisma.relayCommandLog.create.mockResolvedValue({ id: 'log_01' });

      const result = await adapter.execute({
        tenantId: 't1',
        pinNumber: 1,
        command: 'SET_HIGH',
      });

      expect(result.lifecycleState).toBe(RelayCommandState.COMMAND_FAILED);
      expect(result.error).toBe('NO_PHYSICAL_RELAY_DRIVER_ATTACHED');
      expect(mockPrisma.relayCommandLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'log_01' },
          data: expect.objectContaining({
            lifecycleState: RelayCommandState.COMMAND_FAILED,
            errorMessage: 'NO_PHYSICAL_RELAY_DRIVER_ATTACHED',
          }),
        })
      );
    });

    it('fails when pulse high transition fails during PULSE_COMPLETION mode', async () => {
      const adapter = new RelayAdapter(mockPrisma);
      mockPrisma.digitalIoPin.findUnique.mockResolvedValue({
        id: 'pin_02',
        pinNumber: 2,
        tenantId: 't1',
        direction: 'OUTPUT',
        confirmationMode: RelayConfirmationMode.PULSE_COMPLETION,
        pulseDurationMs: 50,
      });
      mockPrisma.relayCommandLog.create.mockResolvedValue({ id: 'log_02' });

      adapter.setHardwareDriver(async (_pin, state) => {
        if (state === 'HIGH') return { confirmed: false, error: 'Relay coil power rail fault' };
        return { confirmed: true };
      });

      const result = await adapter.execute({
        tenantId: 't1',
        pinNumber: 2,
        command: 'PULSE',
      });

      expect(result.lifecycleState).toBe(RelayCommandState.COMMAND_FAILED);
      expect(result.error).toBe('Relay coil power rail fault');
    });
  });

  describe('NotificationAdapter Hardening', () => {
    it('returns 501 SMTP_TRANSPORT_NOT_CONFIGURED for EMAIL notification channel', async () => {
      const adapter = new NotificationAdapter(mockPrisma);
      const emailChannel = {
        id: 'chan_email_01',
        type: NotificationChannelType.EMAIL,
        targetUrl: 'admin@example.com',
      };

      const result = await adapter.dispatchToAdapter(emailChannel, { text: 'Alert' });

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(501);
      expect(result.error).toContain('SMTP_TRANSPORT_NOT_CONFIGURED');
    });
  });

  describe('PtzAdapter Hardening', () => {
    it('fails closed when camera has no IP address configured', async () => {
      const adapter = new PtzAdapter(mockPrisma);
      mockPrisma.camera.findUnique.mockResolvedValue({
        id: 'cam_no_ip',
        ipAddress: null,
      });

      const result = await adapter.gotoPreset({
        tenantId: 't1',
        cameraId: 'cam_no_ip',
        presetToken: 'preset_1',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('has no IP address configured for PTZ');
    });

    it('fails closed when neither presetToken nor presetName is provided', async () => {
      const adapter = new PtzAdapter(mockPrisma);
      mockPrisma.camera.findUnique.mockResolvedValue({
        id: 'cam_ok',
        ipAddress: '192.168.1.50',
      });

      const result = await adapter.gotoPreset({
        tenantId: 't1',
        cameraId: 'cam_ok',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Neither presetToken nor presetName provided');
    });
  });

  describe('ObjectStorageArchiveService Hardening', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('throws FEATURE_DEFERRED_FOR_V1 in production to prohibit in-memory fake S3 storage', async () => {
      process.env.NODE_ENV = 'production';
      const service = new ObjectStorageArchiveService(mockPrisma);

      mockPrisma.archiveJob.findUnique.mockResolvedValue({
        id: 'job_prod_01',
        tenant: { objectStorageConfig: { enabled: true } },
      });

      await expect(service.processArchiveJob('job_prod_01')).rejects.toThrow(
        /FEATURE_DEFERRED_FOR_V1/
      );
    });
  });

  describe('ActionOutbox Hardening', () => {
    it('throws when encountering START_HIGH_RES_RECORDING action type', async () => {
      const outbox = new ActionOutbox(mockPrisma, {
        relayAdapter: new RelayAdapter(mockPrisma),
        notificationAdapter: new NotificationAdapter(mockPrisma),
        ptzAdapter: new PtzAdapter(mockPrisma),
        bookmarkAdapter: {} as any,
        alarmLifecycle: {} as any,
      });

      const pendingRecord = {
        id: 'act_rec_01',
        ruleExecutionId: 'rule_exec_01',
        actionId: 'action_01',
        actionType: RuleActionType.START_HIGH_RES_RECORDING,
        attempt: 0,
        ruleExecution: {
          tenantId: 't1',
          rule: {
            actionsJson: [
              {
                id: 'action_01',
                type: RuleActionType.START_HIGH_RES_RECORDING,
                config: { cameraId: 'cam_01' },
              },
            ],
          },
        },
      };

      mockPrisma.actionExecutionRecord.findMany.mockResolvedValue([pendingRecord]);

      await outbox.drainOutbox();

      expect(mockPrisma.actionExecutionRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'act_rec_01' },
          data: expect.objectContaining({
            status: 'FAILED',
            error: expect.stringContaining('FEATURE_DEFERRED_FOR_V1'),
          }),
        })
      );
    });
  });
});
