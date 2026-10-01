import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { VehicleCategory, WatchlistCategory, EventSeverity } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import { incidentOrchestrator, plateAggregator as aggregator, edgeAiRuntime as aiRuntime } from '../composition';
import { compilePattern, MatchType, WatchlistPatternError } from '../services/anpr/watchlistMatcher';
import { normalizeIndianPlate, cleanPlateText } from '../contracts/indianPlate.v1';
import { z } from 'zod';
import { requirePurpose, recordSensitiveQuery } from '../services/privacy/dataProtection.service';
import { setting } from '../config/settings';

const router = Router();

// Plate reads become ANPR_MATCH events in the orchestrator (rules: ANPR_WATCHLIST); list entries
// with alertOnMatch raise an audited alarm linked to that event.
aggregator.setEventSink((ev) => incidentOrchestrator.ingestEvent(ev));
aggregator.setAlarmSink((ev, wl) =>
  incidentOrchestrator.elevateAlarm({
    tenantId: ev.tenantId,
    cameraId: ev.cameraId,
    canonicalEventId: ev.id,
    title: `Known plate ${ev.payload.plateText} (${wl.category})`,
    description: wl.notes || undefined,
    severity: wl.severity,
    metadataJson: { plateText: ev.payload.plateText, watchlistId: wl.id, watchlistCategory: wl.category, provenance: ev.provenance ?? null },
  })
);

// Background services managed by server lifecycle (server.ts)

router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('ANPR'));

/**
 * List paginated vehicle observation sessions with privacy, rate-limiting & tenant isolation
 */
router.get('/observations', authorize(Permission.ANPR_VIEW), authorize(Permission.PLATE_DATA_QUERY), requirePurpose(prisma, 'PLATE'), async (req: Request, res: Response) => {
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

    // DPDP (P4.6): every plate query is attributable: who, why, what filters, how many rows.
    await recordSensitiveQuery(prisma, req, 'ANPR_OBSERVATIONS_QUERY', {
      filters: { cameraId: cameraId ?? null, stateCode: stateCode ?? null, category: category ?? null, watchlistCategory: watchlistCategory ?? null, plateQuery: plateQuery ?? null, page, limit },
      resultCount: observations.length,
    });

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
router.get('/watchlist', authorize(Permission.ANPR_VIEW), authorize(Permission.PLATE_DATA_QUERY), requirePurpose(prisma, 'PLATE'), async (req: Request, res: Response) => {
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
    await recordSensitiveQuery(prisma, req, 'ANPR_WATCHLIST_QUERY', { filters: { category: category ?? null, active: active ?? null }, resultCount: watchlist.length });

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
    matchType = 'EXACT',
    category = WatchlistCategory.BLACKLIST,
    ownerName,
    notes,
    alertOnMatch = true,
    severity = EventSeverity.CRITICAL,
  } = req.body;

  if (!plateNumber) {
    return res.status(400).json({ error: 'Plate number is required' });
  }
  if (!['EXACT', 'WILDCARD', 'REGEX'].includes(matchType)) {
    return res.status(400).json({ error: 'matchType must be EXACT, WILDCARD or REGEX' });
  }
  let normalizedPlate: string;
  try {
    if (matchType === 'EXACT') {
      const n = normalizeIndianPlate(plateNumber);
      // A list entry is typed by a person: store what they typed (cleaned) unless it is a valid
      // plate, in which case store the canonical form reads are compared against.
      normalizedPlate = n.valid ? n.normalized : cleanPlateText(plateNumber);
    } else {
      normalizedPlate = String(plateNumber).toUpperCase().replace(/\s+/g, '');
      compilePattern(matchType as MatchType, normalizedPlate);
    }
  } catch (e: any) {
    if (e instanceof WatchlistPatternError) return res.status(400).json({ error: e.message });
    throw e;
  }

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
        plateNumber: String(plateNumber).trim().toUpperCase(),
        normalizedPlate,
        matchType,
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
      metadata: { plateNumber, normalizedPlate, matchType, category },
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
 * LPR camera mode (P4.1): which cameras ANPR runs on, at what rate, inside which region.
 */
const LprConfig = z
  .object({
    lprMode: z.boolean(),
    fps: z.number().min(0.5).max(5).default(2),
    roi: z.array(z.number().min(0).max(1)).length(4).refine((r) => r[2] > r[0] && r[3] > r[1], 'roi is [x1, y1, x2, y2] normalised, x2 > x1, y2 > y1').optional(),
    maxWidth: z.number().int().min(320).max(3840).default(1280),
    minConfidence: z.number().min(0).max(1).default(0.5),
  })
  .strict();

router.put('/cameras/:id/lpr', authorize(Permission.ANPR_MANAGE), async (req: Request, res: Response) => {
  const p = LprConfig.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.')}: ${p.error.issues[0].message}` });
  const camera = await prisma.camera.findUnique({ where: { id: req.params.id } });
  if (!camera || camera.tenantId !== req.user!.tenantId) return res.status(404).json({ error: 'Camera not found' });
  const { lprMode, ...cfg } = p.data;
  const updated = await prisma.camera.update({ where: { id: camera.id }, data: { lprMode, lprConfigJson: cfg as any }, select: { id: true, name: true, lprMode: true, lprConfigJson: true } });
  await AuditChainService.record(prisma, {
    tenantId: camera.tenantId, userId: req.user!.id, action: lprMode ? 'ANPR_LPR_MODE_ENABLE' : 'ANPR_LPR_MODE_DISABLE', resourceType: 'Camera',
    resourceId: camera.id, ipAddress: req.ip || '127.0.0.1', metadata: { ...cfg, previous: { lprMode: camera.lprMode, config: camera.lprConfigJson } },
  });
  return res.json({ camera: updated });
});

/**
 * Synthetic plate-text ingestion. Test builds only (NODE_ENV=test and
 * VIGILONE_ANPR_TEST_ENDPOINT=true): production plate reads come only from the ANPR adapter
 * with provenance (POST /internal/anpr/observations).
 */
if (setting('NODE_ENV') === 'test' && setting('VIGILONE_ANPR_TEST_ENDPOINT')) router.post('/detect', authorize(Permission.ANPR_MANAGE), async (req: Request, res: Response) => {
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
 * ANPR status from recorded facts only: the registered plate_recognition pipeline, the cameras in
 * LPR mode and the reads stored in the last hour. No FPS or latency is reported here; those come
 * from the anpr-worker's own /metrics (vigilone_anpr_*).
 */
router.get('/health', authorize(Permission.ANPR_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const [pipelines, lprCameras, readsLastHour, lastRead] = await Promise.all([
      prisma.modelManifest.findMany({
        where: { task: 'plate_recognition', isActive: true },
        select: { name: true, version: true, sha256: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.camera.findMany({ where: { tenantId, lprMode: true }, select: { id: true, name: true, isOnline: true, lprConfigJson: true } }),
      prisma.vehicleObservation.count({ where: { tenantId, lastSeenAt: { gte: since } } }),
      prisma.vehicleObservation.findFirst({ where: { tenantId }, orderBy: { lastSeenAt: 'desc' }, select: { lastSeenAt: true } }),
    ]);
    return res.json({
      status: {
        pipelines,
        lprCameras,
        readsLastHour,
        lastReadAt: lastRead?.lastSeenAt ?? null,
        checkedAt: new Date(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
