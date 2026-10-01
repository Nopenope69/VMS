/**
 * Phase 7 physical access API (behind DIO_RELAY):
 *
 *   /api/v1/access/io-devices      networked I/O modules (Modbus TCP) that relay and input pins live on
 *   /api/v1/access/doors           doors: a strike relay (output pin) and a door contact (input pin)
 *   POST /doors/:id/unlock         pulses the strike for unlockPulseMs through the relay handshake (audited)
 *
 * Pins are bound to a module with POST /api/v1/relays/pins (deviceId, address). Door state comes only from the
 * door monitor reading the contact (services/access/doorMonitor.ts).
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { MAX_PULSE_MS } from '../services/incident/orchestrator/adapters/relayAdapter';
import { relayAdapter as relay } from '../composition';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();

const deviceSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.literal('MODBUS_TCP').default('MODBUS_TCP'),
    host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.\-:]+$/, 'host must be a hostname or IP address'),
    port: z.number().int().min(1).max(65535).default(502),
    unitId: z.number().int().min(0).max(255).default(1),
    enabled: z.boolean().default(true),
  })
  .strict();

const doorSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    cameraId: z.string().uuid().nullable().optional(),
    strikePinNumber: z.number().int().nullable().optional(),
    contactPinNumber: z.number().int().nullable().optional(),
    contactOpenWhenOn: z.boolean().optional(),
    unlockPulseMs: z.number().int().min(500).max(MAX_PULSE_MS).optional(),
    heldOpenSeconds: z.number().int().min(5).max(3600).optional(),
    unlockGraceSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();

const bad = (res: Response, err: z.ZodError) => res.status(400).json({ error: 'invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });

async function audit(req: Request, action: string, resourceType: string, resourceId: string, metadata: Record<string, unknown>) {
  await AuditChainService.record(prisma, {
    tenantId: req.user!.tenantId,
    userId: req.user!.id,
    action,
    resourceType,
    resourceId,
    ipAddress: req.ip || '127.0.0.1',
    userAgent: req.headers['user-agent'],
    metadata,
  });
}

// ---------------------------------------------------------------- I/O modules

router.get('/io-devices', requireAuth, authorize(Permission.RELAY_VIEW), async (req: Request, res: Response) => {
  const devices = await prisma.ioDevice.findMany({ where: { tenantId: req.user!.tenantId }, orderBy: { name: 'asc' } });
  res.json({ devices });
});

router.post('/io-devices', requireAuth, authorize(Permission.RELAY_ADMIN), async (req: Request, res: Response) => {
  const p = deviceSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const exists = await prisma.ioDevice.findFirst({ where: { tenantId: req.user!.tenantId, name: p.data.name } });
  if (exists) return res.status(409).json({ error: 'an I/O module with this name exists' });
  const device = await prisma.ioDevice.create({ data: { ...p.data, tenantId: req.user!.tenantId } });
  await audit(req, 'IO_DEVICE_CREATED', 'IoDevice', device.id, { name: device.name, host: device.host, port: device.port, unitId: device.unitId });
  res.status(201).json({ device });
});

router.patch('/io-devices/:id', requireAuth, authorize(Permission.RELAY_ADMIN), async (req: Request, res: Response) => {
  const p = deviceSchema.partial().safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const found = await prisma.ioDevice.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!found) return res.status(404).json({ error: 'I/O module not found' });
  const device = await prisma.ioDevice.update({ where: { id: found.id }, data: p.data });
  await audit(req, 'IO_DEVICE_UPDATED', 'IoDevice', device.id, { changes: p.data });
  res.json({ device });
});

router.delete('/io-devices/:id', requireAuth, authorize(Permission.RELAY_ADMIN), async (req: Request, res: Response) => {
  const found = await prisma.ioDevice.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!found) return res.status(404).json({ error: 'I/O module not found' });
  await prisma.ioDevice.delete({ where: { id: found.id } });
  await audit(req, 'IO_DEVICE_DELETED', 'IoDevice', found.id, { name: found.name });
  res.status(204).end();
});

// ---------------------------------------------------------------- doors

const doorView = (d: any) => ({
  id: d.id,
  name: d.name,
  cameraId: d.cameraId,
  state: d.state,
  stateChangedAt: d.stateChangedAt,
  lastUnlockAt: d.lastUnlockAt,
  heldOpenAlertedAt: d.heldOpenAlertedAt,
  contactOpenWhenOn: d.contactOpenWhenOn,
  unlockPulseMs: d.unlockPulseMs,
  heldOpenSeconds: d.heldOpenSeconds,
  unlockGraceSeconds: d.unlockGraceSeconds,
  strikePinNumber: d.strikePin?.pinNumber ?? null,
  contactPinNumber: d.contactPin?.pinNumber ?? null,
  contactModule: d.contactPin?.device ? { id: d.contactPin.device.id, name: d.contactPin.device.name, lastSeenAt: d.contactPin.device.lastSeenAt, lastError: d.contactPin.device.lastError } : null,
});
const doorInclude = { strikePin: true, contactPin: { include: { device: true } } } as const;

/** Resolves pin numbers and the camera within the tenant; returns an error message or the Door columns. */
async function resolveDoorRefs(tenantId: string, body: z.infer<typeof doorSchema>, selfId?: string): Promise<string | Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (body.cameraId !== undefined) {
    if (body.cameraId && !(await prisma.camera.findFirst({ where: { id: body.cameraId, tenantId } }))) return 'camera not found';
    out.cameraId = body.cameraId;
  }
  for (const [key, field, direction] of [
    ['strikePinNumber', 'strikePinId', 'OUTPUT'],
    ['contactPinNumber', 'contactPinId', 'INPUT'],
  ] as const) {
    const n = body[key];
    if (n === undefined) continue;
    if (n === null) {
      out[field] = null;
      continue;
    }
    const pin = await prisma.digitalIoPin.findUnique({ where: { tenantId_pinNumber: { tenantId, pinNumber: n } }, include: { strikeOfDoor: true, contactOfDoor: true } });
    if (!pin) return `pin ${n} not configured`;
    if (pin.direction !== direction) return `pin ${n} is an ${pin.direction} pin; a door ${key === 'strikePinNumber' ? 'strike needs an OUTPUT' : 'contact needs an INPUT'}`;
    const owner = key === 'strikePinNumber' ? pin.strikeOfDoor : pin.contactOfDoor;
    if (owner && owner.id !== selfId) return `pin ${n} already belongs to door "${owner.name}"`;
    out[field] = pin.id;
  }
  for (const k of ['contactOpenWhenOn', 'unlockPulseMs', 'heldOpenSeconds', 'unlockGraceSeconds'] as const) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

router.get('/doors', requireAuth, authorize(Permission.RELAY_VIEW), async (req: Request, res: Response) => {
  const doors = await prisma.door.findMany({ where: { tenantId: req.user!.tenantId }, include: doorInclude, orderBy: { name: 'asc' } });
  res.json({ doors: doors.map(doorView) });
});

router.post('/doors', requireAuth, authorize(Permission.RELAY_ADMIN), async (req: Request, res: Response) => {
  const p = doorSchema.safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const tenantId = req.user!.tenantId;
  if (await prisma.door.findFirst({ where: { tenantId, name: p.data.name } })) return res.status(409).json({ error: 'a door with this name exists' });
  const refs = await resolveDoorRefs(tenantId, p.data);
  if (typeof refs === 'string') return res.status(400).json({ error: refs });
  const door = await prisma.door.create({ data: { tenantId, name: p.data.name, ...refs }, include: doorInclude });
  await audit(req, 'DOOR_CREATED', 'Door', door.id, { name: door.name, strikePinNumber: p.data.strikePinNumber ?? null, contactPinNumber: p.data.contactPinNumber ?? null });
  res.status(201).json({ door: doorView(door) });
});

router.patch('/doors/:id', requireAuth, authorize(Permission.RELAY_ADMIN), async (req: Request, res: Response) => {
  const p = doorSchema.partial().safeParse(req.body);
  if (!p.success) return bad(res, p.error);
  const tenantId = req.user!.tenantId;
  const found = await prisma.door.findFirst({ where: { id: req.params.id, tenantId } });
  if (!found) return res.status(404).json({ error: 'door not found' });
  const refs = await resolveDoorRefs(tenantId, p.data as z.infer<typeof doorSchema>, found.id);
  if (typeof refs === 'string') return res.status(400).json({ error: refs });
  if (p.data.name) refs.name = p.data.name;
  // A new contact means the stored state no longer describes it.
  if ('contactPinId' in refs || 'contactOpenWhenOn' in refs) Object.assign(refs, { state: 'UNKNOWN', stateChangedAt: new Date(), heldOpenAlertedAt: null });
  const door = await prisma.door.update({ where: { id: found.id }, data: refs, include: doorInclude });
  await audit(req, 'DOOR_UPDATED', 'Door', door.id, { changes: p.data });
  res.json({ door: doorView(door) });
});

router.delete('/doors/:id', requireAuth, authorize(Permission.RELAY_ADMIN), async (req: Request, res: Response) => {
  const found = await prisma.door.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId } });
  if (!found) return res.status(404).json({ error: 'door not found' });
  await prisma.door.delete({ where: { id: found.id } });
  await audit(req, 'DOOR_DELETED', 'Door', found.id, { name: found.name });
  res.status(204).end();
});

/**
 * Pulses the strike. lastUnlockAt is set before the pulse so that the door opening during it reads as OPENED,
 * and put back when the module never acknowledged the command (the strike was not energised).
 */
router.post('/doors/:id/unlock', requireAuth, authorize(Permission.RELAY_CONTROL), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const door = await prisma.door.findFirst({ where: { id: req.params.id, tenantId }, include: { strikePin: true } });
  if (!door) return res.status(404).json({ error: 'door not found' });
  if (!door.strikePin) return res.status(409).json({ error: 'this door has no strike relay' });
  const unlockAt = new Date();
  await prisma.door.update({ where: { id: door.id }, data: { lastUnlockAt: unlockAt } });
  const result = await relay.execute({ tenantId, pinNumber: door.strikePin.pinNumber, command: 'PULSE', pulseDurationMs: door.unlockPulseMs, issuedBy: req.user!.email });
  const log = await prisma.relayCommandLog.findUnique({ where: { id: result.logId } });
  if (!log?.acknowledgedAt) await prisma.door.updateMany({ where: { id: door.id, lastUnlockAt: unlockAt }, data: { lastUnlockAt: door.lastUnlockAt } });
  await audit(req, 'DOOR_UNLOCK', 'Door', door.id, { name: door.name, pulseMs: door.unlockPulseMs, relayLogId: result.logId, lifecycleState: result.lifecycleState, error: result.error ?? null });
  if (result.lifecycleState === 'COMMAND_FAILED') return res.status(502).json({ error: result.error, result });
  res.json({ result });
});

export default router;
