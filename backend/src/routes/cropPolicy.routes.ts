import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { DATA_PURPOSES, PURPOSES_NEEDING_REFERENCE } from '../services/privacy/dataProtection.service';
import { CropPolicyError, getSiteCropPolicy, SiteCropPolicyPatch, updateSiteCropPolicy } from '../services/crops/siteCropPolicy.service';

/** /api/v1/crop-policy/:siteId, behind VIGILONE_FEATURE_OBJECT_CROPS (app.ts). Person crops are off until a site enables them here. */
const router = Router();
router.use(requireAuth);

const fail = (res: Response, err: any) => {
  if (err instanceof CropPolicyError) return res.status(err.status).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: err.message });
};

router.get('/:siteId', authorize(Permission.PRIVACY_POLICY_MANAGE), async (req: Request, res: Response) => {
  try {
    const policy = await getSiteCropPolicy(prisma, req.user!.tenantId, req.params.siteId);
    return res.json({ policy, purposes: DATA_PURPOSES, needReference: PURPOSES_NEEDING_REFERENCE });
  } catch (err) {
    return fail(res, err);
  }
});

router.put('/:siteId', authorize(Permission.PRIVACY_POLICY_MANAGE), async (req: Request, res: Response) => {
  const p = SiteCropPolicyPatch.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.') || 'body'}: ${p.error.issues[0].message}`, code: 'INVALID_POLICY' });
  try {
    const { after } = await updateSiteCropPolicy(prisma, req.user!.tenantId, req.params.siteId, req.user!.id, p.data, req.ip || '127.0.0.1');
    return res.json({ policy: after });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
