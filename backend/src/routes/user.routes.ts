import { Router } from 'express';
import prisma from '../config/database';
import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { authorize, assertTenantBoundary, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();

router.use(requireAuth);

// List users for current tenant
router.get('/', authorize(Permission.USER_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const users = await prisma.user.findMany({
      where: { tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ users });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create new staff member
const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  name: z.string().min(2),
  role: z.enum(['TENANT_ADMIN', 'OPERATOR', 'VIEWER']),
});

router.post('/', authorize(Permission.USER_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const actorId = (req as any).user.id;
    const data = createUserSchema.parse(req.body);

    // Check unique email
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existing) {
      res.status(400).json({ error: 'User with this email already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const user = await prisma.user.create({
      data: {
        tenantId,
        email: data.email,
        passwordHash,
        name: data.name,
        role: data.role as Role,
        active: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        createdAt: true,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: actorId,
      action: 'USER_CREATE',
      resourceType: 'User',
      resourceId: user.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { targetEmail: user.email, targetRole: user.role },
    });

    res.status(201).json({ user });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Update user (change role or toggle active state)
router.patch('/:id', authorize(Permission.USER_MANAGE), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const actorId = (req as any).user.id;
    const { id } = req.params;

    const targetUser = await prisma.user.findUnique({ where: { id } });
    if (!targetUser) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    assertTenantBoundary(targetUser.tenantId, tenantId);

    // Prevent deactivating own account
    if (id === actorId && req.body.active === false) {
      res.status(400).json({ error: 'Cannot deactivate your own administrator account' });
      return;
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        name: req.body.name || undefined,
        role: req.body.role ? (req.body.role as Role) : undefined,
        active: typeof req.body.active === 'boolean' ? req.body.active : undefined,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        active: true,
        updatedAt: true,
      },
    });

    await AuditChainService.record(prisma, {
      tenantId,
      userId: actorId,
      action: typeof req.body.active === 'boolean' && !req.body.active ? 'USER_DEACTIVATE' : 'USER_UPDATE',
      resourceType: 'User',
      resourceId: updated.id,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      metadata: { targetEmail: updated.email, changes: req.body },
    });

    res.json({ user: updated });
  } catch (err: any) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

export default router;
