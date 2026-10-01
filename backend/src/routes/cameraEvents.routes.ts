import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import { cameraEventManager } from '../composition';

/**
 * Camera-native event sources (P3.1/P3.2). Mounted behind VIGILONE_FEATURE_CAMERA_EVENTS.
 */
const router = Router();

router.use(requireAuth);

const CreateSource = z
  .object({
    cameraId: z.string().uuid(),
    protocol: z.enum(['ONVIF_PULLPOINT', 'HIKVISION_ISAPI', 'DAHUA_EVENT_MANAGER']),
    enabled: z.boolean().default(true),
  })
  .strict();

function view(s: any) {
  return { ...s, runtime: cameraEventManager.runtime(s.id) };
}

router.get('/sources', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  const sources = await prisma.cameraEventSource.findMany({ where: { tenantId: req.user!.tenantId }, include: { camera: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
  return res.json({ sources: sources.map(view) });
});

router.post('/sources', authorize(Permission.CAMERA_CONFIG), async (req: Request, res: Response) => {
  const p = CreateSource.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.')}: ${p.error.issues[0].message}` });
  const cam = await prisma.camera.findFirst({ where: { id: p.data.cameraId, tenantId: req.user!.tenantId } });
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  if (await prisma.cameraEventSource.findUnique({ where: { cameraId_protocol: { cameraId: cam.id, protocol: p.data.protocol } } })) {
    return res.status(409).json({ error: 'This camera already has a source for that protocol' });
  }
  try {
    const s = await prisma.cameraEventSource.create({ data: { tenantId: cam.tenantId, cameraId: cam.id, protocol: p.data.protocol, enabled: p.data.enabled } });
    await AuditChainService.record(prisma, {
      tenantId: cam.tenantId, userId: req.user!.id, action: 'CAMERA_EVENT_SOURCE_CREATE', resourceType: 'CameraEventSource', resourceId: s.id,
      ipAddress: req.ip || '127.0.0.1', metadata: { cameraId: cam.id, protocol: s.protocol, enabled: s.enabled },
    });
    return res.status(201).json({ source: view(s) });
  } catch (e: any) {
    if (e.code === 'P2002') return res.status(409).json({ error: 'This camera already has a source for that protocol' });
    return res.status(500).json({ error: e.message });
  }
});

/** Enable / disable; any change also clears FAILED so the source is retried. */
router.patch('/sources/:id', authorize(Permission.CAMERA_CONFIG), async (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) is required' });
  const s = await prisma.cameraEventSource.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!s) return res.status(404).json({ error: 'Source not found' });
  const updated = await prisma.cameraEventSource.update({ where: { id: s.id }, data: { enabled: req.body.enabled, status: 'STOPPED', lastError: null } });
  await AuditChainService.record(prisma, {
    tenantId: s.tenantId, userId: req.user!.id, action: req.body.enabled ? 'CAMERA_EVENT_SOURCE_ENABLE' : 'CAMERA_EVENT_SOURCE_DISABLE', resourceType: 'CameraEventSource',
    resourceId: s.id, ipAddress: req.ip || '127.0.0.1', metadata: { cameraId: s.cameraId, protocol: s.protocol, previousStatus: s.status, previousError: s.lastError },
  });
  await cameraEventManager.reconcile().catch(() => undefined);
  return res.json({ source: view(updated) });
});

router.delete('/sources/:id', authorize(Permission.CAMERA_CONFIG), async (req: Request, res: Response) => {
  const s = await prisma.cameraEventSource.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!s) return res.status(404).json({ error: 'Source not found' });
  await prisma.cameraEventSource.delete({ where: { id: s.id } });
  await AuditChainService.record(prisma, {
    tenantId: s.tenantId, userId: req.user!.id, action: 'CAMERA_EVENT_SOURCE_DELETE', resourceType: 'CameraEventSource', resourceId: s.id,
    ipAddress: req.ip || '127.0.0.1', metadata: { cameraId: s.cameraId, protocol: s.protocol },
  });
  await cameraEventManager.reconcile().catch(() => undefined);
  return res.json({ success: true });
});

export default router;
