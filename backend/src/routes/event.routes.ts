import { Router } from 'express';
import { PrismaClient, EventSeverity, EventType } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);

// Query events with filters
router.get('/', authorize(Permission.RECORDING_VIEW), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const { cameraId, type, severity, unacknowledgedOnly, limit = '100' } = req.query;

    const where: any = {
      OR: [
        { camera: { tenantId } },
        { rule: { tenantId } },
        { cameraId: null, ruleId: null },
      ],
    };

    if (cameraId) where.cameraId = String(cameraId);
    if (type) where.type = type as EventType;
    if (severity) where.severity = severity as EventSeverity;
    if (unacknowledgedOnly === 'true') where.acknowledged = false;

    const events = await prisma.event.findMany({
      where,
      include: {
        camera: { select: { id: true, name: true, ipAddress: true } },
      },
      orderBy: { startTime: 'desc' },
      take: parseInt(String(limit), 10),
    });

    res.json({ events });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get unacknowledged event stats
router.get('/stats', authorize(Permission.RECORDING_VIEW), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;

    const [critical, warning, info] = await Promise.all([
      prisma.event.count({
        where: {
          acknowledged: false,
          severity: EventSeverity.CRITICAL,
          OR: [{ camera: { tenantId } }, { rule: { tenantId } }],
        },
      }),
      prisma.event.count({
        where: {
          acknowledged: false,
          severity: EventSeverity.WARNING,
          OR: [{ camera: { tenantId } }, { rule: { tenantId } }],
        },
      }),
      prisma.event.count({
        where: {
          acknowledged: false,
          severity: EventSeverity.INFO,
          OR: [{ camera: { tenantId } }, { rule: { tenantId } }],
        },
      }),
    ]);

    res.json({
      unacknowledgedTotal: critical + warning + info,
      critical,
      warning,
      info,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Acknowledge an event
router.patch('/:id/ack', authorize(Permission.RECORDING_VIEW), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const user = (req as any).user;
    const { id } = req.params;

    const event = await prisma.event.findUnique({
      where: { id },
      include: { camera: true },
    });

    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (event.camera && event.camera.tenantId !== tenantId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const updated = await prisma.event.update({
      where: { id },
      data: {
        acknowledged: true,
        acknowledgedAt: new Date(),
        acknowledgedBy: user.name || user.email,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: user.id,
      action: 'EVENT_ACKNOWLEDGE',
      resourceType: 'Event',
      resourceId: event.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { eventTitle: event.title, eventType: event.type, severity: event.severity },
    });

    res.json({ event: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
