import { AlarmState, EventSeverity, EventType } from '@prisma/client';
import { AlarmService } from '../services/alarm/alarm.service';

describe('AlarmService - Unified Event vs Alarm Lifecycle', () => {
  let service: AlarmService;
  let mockPrisma: any;
  let alarmsStore: any[] = [];

  beforeEach(() => {
    alarmsStore = [];
    mockPrisma = {
      eventRule: {
        findFirst: jest.fn(),
      },
      alarm: {
        findMany: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(
            alarmsStore.filter((a) => a.tenantId === where.tenantId)
          );
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          return Promise.resolve(alarmsStore.find((a) => a.id === where.id) || null);
        }),
        create: jest.fn().mockImplementation(({ data }) => {
          const alarm = { id: `alarm_${alarmsStore.length + 1}`, ...data };
          alarmsStore.push(alarm);
          return Promise.resolve(alarm);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const idx = alarmsStore.findIndex((a) => a.id === where.id);
          if (idx >= 0) {
            alarmsStore[idx] = { ...alarmsStore[idx], ...data };
            return Promise.resolve(alarmsStore[idx]);
          }
          return Promise.resolve(null);
        }),
      },
    };
    service = new AlarmService(mockPrisma);
  });

  describe('Event != Alarm Invariant & Rule Triggering', () => {
    it('should NOT raise an alarm for routine INFO events with no matching alarm rule', async () => {
      mockPrisma.eventRule.findFirst.mockResolvedValue(null);

      const event: any = {
        id: 'ev_info_01',
        cameraId: 'cam_01',
        type: EventType.MOTION,
        severity: EventSeverity.INFO,
        title: 'Routine Motion Spike',
        description: 'Motion score 0.45',
      };

      const result = await service.evaluateEventForAlarms(event, 'tenant_01');
      expect(result).toBeNull();
      expect(alarmsStore).toHaveLength(0);
    });

    it('should automatically raise an alarm for CRITICAL system events', async () => {
      mockPrisma.eventRule.findFirst.mockResolvedValue(null);

      const criticalEvent: any = {
        id: 'ev_crit_01',
        cameraId: 'cam_01',
        type: EventType.RECORDING_GAP,
        severity: EventSeverity.CRITICAL,
        title: 'Recording Gap Detected',
        description: '45s missing video footage',
      };

      const alarm = await service.evaluateEventForAlarms(criticalEvent, 'tenant_01');
      expect(alarm).toBeDefined();
      expect(alarm?.state).toBe(AlarmState.ACTIVE);
      expect(alarm?.severity).toBe(EventSeverity.CRITICAL);
      expect(alarm?.title).toContain('Recording Gap Detected');
    });

    it('should raise an alarm when event matches configured tenant EventRule', async () => {
      mockPrisma.eventRule.findFirst.mockResolvedValue({
        id: 'rule_after_hours_motion',
        name: 'After-Hours Motion In Vault',
        triggerType: EventType.MOTION,
      });

      const event: any = {
        id: 'ev_vault_01',
        cameraId: 'cam_vault',
        type: EventType.MOTION,
        severity: EventSeverity.INFO, // Even if INFO, matching rule elevates to Alarm!
        title: 'Vault Motion',
        description: 'Movement in restricted vault zone',
      };

      const alarm = await service.evaluateEventForAlarms(event, 'tenant_01');
      expect(alarm).toBeDefined();
      expect(alarm?.ruleId).toBe('rule_after_hours_motion');
      expect(alarm?.title).toBe('Rule Triggered: After-Hours Motion In Vault');
    });
  });

  describe('Operator Lifecycle: Acknowledge & Resolve Workflow', () => {
    it('should allow operator to acknowledge active alarm', async () => {
      const alarm = await mockPrisma.alarm.create({
        data: {
          tenantId: 'tenant_01',
          cameraId: 'cam_01',
          title: 'Suspicious Activity',
          severity: EventSeverity.WARNING,
          state: AlarmState.ACTIVE,
        },
      });

      const acked = await service.acknowledgeAlarm(alarm.id, 'tenant_01', 'user_operator');
      expect(acked.state).toBe(AlarmState.ACKNOWLEDGED);
      expect(acked.acknowledgedById).toBe('user_operator');
      expect(acked.acknowledgedAt).toBeDefined();
    });

    it('should allow operator to resolve alarm with mandatory resolution notes', async () => {
      const alarm = await mockPrisma.alarm.create({
        data: {
          tenantId: 'tenant_01',
          cameraId: 'cam_01',
          title: 'Perimeter Breach',
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACKNOWLEDGED,
        },
      });

      const resolved = await service.resolveAlarm(
        alarm.id,
        'tenant_01',
        'user_operator',
        'Guard dispatched. False alarm caused by stray animal.'
      );

      expect(resolved.state).toBe(AlarmState.RESOLVED);
      expect(resolved.resolvedById).toBe('user_operator');
      expect(resolved.resolutionNotes).toContain('False alarm caused by stray animal.');
    });

    it('should REJECT cross-tenant access to alarms', async () => {
      const alarm = await mockPrisma.alarm.create({
        data: {
          tenantId: 'tenant_ALPHA',
          title: 'Secret Alarm',
          severity: EventSeverity.CRITICAL,
          state: AlarmState.ACTIVE,
        },
      });

      // Tenant BRAVO operator tries to ack Tenant ALPHA alarm
      await expect(
        service.acknowledgeAlarm(alarm.id, 'tenant_BRAVO', 'user_spy')
      ).rejects.toThrow(/Forbidden/);
    });
  });
});
