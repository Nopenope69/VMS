import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { FloorplanService } from '../services/spatial/floorplan.service';

const router = Router();
const prisma = new PrismaClient();
const floorplanService = new FloorplanService(prisma);

router.use(requireAuth);

/**
 * List all floorplans for tenant
 */
router.get('/', async (req: Request, res: Response) => {
  const { siteId } = req.query;
  try {
    const floorplans = await floorplanService.listFloorplans(
      req.user!.tenantId,
      siteId as string | undefined
    );
    return res.json(floorplans);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Create a new floorplan
 */
router.post('/', authorize(Permission.FLOORPLAN_MANAGE), async (req: Request, res: Response) => {
  const {
    siteId,
    name,
    imageObjectKey,
    geoAnchorLat,
    geoAnchorLng,
    rotationDegrees,
    scalePixelsPerMeter,
    floorLevel,
  } = req.body;

  if (!name || !imageObjectKey) {
    return res.status(400).json({ error: 'name and imageObjectKey are required' });
  }

  try {
    const floorplan = await floorplanService.createFloorplan({
      tenantId: req.user!.tenantId,
      siteId,
      name,
      imageObjectKey,
      geoAnchorLat,
      geoAnchorLng,
      rotationDegrees,
      scalePixelsPerMeter,
      floorLevel,
    });
    return res.status(201).json(floorplan);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Get floorplan by ID with enriched camera placements and calculated FOV cones
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const enriched = await floorplanService.getFloorplanWithPlacements(
      req.user!.tenantId,
      req.params.id
    );
    if (!enriched) return res.status(404).json({ error: 'Floorplan not found' });
    return res.json(enriched);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Update floorplan metadata
 */
router.put('/:id', authorize(Permission.FLOORPLAN_MANAGE), async (req: Request, res: Response) => {
  try {
    const updated = await floorplanService.updateFloorplan(
      req.user!.tenantId,
      req.params.id,
      req.body
    );
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Delete a floorplan
 */
router.delete('/:id', authorize(Permission.FLOORPLAN_MANAGE), async (req: Request, res: Response) => {
  try {
    await floorplanService.deleteFloorplan(req.user!.tenantId, req.params.id);
    return res.json({ message: 'Floorplan deleted' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Place or update camera position and FOV orientation on floorplan
 */
router.post('/:id/cameras', authorize(Permission.FLOORPLAN_MANAGE), async (req: Request, res: Response) => {
  const {
    cameraId,
    x,
    y,
    mountHeightMeters,
    headingDegrees,
    pitchDegrees,
    fovHorizontalDegrees,
    fovVerticalDegrees,
    zoom,
  } = req.body;

  if (!cameraId || x === undefined || y === undefined) {
    return res.status(400).json({ error: 'cameraId, x, and y are required' });
  }

  try {
    const placement = await floorplanService.upsertCameraPlacement(req.user!.tenantId, {
      cameraId,
      floorplanId: req.params.id,
      x: Number(x),
      y: Number(y),
      mountHeightMeters: mountHeightMeters !== undefined ? Number(mountHeightMeters) : undefined,
      headingDegrees: headingDegrees !== undefined ? Number(headingDegrees) : undefined,
      pitchDegrees: pitchDegrees !== undefined ? Number(pitchDegrees) : undefined,
      fovHorizontalDegrees: fovHorizontalDegrees !== undefined ? Number(fovHorizontalDegrees) : undefined,
      fovVerticalDegrees: fovVerticalDegrees !== undefined ? Number(fovVerticalDegrees) : undefined,
      zoom: zoom !== undefined ? Number(zoom) : undefined,
    });

    return res.status(201).json(placement);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Remove camera placement from floorplan
 */
router.delete('/:id/cameras/:cameraId', authorize(Permission.FLOORPLAN_MANAGE), async (req: Request, res: Response) => {
  try {
    await floorplanService.removeCameraPlacement(req.user!.tenantId, req.params.cameraId);
    return res.json({ message: 'Camera removed from floorplan' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
