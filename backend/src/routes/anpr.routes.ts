import { Router, Request, Response } from 'express';
import { PrismaClient, VehicleCategory, WatchlistCategory, EventSeverity } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import PlateTrackAggregatorService from '../services/anpr/plateTrackAggregator.service';
import EdgeAiRuntimeService from '../services/ai/edgeAiRuntime.service';

const router = Router();
const prisma = new PrismaClient();
const aggregator = new PlateTrackAggregatorService(prisma);
const aiRuntime = new EdgeAiRuntimeService(prisma);

// Background services managed by server lifecycle (server.ts)

router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('ANPR'));

/**
 * List paginated vehicle observation sessions with privacy, rate-limiting & tenant isolation
 */
router.get('/observations', authorize(Permission.ANPR_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 25)));
  const offset = (page - 1) * limit;

  const { cameraId, stateCode, category, watchlistCategory, plateQuery } = req.query;

  try {
    const where: any = { tenantId };

    if (cameraId) where.cameraId = String(cameraId);
    if (stateCode) where.stateCode = String(stateCode).toUpperCase();
    if (category) where.vehicleCategory = category as VehicleCategory;
    if (watchlistCategory) {
      where.matchedWatchlist = { category: watchlistCategory as WatchlistCategory };
    }
    if (plateQuery) {
      const clean = String(plateQuery).toUpperCase().replace(/[^A-Z0-9]/g, '');
      where.normalizedPlate = { contains: clean };
    }

    const [observations, total] = await Promise.all([
      prisma.vehicleObservation.findMany({
        where,
        include: {
          camera: { select: { id: true, name: true } },
          matchedWatchlist: { select: { id: true, category: true, notes: true, ownerName: true } },
        },
        orderBy: { lastSeenAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.vehicleObservation.count({ where }),
    ]);

    return res.json({
      observations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * List vehicle watchlists
 */
router.get('/watchlist', authorize(Permission.ANPR_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { category, active } = req.query;

  try {
    const watchlist = await prisma.vehicleWatchlist.findMany({
      where: {
        tenantId,
        ...(category ? { category: category as WatchlistCategory } : {}),
        ...(active !== undefined ? { active: active === 'true' } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ watchlist });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Add a plate to vehicle watchlist
 */
router.post('/watchlist', authorize(Permission.ANPR_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const {
    plateNumber,
    category = WatchlistCategory.BLACKLIST,
    ownerName,
    notes,
    alertOnMatch = true,
    severity = EventSeverity.CRITICAL,
  } = req.body;

  if (!plateNumber) {
    return res.status(400).json({ error: 'Plate number is required' });
  }

  const { normalizedPlate } = PlateTrackAggregatorService.normalizeIndianPlate(plateNumber);

  try {
    const entry = await prisma.vehicleWatchlist.upsert({
      where: {
        tenantId_normalizedPlate: {
          tenantId,
          normalizedPlate,
        },
      },
      create: {
        tenantId,
        plateNumber: plateNumber.trim().toUpperCase(),
        normalizedPlate,
        category,
        ownerName,
        notes,
        alertOnMatch,
        severity,
        active: true,
      },
      update: {
        category,
        ownerName,
        notes,
        alertOnMatch,
        severity,
        active: true,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'ANPR_WATCHLIST_ADD',
      resourceType: 'VehicleWatchlist',
      resourceId: entry.id,
      ipAddress: req.ip || '127.0.0.1',
      metadata: { plateNumber, normalizedPlate, category },
    });

    return res.json({ success: true, entry });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Delete a plate from vehicle watchlist
 */
router.delete('/watchlist/:id', authorize(Permission.ANPR_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { id } = req.params;

  try {
    const entry = await prisma.vehicleWatchlist.findUnique({ where: { id } });
    if (!entry) {
      return res.status(404).json({ error: 'Watchlist entry not found' });
    }
    assertTenantBoundary(entry.tenantId, tenantId);

    await prisma.vehicleWatchlist.delete({ where: { id } });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: req.user!.id,
      action: 'ANPR_WATCHLIST_DELETE',
      resourceType: 'VehicleWatchlist',
      resourceId: id,
      ipAddress: req.ip || '127.0.0.1',
      metadata: { plateNumber: entry.plateNumber, category: entry.category },
    });

    return res.json({ success: true, message: 'Entry removed from watchlist' });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Direct detection ingestion / testing endpoint for camera feeds
 */
router.post('/detect', authorize(Permission.ANPR_MANAGE), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { cameraId, plateText, confidence = 0.85, vehicleCategory, trackId, snapshotPath } = req.body;

  if (!cameraId || !plateText) {
    return res.status(400).json({ error: 'cameraId and plateText are required' });
  }

  try {
    const camera = await prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    assertTenantBoundary(camera.tenantId, tenantId);

    const result = await aggregator.processDetection({
      tenantId,
      cameraId,
      trackId,
      plateText,
      confidence: Number(confidence),
      vehicleCategory,
      snapshotPath,
    });

    return res.json({ success: true, result });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Get real-time Edge AI inference telemetry
 */
router.get('/health', authorize(Permission.ANPR_VIEW), async (req: Request, res: Response) => {
  try {
    const telemetry = aiRuntime.getTelemetry(req.user!.tenantId);
    return res.json({ telemetry });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export { aggregator, aiRuntime };
export default router;
