import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { ALL_FEATURE_FLAGS, FEATURE_FLAGS, isFeatureEnabled } from '../config/featureFlags';

const router = Router();

/**
 * Feature-flag states for the operator console. The frontend hides navigation for disabled
 * subsystems; the backend still enforces 501 FEATURE_DISABLED on the routes themselves.
 */
router.get('/', requireAuth, (_req: Request, res: Response) => {
  const features = ALL_FEATURE_FLAGS.map((flag) => ({
    flag,
    enabled: isFeatureEnabled(flag),
    title: FEATURE_FLAGS[flag].title,
    status: FEATURE_FLAGS[flag].status,
  }));
  res.status(200).json({ features });
});

export default router;
