import { markAutomationRulesChanged } from '../services/automation/ruleCache';
import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { RuleEngine } from '../services/incident/orchestrator/ruleEngine';
import { createVigilOneEvent } from '../services/incident/orchestrator/events';
import { VigilOneEventType } from '../services/incident/orchestrator/types';
import { EVENT_KIND_NAMES, isEventKind } from '../services/incident/orchestrator/eventKinds';
import { validateRuleInput, RuleValidationError } from '../services/automation/ruleSchema';
import { RulePreviewService, PREVIEW_MAX_DAYS } from '../services/automation/rulePreview.service';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const ruleEngine = new RuleEngine(prisma);
const previewService = new RulePreviewService(prisma);

function ruleError(res: Response, err: any): void {
  if (err instanceof RuleValidationError) {
    res.status(400).json({ error: err.message, code: 'RULE_INVALID' });
    return;
  }
  res.status(500).json({ error: err.message });
}

/** Camera and spatial-rule references must belong to the caller's tenant. */
async function assertRuleRefs(tenantId: string, cfg: Record<string, any>, conditions: any[]): Promise<void> {
  const cams = [cfg.cameraId, ...conditions.map((c) => c?.value?.cameraId)].filter(Boolean);
  if (cams.length) {
    const n = await prisma.camera.count({ where: { id: { in: cams }, tenantId } });
    if (n !== new Set(cams).size) throw new RuleValidationError('cameraId does not name a camera of this tenant');
  }
  if (cfg.spatialRuleId) {
    const r = await prisma.spatialAnalyticsRule.findFirst({ where: { id: cfg.spatialRuleId, tenantId } });
    if (!r) throw new RuleValidationError('spatialRuleId does not name a spatial rule of this tenant');
  }
}

/**
 * GET /api/v1/automation/rules
 * List automation rules
 */
router.get(
  '/rules',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const rules = await prisma.automationRule.findMany({
        where: { tenantId },
        orderBy: { priority: 'asc' },
      });
      res.json({ rules });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/automation/rules
 * Create an automation rule
 */
router.post(
  '/rules',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const v = validateRuleInput(req.body);
      await assertRuleRefs(tenantId, v.triggerConfig, v.conditions);

      const rule = await prisma.automationRule.create({
        data: {
          tenantId,
          name: v.name,
          triggerType: v.triggerType,
          triggerConfigJson: v.triggerConfig as any,
          conditionsJson: v.conditions as any,
          actionsJson: v.actions as any,
          cooldownSeconds: v.cooldownSeconds,
          priority: v.priority,
          enabled: v.enabled,
        },
      });
      markAutomationRulesChanged();
      await AuditChainService.record(prisma, {
        tenantId, userId: req.user!.id, action: 'AUTOMATION_RULE_CREATE', resourceType: 'AutomationRule', resourceId: rule.id,
        ipAddress: req.ip || '127.0.0.1', metadata: { name: v.name, triggerType: v.triggerType, triggerConfig: v.triggerConfig, conditions: v.conditions, actions: v.actions.map((a) => a.type) },
      });

      res.status(201).json({ rule });
    } catch (err: any) {
      ruleError(res, err);
    }
  }
);

/**
 * PUT /api/v1/automation/rules/:id
 * Replace a rule (same validation as create). Audited.
 */
router.put(
  '/rules/:id',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } });
      if (!existing) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }
      const v = validateRuleInput(req.body);
      await assertRuleRefs(tenantId, v.triggerConfig, v.conditions);
      const rule = await prisma.automationRule.update({
        where: { id: existing.id },
        data: {
          name: v.name,
          triggerType: v.triggerType,
          triggerConfigJson: v.triggerConfig as any,
          conditionsJson: v.conditions as any,
          actionsJson: v.actions as any,
          cooldownSeconds: v.cooldownSeconds,
          priority: v.priority,
          enabled: v.enabled,
        },
      });
      markAutomationRulesChanged();
      await AuditChainService.record(prisma, {
        tenantId, userId: req.user!.id, action: 'AUTOMATION_RULE_UPDATE', resourceType: 'AutomationRule', resourceId: rule.id,
        ipAddress: req.ip || '127.0.0.1',
        metadata: {
          before: { triggerType: existing.triggerType, triggerConfig: existing.triggerConfigJson, conditions: existing.conditionsJson, enabled: existing.enabled },
          after: { triggerType: v.triggerType, triggerConfig: v.triggerConfig, conditions: v.conditions, enabled: v.enabled },
        },
      });
      res.json({ rule });
    } catch (err: any) {
      ruleError(res, err);
    }
  }
);

/**
 * POST /api/v1/automation/rules/preview
 * Replays stored events of a time window through a draft rule. Read-only.
 */
router.post(
  '/rules/preview',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const { from, to, ...draft } = req.body || {};
      const v = validateRuleInput({ name: draft.name || 'preview', actions: draft.actions || [{ id: 'preview', type: 'TRIGGER_ALARM', config: {} }], ...draft });
      await assertRuleRefs(tenantId, v.triggerConfig, v.conditions);
      const toD = to ? new Date(to) : new Date();
      const fromD = from ? new Date(from) : new Date(toD.getTime() - 7 * 86400_000);
      if (isNaN(fromD.getTime()) || isNaN(toD.getTime()) || fromD >= toD) {
        res.status(400).json({ error: 'from and to must be ISO timestamps with from < to' });
        return;
      }
      if (toD.getTime() - fromD.getTime() > PREVIEW_MAX_DAYS * 86400_000) {
        res.status(400).json({ error: `preview window is limited to ${PREVIEW_MAX_DAYS} days` });
        return;
      }
      const result = await previewService.preview(tenantId, v, fromD, toD);
      res.json(result);
    } catch (err: any) {
      ruleError(res, err);
    }
  }
);

/**
 * DELETE /api/v1/automation/rules/:id
 * Delete a rule
 */
router.delete(
  '/rules/:id',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const existing = await prisma.automationRule.findFirst({ where: { id: req.params.id, tenantId } });
      if (!existing) {
        res.status(404).json({ error: 'Rule not found' });
        return;
      }
      await prisma.automationRule.delete({ where: { id: existing.id } });
      markAutomationRulesChanged();
      await AuditChainService.record(prisma, {
        tenantId, userId: req.user!.id, action: 'AUTOMATION_RULE_DELETE', resourceType: 'AutomationRule', resourceId: existing.id,
        ipAddress: req.ip || '127.0.0.1', metadata: { name: existing.name, triggerType: existing.triggerType },
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);


/**
 * POST /api/v1/automation/dry-run
 * Which enabled rules would fire for a test event, evaluated by the same RuleEngine the IncidentOrchestrator uses.
 * Nothing is executed or recorded: no rule execution, no action, no change to lastTriggeredAt (an earlier
 * version ran a separate rule engine that set lastTriggeredAt, which put the real rule into its cooldown).
 *
 * Body: { type, cameraId?, severity?, payload: { ...fields of that event kind } }
 */
router.post(
  '/dry-run',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    const tenantId = req.user!.tenantId;
    const { type, cameraId, severity, payload } = req.body ?? {};
    if (!isEventKind(type)) {
      res.status(400).json({ error: `type must be one of ${EVENT_KIND_NAMES.join(', ')}` });
      return;
    }
    if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
      res.status(400).json({ error: 'payload must be an object' });
      return;
    }
    if (severity !== undefined && !['INFO', 'WARNING', 'CRITICAL'].includes(severity)) {
      res.status(400).json({ error: 'severity must be INFO, WARNING or CRITICAL' });
      return;
    }
    try {
      const event = createVigilOneEvent({
        tenantId,
        cameraId: typeof cameraId === 'string' ? cameraId : undefined,
        severity,
        type,
        payload: { ...(payload ?? {}), kind: type } as any,
      });
      const rules = await prisma.automationRule.findMany({
        where: { tenantId, enabled: true, triggerType: { in: RuleEngine.candidateTriggerTypes(type, event.payload) } },
        orderBy: { name: 'asc' },
      });
      const now = Date.now();
      const matched = [];
      for (const rule of rules) {
        if (!(await ruleEngine.matchesRule(rule as any, event))) continue;
        const coolingUntil = rule.lastTriggeredAt ? rule.lastTriggeredAt.getTime() + rule.cooldownSeconds * 1000 : 0;
        matched.push({
          ruleId: rule.id,
          name: rule.name,
          actions: rule.actionsJson,
          // A real event now would be suppressed by this rule's cooldown.
          suppressedByCooldown: coolingUntil > now,
          cooldownEndsAt: coolingUntil > now ? new Date(coolingUntil).toISOString() : null,
        });
      }
      res.json({ evaluatedRules: rules.length, matchedRules: matched, executed: false });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /api/v1/automation/executions
 * View audit history of rule execution records
 */
router.get(
  '/executions',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const executions = await prisma.ruleExecutionRecord.findMany({
        where: { tenantId },
        include: { rule: { select: { name: true } }, actionExecutions: true },
        orderBy: { startedAt: 'desc' },
        take: 50,
      });
      res.json({ executions });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default router;
