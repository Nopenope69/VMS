import { Router, Request, Response } from 'express';
import { AlarmState, EventSeverity } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense } from '../middleware/license';
import { authorize, Permission } from '../services/rbac/permissions';
import path from 'path';
import incidentOrchestrator from '../services/incident/orchestrator/incidentOrchestrator.service';
import prisma from '../config/database';
import { AlarmWorkflowService, WorkflowError, workflowConfigFromEnv } from '../services/incident/workflow/alarmWorkflow.service';
import { EvidenceArchive } from '../services/evidence/archive';
import { AlarmFeedbackService } from '../services/incident/workflow/alarmFeedback.service';
import { AuditChainService } from '../services/audit/auditChain.service';
import { FeatureFlag, isFeatureEnabled } from '../config/featureFlags';
import { vlmAgreement } from '../services/vlm/vlmAgreement.service';

const router = Router();
export const alarmWorkflow = new AlarmWorkflowService(prisma);
const evidenceArchive = new EvidenceArchive(prisma);
const feedback = new AlarmFeedbackService(prisma);

function fail(res: Response, err: any) {
  return res.status(err instanceof WorkflowError ? err.statusCode : err.statusCode || 500).json({ error: err.message });
}

router.use(requireAuth);
router.use(loadTenantLicense);

/**
 * List active & historical alarms for tenant
 */
router.get('/', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  const { state, severity, cameraId } = req.query;

  try {
    const alarms = await incidentOrchestrator.listAlarms(
      {
        state: state as AlarmState,
        severity: severity as EventSeverity,
        cameraId: cameraId as string,
      },
      { tenantId: req.user!.tenantId }
    );

    return res.json({ alarms });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Acknowledge an active alarm
 */
router.post('/:id/acknowledge', authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  try {
    const alarm = await incidentOrchestrator.acknowledgeAlarm(req.params.id, {
      tenantId: req.user!.tenantId,
      actorUserId: req.user!.id,
      clientIp: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, alarm });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Resolve an alarm with operator resolution notes
 */
router.post('/:id/resolve', authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  const { notes = 'Resolved by operator' } = req.body;

  try {
    const alarm = await incidentOrchestrator.resolveAlarm(req.params.id, notes, {
      tenantId: req.user!.tenantId,
      actorUserId: req.user!.id,
      clientIp: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
    });

    return res.json({ success: true, alarm });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Assign (or unassign with userId null) an alarm to an operator. Audited.
 */
router.post('/:id/assign', authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  const { userId } = req.body || {};
  if (userId !== null && typeof userId !== 'string') return res.status(400).json({ error: 'userId (string or null) is required' });
  try {
    const alarm = await alarmWorkflow.assign(req.params.id, userId, { tenantId: req.user!.tenantId, actorUserId: req.user!.id, clientIp: req.ip });
    return res.json({ success: true, alarm });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Evidence holds applied automatically to this alarm (CRITICAL alarms on a camera).
 */
router.get('/:id/holds', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const alarm = await prisma.alarm.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
    if (!alarm || alarm.tenantId !== req.user!.tenantId) return res.status(404).json({ error: 'Alarm not found' });
    const holds = await prisma.incidentEvidenceHold.findMany({ where: { alarmId: req.params.id } });
    return res.json({ holds });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * One-click evidence export for an alarm: the camera and window come from the alarm (the
 * incident hold window when one exists), through the same signed Section 63 BSA package path as
 * /evidence/export. Audited.
 */
router.post('/:id/export', authorize(Permission.EVIDENCE_EXPORT), async (req: Request, res: Response) => {
  try {
    const alarm = await prisma.alarm.findUnique({ where: { id: req.params.id } });
    if (!alarm || alarm.tenantId !== req.user!.tenantId) return res.status(404).json({ error: 'Alarm not found' });
    if (!alarm.cameraId) return res.status(409).json({ error: 'ALARM_HAS_NO_CAMERA: this alarm is not tied to a camera, so there is no video to export', code: 'ALARM_HAS_NO_CAMERA' });
    const hold = await prisma.incidentEvidenceHold.findUnique({ where: { alarmId_cameraId: { alarmId: alarm.id, cameraId: alarm.cameraId } } });
    const cfg = workflowConfigFromEnv();
    const startTime = hold?.windowStart ?? new Date(alarm.triggeredAt.getTime() - cfg.holdPreSeconds * 1000);
    const endTime = hold?.windowEnd ?? new Date(alarm.triggeredAt.getTime() + cfg.holdPostSeconds * 1000);
    const zipPath = await evidenceArchive.processExport({
      tenantId: alarm.tenantId,
      cameraId: alarm.cameraId,
      requestedById: req.user!.id,
      startTime,
      endTime,
      exportMode: 'STREAM_COPY',
    });
    await AuditChainService.record(prisma, {
      tenantId: alarm.tenantId,
      userId: req.user!.id,
      action: 'ALARM_EVIDENCE_EXPORT',
      resourceType: 'Alarm',
      resourceId: alarm.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { cameraId: alarm.cameraId, startTime, endTime, holdId: hold?.id ?? null, zipFilename: path.basename(zipPath) },
    });
    return res.status(201).json({
      downloadUrl: `/api/v1/evidence/download/${path.basename(zipPath)}`,
      filename: path.basename(zipPath),
      window: { startTime, endTime, source: hold ? 'INCIDENT_HOLD' : 'ALARM_DEFAULT' },
    });
  } catch (err: any) {
    if (err.message?.includes('NO_RECORDING_SEGMENTS_FOUND')) return res.status(404).json({ error: err.message, code: 'NO_RECORDING_SEGMENTS_FOUND' });
    return fail(res, err);
  }
});

/**
 * Operator verdict on an alarm (false / true alarm). Changing a verdict is allowed and audited.
 */
router.post('/:id/feedback', authorize(Permission.ALARM_FEEDBACK), async (req: Request, res: Response) => {
  try {
    const row = await feedback.record(req.params.id, req.body, { tenantId: req.user!.tenantId, userId: req.user!.id, clientIp: req.ip });
    return res.json({ feedback: row });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * False-alarm statistics by rule and by model (default: last 30 days).
 */
router.get('/feedback/stats', authorize(Permission.ALARM_FEEDBACK), async (req: Request, res: Response) => {
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) return res.status(400).json({ error: 'from and to must be ISO timestamps with from < to' });
  try {
    return res.json(await feedback.stats(req.user!.tenantId, from, to));
  } catch (err: any) {
    return fail(res, err);
  }
});

function vlmEnabled(res: Response): boolean {
  if (isFeatureEnabled(FeatureFlag.VLM_VERIFICATION)) return true;
  res.status(501).json({ error: 'The alarm second opinion is disabled on this appliance', code: 'FEATURE_DISABLED' });
  return false;
}

/**
 * How the VLM second opinion compares with operator verdicts (default: last 30 days, latest model).
 */
router.get('/second-opinion/agreement', authorize(Permission.ALARM_FEEDBACK), async (req: Request, res: Response) => {
  if (!vlmEnabled(res)) return;
  const to = req.query.to ? new Date(String(req.query.to)) : new Date();
  const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 30 * 86400_000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) return res.status(400).json({ error: 'from and to must be ISO timestamps with from < to' });
  const model = typeof req.query.modelSha256 === 'string' ? req.query.modelSha256 : undefined;
  if (model !== undefined && !/^[a-f0-9]{64}$/.test(model)) return res.status(400).json({ error: 'modelSha256 must be a SHA-256' });
  try {
    return res.json(await vlmAgreement(prisma, req.user!.tenantId, from, to, model));
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * The advisory second opinion(s) recorded for one alarm. Never part of the alarm's state.
 */
router.get('/:id/second-opinion', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  if (!vlmEnabled(res)) return;
  const alarm = await prisma.alarm.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
  if (!alarm || alarm.tenantId !== req.user!.tenantId) return res.status(404).json({ error: 'alarm not found' });
  const rows = await prisma.vlmVerification.findMany({
    where: { alarmId: req.params.id, tenantId: req.user!.tenantId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, targetClass: true, answer: true, reason: true, imageSource: true, imageSha256: true, promptSha256: true, modelName: true, modelVersion: true, modelSha256: true, latencyMs: true, createdAt: true },
  });
  return res.json({ advisory: true, note: 'A local AI model\'s opinion on whether the detected object is in the picture. It does not change the alarm.', secondOpinions: rows });
});

/**
 * SLA policies: acknowledge / resolve deadlines per severity.
 */
router.get('/policies/sla', authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  const policies = await prisma.alarmSlaPolicy.findMany({ where: { tenantId: req.user!.tenantId }, orderBy: { severity: 'asc' } });
  return res.json({ policies });
});

router.put('/policies/sla', authorize(Permission.ALARM_POLICY_MANAGE), async (req: Request, res: Response) => {
  try {
    const policy = await alarmWorkflow.upsertSlaPolicy(req.user!.tenantId, req.user!.id, req.body, req.ip);
    return res.json({ policy });
  } catch (err: any) {
    return fail(res, err);
  }
});

/**
 * Escalation policies: who is notified, and when, while an alarm stays unacknowledged.
 */
router.get('/policies/escalation', authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  const policies = await prisma.escalationPolicy.findMany({ where: { tenantId: req.user!.tenantId }, orderBy: { createdAt: 'desc' } });
  return res.json({ policies });
});

router.post('/policies/escalation', authorize(Permission.ALARM_POLICY_MANAGE), async (req: Request, res: Response) => {
  try {
    const policy = await alarmWorkflow.createEscalationPolicy(req.user!.tenantId, req.user!.id, req.body, req.ip);
    return res.status(201).json({ policy });
  } catch (err: any) {
    return fail(res, err);
  }
});

router.patch('/policies/escalation/:policyId', authorize(Permission.ALARM_POLICY_MANAGE), async (req: Request, res: Response) => {
  try {
    const p = await prisma.escalationPolicy.findUnique({ where: { id: req.params.policyId } });
    if (!p || p.tenantId !== req.user!.tenantId) return res.status(404).json({ error: 'Policy not found' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
    const policy = await prisma.escalationPolicy.update({ where: { id: p.id }, data: { enabled: req.body.enabled } });
    await AuditChainService.record(prisma, {
      tenantId: p.tenantId, userId: req.user!.id, action: req.body.enabled ? 'ESCALATION_POLICY_ENABLE' : 'ESCALATION_POLICY_DISABLE',
      resourceType: 'EscalationPolicy', resourceId: p.id, ipAddress: req.ip || '127.0.0.1', metadata: { name: p.name },
    });
    return res.json({ policy });
  } catch (err: any) {
    return fail(res, err);
  }
});

export default router;
