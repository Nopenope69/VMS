import { Router, Request, Response } from 'express';
import { PrismaClient, AlarmState, EventSeverity } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense } from '../middleware/license';
import { authorize, Permission } from '../services/rbac/permissions';
import alarmService from '../services/alarm/alarm.service';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(loadTenantLicense);

/**
 * List active & historical alarms for tenant
 */
router.get('/', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  const { state, severity, cameraId } = req.query;

  try {
    const alarms = await alarmService.listAlarms(req.user!.tenantId, {
      state: state as AlarmState,
      severity: severity as EventSeverity,
      cameraId: cameraId as string,
    });

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
    const alarm = await alarmService.acknowledgeAlarm(
      req.params.id,
      req.user!.tenantId,
      req.user!.id
    );

    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'ALARM_ACKNOWLEDGE',
      resourceType: 'Alarm',
      resourceId: alarm.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { alarmTitle: alarm.title, severity: alarm.severity },
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
    const alarm = await alarmService.resolveAlarm(
      req.params.id,
      req.user!.tenantId,
      req.user!.id,
      notes
    );

    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'ALARM_RESOLVE',
      resourceType: 'Alarm',
      resourceId: alarm.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { alarmTitle: alarm.title, notes },
    });

    return res.json({ success: true, alarm });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
