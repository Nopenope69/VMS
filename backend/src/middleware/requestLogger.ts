import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import MetricsService from '../services/observability/metrics.service';

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startHrTime = process.hrtime();
  const startTimeMs = Date.now();

  // Assign or preserve Correlation ID
  const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as any).requestId = requestId;

  res.on('finish', () => {
    const elapsedHrTime = process.hrtime(startHrTime);
    const durationSeconds = elapsedHrTime[0] + elapsedHrTime[1] / 1e9;
    const durationMs = Math.round(durationSeconds * 1000 * 100) / 100;

    // Normalize route pattern for metric grouping (avoid high cardinality from IDs)
    let routePattern = req.baseUrl || req.path;
    if (req.route?.path) {
      routePattern = `${req.baseUrl || ''}${req.route.path}`;
    }
    // Collapse dynamic UUIDs/hex IDs in path
    routePattern = routePattern.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
    routePattern = routePattern.replace(/c[a-z0-9]{20,}/gi, ':id');

    // Record metrics in Prometheus engine
    MetricsService.recordHttpRequest(req.method, routePattern, res.statusCode, durationSeconds);

    // Suppress high-frequency polling logs unless response failed (status >= 400)
    const isLivenessPoll = req.path === '/api/v1/health' || req.path === '/metrics' || req.path === '/api/v1/metrics';
    if (!isLivenessPoll || res.statusCode >= 400) {
      const logLine = {
        timestamp: new Date(startTimeMs).toISOString(),
        level: res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO',
        requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        route: routePattern,
        status: res.statusCode,
        durationMs,
        ip: req.ip || req.socket.remoteAddress,
        userAgent: req.headers['user-agent'] || 'unknown',
      };
      console.log(JSON.stringify(logLine));
    }
  });

  next();
}

export default requestLogger;
