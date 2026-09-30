import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { GpioRelayService } from '../services/hardware/gpioRelay.service';

const router = Router();
const relayService = new GpioRelayService(prisma);

/**
 * GET /api/v1/relays
 * List all configured digital I/O pins
 */
router.get(
  '/',
  requireAuth,
  authorize(Permission.RELAY_VIEW),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const pins = await prisma.digitalIoPin.findMany({
        where: { tenantId },
        orderBy: { pinNumber: 'asc' },
      });
      res.json({ pins });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/relays/pins
 * Register or configure a digital I/O pin
 */
router.post(
  '/pins',
  requireAuth,
  authorize(Permission.RELAY_ADMIN),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const { pinNumber, direction, name, activeLow, pulseDurationMs, deviceId, address, confirmationMode, timeoutMs } = req.body;

      if (!pinNumber || !direction || !name) {
        res.status(400).json({ error: 'pinNumber, direction, and name are required' });
        return;
      }
      if (!['INPUT', 'OUTPUT'].includes(direction)) {
        res.status(400).json({ error: 'direction must be INPUT or OUTPUT' });
        return;
      }
      // Phase 7: a pin on an I/O module (Modbus TCP) needs the module (same tenant) and its coil / input address.
      if ((deviceId === undefined || deviceId === null) !== (address === undefined || address === null)) {
        res.status(400).json({ error: 'deviceId and address go together' });
        return;
      }
      if (deviceId && !(await prisma.ioDevice.findFirst({ where: { id: String(deviceId), tenantId } }))) {
        res.status(400).json({ error: 'I/O module not found' });
        return;
      }
      if (address !== undefined && address !== null && (!Number.isInteger(address) || address < 0 || address > 65535)) {
        res.status(400).json({ error: 'address must be an integer 0-65535' });
        return;
      }
      if (confirmationMode !== undefined && !['ACK_ONLY', 'STATE_FEEDBACK'].includes(confirmationMode)) {
        res.status(400).json({ error: 'confirmationMode must be ACK_ONLY or STATE_FEEDBACK' });
        return;
      }
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000)) {
        res.status(400).json({ error: 'timeoutMs must be an integer 100-30000' });
        return;
      }

      const fields = {
        direction,
        name,
        activeLow: Boolean(activeLow),
        pulseDurationMs: pulseDurationMs ? Number(pulseDurationMs) : 3000,
        deviceId: deviceId ? String(deviceId) : null,
        address: address ?? null,
        ...(confirmationMode ? { confirmationMode } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      };
      const pin = await prisma.digitalIoPin.upsert({
        where: {
          tenantId_pinNumber: {
            tenantId,
            pinNumber: Number(pinNumber),
          },
        },
        create: { tenantId, pinNumber: Number(pinNumber), ...fields },
        update: fields,
      });

      res.status(201).json({ pin });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/relays/:pinNumber/trigger
 * Trigger a digital output relay with multi-stage confirmation handshake
 */
router.post(
  '/:pinNumber/trigger',
  requireAuth,
  authorize(Permission.RELAY_CONTROL),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const pinNumber = Number(req.params.pinNumber);
      const { command, pulseDurationMs } = req.body;

      if (!command || !['SET_HIGH', 'SET_LOW', 'PULSE'].includes(command)) {
        res.status(400).json({ error: 'command must be SET_HIGH, SET_LOW, or PULSE' });
        return;
      }

      const result = await relayService.executeRelayCommand({
        tenantId,
        pinNumber,
        command,
        pulseDurationMs: pulseDurationMs ? Number(pulseDurationMs) : undefined,
        issuedBy: req.user!.email,
      });

      if (result.lifecycleState === 'COMMAND_FAILED') {
        res.status(502).json({ error: result.error, result });
        return;
      }

      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  }
);

/**
 * GET /api/v1/relays/logs
 * View relay command audit logs
 */
router.get(
  '/logs',
  requireAuth,
  authorize(Permission.RELAY_VIEW),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const logs = await prisma.relayCommandLog.findMany({
        where: { pin: { tenantId } },
        include: { pin: { select: { pinNumber: true, name: true } } },
        orderBy: { sentAt: 'desc' },
        take: 50,
      });
      res.json({ logs });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

export default router;
