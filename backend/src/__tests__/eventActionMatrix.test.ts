import {
  EventActionMatrixService,
  EventPayload,
} from '../services/automation/eventActionMatrix.service';
import { RuleTriggerType, RuleActionType } from '@prisma/client';

describe('EventActionMatrixService (Typed Rule DSL, Execution IDs & Cooldown Suppression)', () => {
  let service: EventActionMatrixService;
  let mockPrisma: any;
  const tenantId = 'tenant_auto_01';

  beforeEach(() => {
    mockPrisma = {
      automationRule: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      ruleExecutionRecord: {
        create: jest.fn(),
        update: jest.fn(),
      },
      actionExecutionRecord: {
        create: jest.fn(),
      },
    };
    service = new EventActionMatrixService(mockPrisma);
  });

  describe('Trigger Matching & Cooldown Suppression', () => {
    it('should match rule when event matches triggerType, cameraId and zoneId', async () => {
      const mockRule = {
        id: 'rule_01',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.TRIPWIRE_CROSS,
        cooldownSeconds: 30,
        lastTriggeredAt: null,
        triggerConfigJson: { cameraId: 'cam_01', zoneId: 'zone_perimeter' },
        conditionsJson: [],
        actionsJson: [
          {
            id: 'act_01',
            type: RuleActionType.FIRE_DO_RELAY,
            config: { pinNumber: 1, durationMs: 1000 },
          },
        ],
      };

      mockPrisma.automationRule.findMany.mockResolvedValue([mockRule]);

      const event: EventPayload = {
        tenantId,
        type: RuleTriggerType.TRIPWIRE_CROSS,
        cameraId: 'cam_01',
        zoneId: 'zone_perimeter',
      };

      const results = await service.processEvent(event);

      expect(results).toHaveLength(1);
      expect(results[0].ruleId).toBe('rule_01');
      expect(results[0].overallStatus).toBe('SUCCESS');
      expect(results[0].ruleExecutionId).toMatch(/^exec_/);
      expect(mockPrisma.automationRule.update).toHaveBeenCalledWith({
        where: { id: 'rule_01' },
        data: { lastTriggeredAt: expect.any(Date) },
      });
    });

    it('should suppress rule execution if cooldown period is active', async () => {
      const mockRule = {
        id: 'rule_cooldown_01',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.MOTION_ZONE,
        cooldownSeconds: 60,
        lastTriggeredAt: new Date(Date.now() - 10000), // 10s ago, cooldown is 60s
        triggerConfigJson: { cameraId: 'cam_01' },
        conditionsJson: [],
        actionsJson: [{ id: 'act_01', type: RuleActionType.DISPATCH_NOTIFICATION, config: {} }],
      };

      mockPrisma.automationRule.findMany.mockResolvedValue([mockRule]);

      const event: EventPayload = {
        tenantId,
        type: RuleTriggerType.MOTION_ZONE,
        cameraId: 'cam_01',
      };

      const results = await service.processEvent(event);

      expect(results).toHaveLength(0); // Suppressed
      expect(mockPrisma.ruleExecutionRecord.create).not.toHaveBeenCalled();
    });

    it('should reject execution when severity condition threshold is not met', async () => {
      const mockRule = {
        id: 'rule_crit_01',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.CAMERA_OFFLINE,
        cooldownSeconds: 10,
        lastTriggeredAt: null,
        triggerConfigJson: {},
        conditionsJson: [
          {
            type: 'SEVERITY_THRESHOLD',
            operator: 'EQUALS',
            value: 'CRITICAL',
          },
        ],
        actionsJson: [{ id: 'act_01', type: RuleActionType.TRIGGER_ALARM, config: {} }],
      };

      mockPrisma.automationRule.findMany.mockResolvedValue([mockRule]);

      const event: EventPayload = {
        tenantId,
        type: RuleTriggerType.CAMERA_OFFLINE,
        severity: 'WARNING', // Below CRITICAL
      };

      const results = await service.processEvent(event);
      expect(results).toHaveLength(0);
    });
  });

  describe('Multi-Action Execution, Timeout & Error Cascading', () => {
    it('should halt subsequent actions when continueOnFailure is false and an action fails', async () => {
      const mockRule = {
        id: 'rule_fail_stop',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.ANPR_WATCHLIST,
        cooldownSeconds: 0,
        lastTriggeredAt: null,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [
          {
            id: 'act_1',
            type: RuleActionType.FIRE_DO_RELAY,
            config: {},
            continueOnFailure: false,
          },
          {
            id: 'act_2',
            type: RuleActionType.DISPATCH_NOTIFICATION,
            config: {},
          },
        ],
      };

      mockPrisma.automationRule.findMany.mockResolvedValue([mockRule]);

      // Register failing handler for FIRE_DO_RELAY
      service.registerActionHandler(RuleActionType.FIRE_DO_RELAY, async () => {
        throw new Error('Relay hardware offline');
      });

      const event: EventPayload = {
        tenantId,
        type: RuleTriggerType.ANPR_WATCHLIST,
      };

      const results = await service.processEvent(event);

      expect(results).toHaveLength(1);
      expect(results[0].overallStatus).toBe('FAILED');
      expect(results[0].actionResults).toHaveLength(1); // Second action skipped
      expect(results[0].actionResults[0].status).toBe('FAILED');
      expect(results[0].actionResults[0].error).toBe('Relay hardware offline');
    });

    it('should continue executing actions when continueOnFailure is true and produce PARTIAL status', async () => {
      const mockRule = {
        id: 'rule_partial',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.DIGITAL_INPUT_STATE,
        cooldownSeconds: 0,
        lastTriggeredAt: null,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [
          {
            id: 'act_1',
            type: RuleActionType.FIRE_DO_RELAY,
            config: {},
            continueOnFailure: true,
          },
          {
            id: 'act_2',
            type: RuleActionType.DISPATCH_NOTIFICATION,
            config: {},
          },
        ],
      };

      mockPrisma.automationRule.findMany.mockResolvedValue([mockRule]);

      service.registerActionHandler(RuleActionType.FIRE_DO_RELAY, async () => {
        throw new Error('Relay bus error');
      });
      service.registerActionHandler(RuleActionType.DISPATCH_NOTIFICATION, async () => {
        return { sent: true };
      });

      const event: EventPayload = {
        tenantId,
        type: RuleTriggerType.DIGITAL_INPUT_STATE,
      };

      const results = await service.processEvent(event);

      expect(results).toHaveLength(1);
      expect(results[0].overallStatus).toBe('PARTIAL');
      expect(results[0].actionResults).toHaveLength(2);
      expect(results[0].actionResults[0].status).toBe('FAILED');
      expect(results[0].actionResults[1].status).toBe('SUCCESS');
    });

    it('should enforce timeout on slow actions and mark as TIMEOUT', async () => {
      const mockRule = {
        id: 'rule_timeout',
        tenantId,
        enabled: true,
        triggerType: RuleTriggerType.TRIPWIRE_CROSS,
        cooldownSeconds: 0,
        lastTriggeredAt: null,
        triggerConfigJson: {},
        conditionsJson: [],
        actionsJson: [
          {
            id: 'act_slow',
            type: RuleActionType.PTZ_PRESET_GOTO,
            config: {},
            timeoutMs: 50, // Short timeout for test
            continueOnFailure: true,
          },
        ],
      };

      mockPrisma.automationRule.findMany.mockResolvedValue([mockRule]);

      service.registerActionHandler(RuleActionType.PTZ_PRESET_GOTO, async () => {
        return new Promise((resolve) => setTimeout(resolve, 200));
      });

      const event: EventPayload = {
        tenantId,
        type: RuleTriggerType.TRIPWIRE_CROSS,
      };

      const results = await service.processEvent(event);

      expect(results).toHaveLength(1);
      expect(results[0].overallStatus).toBe('FAILED');
      expect(results[0].actionResults[0].status).toBe('TIMEOUT');
      expect(results[0].actionResults[0].error).toContain('Action timeout after 50ms');
    });
  });
});
