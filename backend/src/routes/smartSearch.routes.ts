import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { EventType, VehicleCategory, WatchlistCategory } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import SmartSearchService from '../services/search/smartSearch.service';

const router = Router();
const searchService = new SmartSearchService(prisma);

router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('ADVANCED_SEARCH'));

/**
 * Spatial Motion Forensics: Searches recorded video events intersecting an operator's ROI box
 */
router.post('/spatial-motion', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { cameraId, startTime, endTime, boundingBox, types, minConfidence } = req.body;

  if (!cameraId || !startTime || !endTime || !boundingBox) {
    return res.status(400).json({ error: 'cameraId, startTime, endTime, and boundingBox are required' });
  }

  try {
    const camera = await prisma.camera.findUnique({ where: { id: cameraId } });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    assertTenantBoundary(camera.tenantId, tenantId);

    const result = await searchService.searchSpatialMotion({
      tenantId,
      cameraId,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      boundingBox,
      types: types ? (types as EventType[]) : undefined,
      minConfidence: minConfidence ? Number(minConfidence) : undefined,
    });

    return res.json({ result });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Forensic Plate Search: Fast wildcard querying over VehicleObservations with direct timeline links
 */
router.get('/plates', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const {
    cameraId,
    plateQuery,
    stateCode,
    category,
    watchlistCategory,
    startTime,
    endTime,
    limit = 50,
    offset = 0,
  } = req.query;

  try {
    const result = await searchService.searchPlates({
      tenantId,
      cameraId: cameraId ? String(cameraId) : undefined,
      plateQuery: plateQuery ? String(plateQuery) : undefined,
      stateCode: stateCode ? String(stateCode) : undefined,
      vehicleCategory: category ? (category as VehicleCategory) : undefined,
      watchlistCategory: watchlistCategory ? (watchlistCategory as WatchlistCategory) : undefined,
      startTime: startTime ? new Date(String(startTime)) : undefined,
      endTime: endTime ? new Date(String(endTime)) : undefined,
      limit: Number(limit),
      offset: Number(offset),
    });

    return res.json({ result });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
