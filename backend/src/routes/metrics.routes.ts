import { Router, Request, Response } from 'express';
import MetricsService from '../services/observability/metrics.service';
import config from '../config/env';

const router = Router();

export function isInternalOrAuthorized(req: Request): boolean {
  if (config.METRICS_AUTH_TOKEN) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader === `Bearer ${config.METRICS_AUTH_TOKEN}`) {
      return true;
    }
  }

  const clientIp = req.ip || req.socket?.remoteAddress || '';
  const effectiveIp = clientIp || '127.0.0.1';
  const cleanIp = effectiveIp.replace(/^::ffff:/, '');

  if (
    cleanIp === '127.0.0.1' ||
    cleanIp === '::1' ||
    cleanIp.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(cleanIp)
  ) {
    return true;
  }

  return false;
}

/**
 * GET /metrics or GET /api/v1/metrics
 * Standard Prometheus text-based exposition format 0.0.4.
 * Restricted to internal monitoring network or valid METRICS_AUTH_TOKEN.
 */
router.get('/', async (req: Request, res: Response) => {
  if (!isInternalOrAuthorized(req)) {
    return res.status(403).send('Forbidden: External metrics scrape prohibited\n');
  }

  try {
    const payload = await MetricsService.scrapeMetrics();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(payload);
  } catch (err: any) {
    console.error('[MetricsRoute] Error generating metrics scrape:', err);
    res.status(500).send(`# Error generating metrics: ${err.message}\n`);
  }
});

export default router;
