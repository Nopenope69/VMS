import { Router } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';

const router = Router();

router.use(requireAuth);

// List audit events
router.get('/', authorize(Permission.AUDIT_VIEW), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const { action, limit = '100', offset = '0' } = req.query;

    const where: any = { tenantId };
    if (action) where.action = String(action);

    const [events, total] = await Promise.all([
      prisma.auditEvent.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
        orderBy: { sequenceNumber: 'desc' },
        take: parseInt(String(limit), 10),
        skip: parseInt(String(offset), 10),
      }),
      prisma.auditEvent.count({ where }),
    ]);

    // Format sequenceNumber (BigInt) for JSON serialization
    const serialized = events.map((e) => ({
      ...e,
      sequenceNumber: e.sequenceNumber.toString(),
    }));

    res.json({ events: serialized, total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Verify cryptographic integrity of the entire audit chain
router.get('/verify', authorize(Permission.AUDIT_VIEW), async (req, res) => {
  try {
    const tenantId = (req as any).user.tenantId;
    const verification = await AuditChainService.verifyChain(prisma, tenantId);

    res.json({
      tenantId,
      tamperEvidentStatus: verification.valid ? 'INTACT' : 'TAMPERED',
      verifiedCount: verification.verifiedCount,
      brokenSequence: verification.brokenSequence?.toString(),
      error: verification.error,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
