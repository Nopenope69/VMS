import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { ModelRegistryService, ModelRegistryError } from '../services/ai/modelRegistry.service';

/**
 * AI model registry for operators (P2.6):
 *   GET  /api/v1/ai/status            deployed model + evaluation state (drives the NOT EVALUATED banner)
 *   GET  /api/v1/ai/models            registered manifests
 *   POST /api/v1/ai/models/:id/deploy { reason }        SUPER_ADMIN, audited (MODEL_DEPLOY)
 *   POST /api/v1/ai/models/rollback   { task?, reason } SUPER_ADMIN, audited (MODEL_ROLLBACK)
 */
const router = Router();
router.use(requireAuth);
const registry = () => new ModelRegistryService(prisma);

function summary(m: any) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    sha256: m.sha256,
    task: m.task,
    codeLicense: m.codeLicense,
    weightLicense: m.weightLicense,
    weightsSource: m.weightsSource,
    isActive: m.isActive,
    deployed: m.deployed,
    deployedAt: m.deployedAt,
    evaluation: m.evaluationJson ?? null,
    evaluationStatus: m.evaluationJson ? 'EVALUATED' : 'NOT_EVALUATED',
  };
}

router.get('/status', authorize(Permission.CAMERA_VIEW), async (_req: Request, res: Response) => {
  try {
    const deployed = await registry().getDeployed('object_detection');
    return res.json({
      objectDetection: deployed ? summary(deployed) : null,
      // AI events from a model without a published evaluation on real site data are experimental.
      experimental: !deployed || !deployed.evaluationJson,
      banner: !deployed
        ? 'AI detection is not deployed on this appliance.'
        : !deployed.evaluationJson
        ? `NOT EVALUATED: ${deployed.name} ${deployed.version} has no measured precision/recall on real site data. AI events are experimental.`
        : null,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to read AI status' });
  }
});

router.get('/models', authorize(Permission.CAMERA_VIEW), async (_req: Request, res: Response) => {
  try {
    return res.json({ models: (await registry().list()).map(summary) });
  } catch {
    return res.status(500).json({ error: 'Failed to list models' });
  }
});

router.post('/models/:id/deploy', authorize(Permission.AI_MODEL_MANAGE), async (req: Request, res: Response) => {
  try {
    const m = await registry().deploy(req.params.id, { userId: req.user!.id, reason: String(req.body?.reason || ''), ipAddress: req.ip });
    return res.json({ model: summary(m) });
  } catch (err: any) {
    if (err instanceof ModelRegistryError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    console.error('Model deploy failed:', err);
    return res.status(500).json({ error: 'Failed to deploy model' });
  }
});

router.post('/models/rollback', authorize(Permission.AI_MODEL_MANAGE), async (req: Request, res: Response) => {
  try {
    const task = typeof req.body?.task === 'string' && req.body.task ? req.body.task : 'object_detection';
    const m = await registry().rollback(task, { userId: req.user!.id, reason: String(req.body?.reason || ''), ipAddress: req.ip });
    return res.json({ model: summary(m) });
  } catch (err: any) {
    if (err instanceof ModelRegistryError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    console.error('Model rollback failed:', err);
    return res.status(500).json({ error: 'Failed to roll back model' });
  }
});

export default router;
