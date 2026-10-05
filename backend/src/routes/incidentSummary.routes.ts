import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { generateIncidentSummary, IncidentSummaryError, latestIncidentSummary } from '../services/incidentSummary/service';

/**
 * Incident summaries (feature INCIDENT_SUMMARY, ADR 0016): a written story of an alarm where every sentence cites recorded
 * facts. Generating needs ALARM_MANAGE and is audited into the chain; reading needs CAMERA_VIEW.
 */
const router = Router();
router.use(requireAuth);

const fail = (res: Response, err: any) => {
  if (err instanceof IncidentSummaryError) return res.status(err.status).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: err.message });
};

router.post('/alarms/:alarmId', authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  try {
    const out = await generateIncidentSummary(prisma, { tenantId: req.user!.tenantId, userId: req.user!.id, clientIp: req.ip, userAgent: req.get('user-agent') || undefined }, req.params.alarmId);
    return res.status(out.created ? 201 : 200).json({ record: out.record, created: out.created });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.get('/alarms/:alarmId', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const record = await latestIncidentSummary(prisma, req.user!.tenantId, req.params.alarmId);
    if (!record) return res.status(404).json({ error: 'No summary has been generated for this alarm yet', code: 'NO_SUMMARY' });
    return res.json({ record });
  } catch (err: any) {
    return fail(res, err);
  }
});

export default router;
