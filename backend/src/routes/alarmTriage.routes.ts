import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { AlarmTriageService } from '../services/incident/triage/alarmTriage.service';

/**
 * Alarm triage (feature ALARM_TRIAGE, ADR 0015). Read-only: an ordered queue of open alarms with reasons, and a
 * false-alarm report with proposed rule changes that nothing applies.
 */
const router = Router();
router.use(requireAuth);
const svc = new AlarmTriageService(prisma);

router.get('/queue', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    return res.json(await svc.queue(req.user!.tenantId));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/report', authorize(Permission.ALARM_FEEDBACK), async (req: Request, res: Response) => {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) return res.status(400).json({ error: 'from and to must be ISO timestamps with from < to' });
  try {
    return res.json(await svc.report(req.user!.tenantId, from, to));
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
