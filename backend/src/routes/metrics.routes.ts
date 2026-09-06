import { Router, Request, Response } from 'express';
import MetricsService from '../services/observability/metrics.service';

const router = Router();

/**
 * GET /metrics or GET /api/v1/metrics
 * Standard Prometheus text-based exposition format 0.0.4
 */
router.get('/', async (req: Request, res: Response) => {
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
