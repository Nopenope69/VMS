import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { EventActionMatrixService } from '../services/automation/eventActionMatrix.service';

const router = Router();
const automationService = new EventActionMatrixService(prisma);

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
      const {
        name,
        triggerType,
        triggerConfig,
        conditions,
        actions,
        cooldownSeconds,
        priority,
        enabled,
      } = req.body;

      if (!name || !triggerType || !actions || !Array.isArray(actions)) {
        res.status(400).json({ error: 'name, triggerType, and actions array are required' });
        return;
      }

      const rule = await prisma.automationRule.create({
        data: {
          tenantId,
          name,
          triggerType,
          triggerConfigJson: triggerConfig || {},
          conditionsJson: conditions || [],
          actionsJson: actions,
          cooldownSeconds: cooldownSeconds !== undefined ? Number(cooldownSeconds) : 30,
          priority: priority !== undefined ? Number(priority) : 1,
          enabled: enabled !== undefined ? Boolean(enabled) : true,
        },
      });

      res.status(201).json({ rule });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
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
      await prisma.automationRule.deleteMany({
        where: { id: req.params.id, tenantId },
      });
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/automation/dry-run
 * Dry-run test event against automation rules
 */
router.post(
  '/dry-run',
  requireAuth,
  authorize(Permission.AUTOMATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const results = await automationService.processEvent({
        ...req.body,
        tenantId,
      });
      res.json({ executedRules: results.length, results });
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
