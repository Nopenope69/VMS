import { Router, Request, Response } from 'express';
import { PrismaClient, GridLayoutType, LayoutVisibility } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense } from '../middleware/license';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);
router.use(loadTenantLicense);

/**
 * List layouts accessible to user (private layouts + tenant-shared layouts)
 */
router.get('/', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const layouts = await prisma.layout.findMany({
      where: {
        tenantId: req.user!.tenantId,
        OR: [
          { visibility: LayoutVisibility.TENANT_SHARED },
          { userId: req.user!.id },
        ],
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return res.json({ layouts });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Create a new layout
 */
router.post('/', authorize(Permission.LAYOUT_MANAGE), async (req: Request, res: Response) => {
  const {
    name,
    gridType = GridLayoutType.GRID_2X2,
    visibility = LayoutVisibility.PRIVATE,
    slotsJson = [],
    isDefault = false,
  } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Layout name is required' });
  }

  try {
    const layout = await prisma.layout.create({
      data: {
        tenantId: req.user!.tenantId,
        userId: req.user!.id,
        name,
        gridType,
        visibility,
        slotsJson,
        isDefault,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'LAYOUT_CREATE',
      resourceType: 'Layout',
      resourceId: layout.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { name: layout.name, gridType: layout.gridType, visibility: layout.visibility },
    });

    return res.status(201).json({ layout });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Get a specific layout
 */
router.get('/:id', authorize(Permission.CAMERA_VIEW), async (req: Request, res: Response) => {
  try {
    const layout = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!layout) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    assertTenantBoundary(layout.tenantId, req.user!.tenantId);

    // If private, ensure owned by user or user is admin
    if (layout.visibility === LayoutVisibility.PRIVATE && layout.userId !== req.user!.id) {
      if (req.user!.role !== 'SUPER_ADMIN' && req.user!.role !== 'TENANT_ADMIN') {
        return res.status(403).json({ error: 'Private layout owned by another operator' });
      }
    }

    return res.json({ layout });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Update a layout
 */
router.put('/:id', authorize(Permission.LAYOUT_MANAGE), async (req: Request, res: Response) => {
  const { name, gridType, visibility, slotsJson, isDefault } = req.body;

  try {
    const layout = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!layout) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    assertTenantBoundary(layout.tenantId, req.user!.tenantId);

    if (layout.userId !== req.user!.id && req.user!.role !== 'SUPER_ADMIN' && req.user!.role !== 'TENANT_ADMIN') {
      return res.status(403).json({ error: 'You do not have permission to edit this layout' });
    }

    const updated = await prisma.layout.update({
      where: { id: req.params.id },
      data: {
        ...(name ? { name } : {}),
        ...(gridType ? { gridType } : {}),
        ...(visibility ? { visibility } : {}),
        ...(slotsJson !== undefined ? { slotsJson } : {}),
        ...(isDefault !== undefined ? { isDefault } : {}),
      },
    });

    return res.json({ layout: updated });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Delete a layout
 */
router.delete('/:id', authorize(Permission.LAYOUT_MANAGE), async (req: Request, res: Response) => {
  try {
    const layout = await prisma.layout.findUnique({ where: { id: req.params.id } });
    if (!layout) {
      return res.status(404).json({ error: 'Layout not found' });
    }

    assertTenantBoundary(layout.tenantId, req.user!.tenantId);

    if (layout.userId !== req.user!.id && req.user!.role !== 'SUPER_ADMIN' && req.user!.role !== 'TENANT_ADMIN') {
      return res.status(403).json({ error: 'You do not have permission to delete this layout' });
    }

    await prisma.layout.delete({ where: { id: req.params.id } });

    await AuditChainService.record(prisma, {
      tenantId: req.user!.tenantId,
      userId: req.user!.id,
      action: 'LAYOUT_DELETE',
      resourceType: 'Layout',
      resourceId: layout.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { name: layout.name },
    });

    return res.json({ success: true, message: `Layout ${layout.name} deleted` });
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

export default router;
