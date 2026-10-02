import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { InvestigationTimingService, OUTCOMES, STEP_KINDS, TimingError } from '../services/investigation/investigationTiming.service';

/**
 * Time-to-answer stopwatch (feature INVESTIGATION_TIMING). Operators who can view recordings run their own
 * stopwatch; the site-wide report needs AUDIT_VIEW. See docs/operations/PILOT_MEASUREMENT.md.
 */
const router = Router();
router.use(requireAuth);
const svc = new InvestigationTimingService(prisma);

const iso = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'must be a date-time');
const Start = z.object({ label: z.string().max(120).optional() }).strict();
const Step = z.object({ kind: z.enum(STEP_KINDS) }).strict();
const Finish = z.object({ outcome: z.enum(OUTCOMES) }).strict();
const ReportQuery = z.object({ from: iso.optional(), to: iso.optional() }).strict();

const fail = (res: Response, err: any) => {
  if (err instanceof TimingError) return res.status(err.status).json({ error: err.message, code: err.code, ...(err.timingId ? { timingId: err.timingId } : {}) });
  return res.status(500).json({ error: err.message });
};
const invalid = (res: Response, e: z.ZodError) => res.status(400).json({ error: `${e.issues[0].path.join('.') || 'body'}: ${e.issues[0].message}`, code: 'INVALID_TIMING_REQUEST' });

router.get('/current', authorize(Permission.RECORDING_VIEW), async (req: Request, res: Response) => {
  try {
    return res.json({ timing: await svc.current(req.user!.tenantId, req.user!.id) });
  } catch (err) {
    return fail(res, err);
  }
});

router.get('/report', authorize(Permission.AUDIT_VIEW), async (req: Request, res: Response) => {
  const p = ReportQuery.safeParse(req.query);
  if (!p.success) return invalid(res, p.error);
  const to = p.data.to ? new Date(p.data.to) : new Date();
  const from = p.data.from ? new Date(p.data.from) : new Date(to.getTime() - 30 * 86_400_000);
  if (from >= to) return res.status(400).json({ error: 'from must be before to', code: 'INVALID_TIMING_REQUEST' });
  try {
    return res.json({ report: await svc.report(req.user!.tenantId, from, to) });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/', authorize(Permission.RECORDING_VIEW), async (req: Request, res: Response) => {
  const p = Start.safeParse(req.body ?? {});
  if (!p.success) return invalid(res, p.error);
  try {
    return res.status(201).json({ timing: await svc.start(req.user!.tenantId, req.user!.id, p.data.label) });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/steps', authorize(Permission.RECORDING_VIEW), async (req: Request, res: Response) => {
  const p = Step.safeParse(req.body);
  if (!p.success) return invalid(res, p.error);
  try {
    return res.json({ timing: await svc.step(req.user!.tenantId, req.user!.id, req.params.id, p.data.kind) });
  } catch (err) {
    return fail(res, err);
  }
});

router.post('/:id/finish', authorize(Permission.RECORDING_VIEW), async (req: Request, res: Response) => {
  const p = Finish.safeParse(req.body);
  if (!p.success) return invalid(res, p.error);
  try {
    return res.json({ timing: await svc.finish(req.user!.tenantId, req.user!.id, req.params.id, p.data.outcome) });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
