import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();
const prisma = new PrismaClient();

router.use(requireAuth);

// List sites for current tenant
router.get('/', async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const sites = await prisma.site.findMany({
      where: { tenantId },
      include: {
        _count: {
          select: { cameras: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ sites });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create site
const createSiteSchema = z.object({
  name: z.string().min(2),
  timezone: z.string().default('Asia/Kolkata'),
  address: z.string().optional(),
});

router.post('/', authorize(Permission.SITE_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const userId = (req as any).user.id;
    const data = createSiteSchema.parse(req.body);

    const site = await prisma.site.create({
      data: {
        tenantId,
        name: data.name,
        timezone: data.timezone,
        address: data.address,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId,
      action: 'SITE_CREATE',
      resourceType: 'Site',
      resourceId: site.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { siteName: site.name, timezone: site.timezone },
    });

    res.status(201).json({ site });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update site
router.patch('/:id', authorize(Permission.SITE_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const userId = (req as any).user.id;
    const { id } = req.params;

    const existing = await prisma.site.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }

    assertTenantBoundary(existing.tenantId, tenantId);

    const site = await prisma.site.update({
      where: { id },
      data: {
        name: req.body.name || undefined,
        timezone: req.body.timezone || undefined,
        address: req.body.address || undefined,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId,
      action: 'SITE_UPDATE',
      resourceType: 'Site',
      resourceId: site.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { updatedFields: req.body },
    });

    res.json({ site });
  } catch (err: any) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// Delete site
router.delete('/:id', authorize(Permission.SITE_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const userId = (req as any).user.id;
    const { id } = req.params;

    const existing = await prisma.site.findUnique({
      where: { id },
      include: { _count: { select: { cameras: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: 'Site not found' });
      return;
    }

    assertTenantBoundary(existing.tenantId, tenantId);

    if (existing._count.cameras > 0) {
      res.status(400).json({
        error: `Cannot delete site containing ${existing._count.cameras} cameras. Move or delete cameras first.`,
      });
      return;
    }

    await prisma.site.delete({ where: { id } });

    await AuditChainService.record(prisma, {
      tenantId,
      userId,
      action: 'SITE_DELETE',
      resourceType: 'Site',
      resourceId: id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { deletedSiteName: existing.name },
    });

    res.json({ success: true });
  } catch (err: any) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

export default router;
