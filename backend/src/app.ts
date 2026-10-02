/**
 * Express application assembly (middleware + routes). No listeners and no background workers:
 * server.ts owns the process lifecycle. Tests mount this app to exercise the real routing table.
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config/env';

// Global defense-in-depth polyfill: serialize BigInt primitives to string in JSON.stringify / Express res.json
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};
import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import mediaAuthRoutes from './routes/mediaAuth.routes';
import cameraRoutes from './routes/camera.routes';
import playbackRoutes from './routes/playback.routes';
import evidenceRoutes from './routes/evidence.routes';
import siteRoutes from './routes/site.routes';
import userRoutes from './routes/user.routes';
import eventRoutes from './routes/event.routes';
import auditRoutes from './routes/audit.routes';
import licenseRoutes from './routes/license.routes';
import internalRoutes from './routes/internal.routes';
import metricsRoutes from './routes/metrics.routes';
import layoutRoutes from './routes/layout.routes';
import alarmRoutes from './routes/alarm.routes';
import anprRoutes from './routes/anpr.routes';
import smartSearchRoutes from './routes/smartSearch.routes';
import notificationRoutes from './routes/notification.routes';
import cameraEventsRoutes from './routes/cameraEvents.routes';
import systemRoutes from './routes/system.routes';
import federationRoutes from './routes/federation.routes';
import automationRoutes from './routes/automation.routes';
import spatialAnalyticsRoutes from './routes/spatialAnalytics.routes';
import relayRoutes from './routes/relay.routes';
import accessRoutes from './routes/access.routes';
import archiveRoutes from './routes/archive.routes';
import ssoRoutes from './routes/sso.routes';
import privacyRoutes from './routes/privacy.routes';
import cropPolicyRoutes from './routes/cropPolicy.routes';
import cropSearchRoutes from './routes/cropSearch.routes';
import investigationTimingRoutes from './routes/investigationTiming.routes';
import floorplanRoutes from './routes/floorplan.routes';
import webrtcRoutes from './routes/webrtc.routes';
import storageRoutes from './routes/storage.routes';
import applianceRoutes from './routes/appliance.routes';
import featureRoutes from './routes/feature.routes';
import aiRoutes from './routes/ai.routes';
import { FeatureFlag, requireFeatureFlag } from './config/featureFlags';
import requestLogger from './middleware/requestLogger';

const app = express();

// Configure trust proxy for Caddy reverse proxy to correctly evaluate client IPs
app.set('trust proxy', 1);

// Security & Observability middleware
// Strict Content Security Policy tailored for WebRTC WHEP media egress and same-origin SPA
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:', 'mediastream:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Restricted CORS: Same-origin browser requests do not send an Origin header.
// Cross-origin requests are rejected unless explicitly matching configured management or local appliance host.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowedPatterns = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
      ];
      if (config.MANAGEMENT_IP) {
        allowedPatterns.push(
          new RegExp(`^https?:\\/\\/${config.MANAGEMENT_IP.replace(/\./g, '\\.')}(:\\d+)?$`)
        );
      }
      if (config.LAN_IP) {
        allowedPatterns.push(
          new RegExp(`^https?:\\/\\/${config.LAN_IP.replace(/\./g, '\\.')}(:\\d+)?$`)
        );
      }
      if (allowedPatterns.some((pattern) => pattern.test(origin))) {
        callback(null, true);
      } else {
        callback(new Error('CORS policy: Access denied for this origin.'));
      }
    },
    credentials: true,
  })
);
app.use(
  express.json({
    limit: '10mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(requestLogger);

// Prometheus Metrics Scrape Endpoints
app.use('/metrics', metricsRoutes);
app.use('/api/v1/metrics', metricsRoutes);

// API Routes
app.use('/api/v1', healthRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/media', mediaAuthRoutes);
app.use('/api/v1/cameras', cameraRoutes);
app.use('/api/v1/playback', playbackRoutes);
app.use('/api/v1/evidence', evidenceRoutes);
app.use('/api/v1/sites', siteRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/license', licenseRoutes);
app.use('/api/v1/internal', internalRoutes);
app.use('/api/v1/layouts', layoutRoutes);
app.use('/api/v1/alarms', alarmRoutes);
app.use('/api/v1/anpr', requireFeatureFlag(FeatureFlag.ANPR), anprRoutes);
// Crop search sits under /search but has its own flag; mounted first so the plate-search flag does not govern it.
app.use('/api/v1/search/crops', requireFeatureFlag(FeatureFlag.SEMANTIC_SEARCH), cropSearchRoutes);
app.use('/api/v1/investigations/timings', requireFeatureFlag(FeatureFlag.INVESTIGATION_TIMING), investigationTimingRoutes);
app.use('/api/v1/search', requireFeatureFlag(FeatureFlag.SMART_SEARCH), smartSearchRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/camera-events', requireFeatureFlag(FeatureFlag.CAMERA_EVENTS), cameraEventsRoutes);
app.use('/api/v1/system', systemRoutes);
app.use('/api/v1/features', featureRoutes);
app.use('/api/v1/ai', aiRoutes);
app.use('/api/v1/federation', requireFeatureFlag(FeatureFlag.FEDERATION), federationRoutes);
app.use('/api/v1/automation', automationRoutes);
app.use('/api/v1/spatial-rules', spatialAnalyticsRoutes);
app.use('/api/v1/relays', requireFeatureFlag(FeatureFlag.DIO_RELAY), relayRoutes);
app.use('/api/v1/access', requireFeatureFlag(FeatureFlag.DIO_RELAY), accessRoutes);
app.use('/api/v1/archive', requireFeatureFlag(FeatureFlag.OBJECT_STORAGE_ARCHIVE), archiveRoutes);
app.use('/api/v1/sso', requireFeatureFlag(FeatureFlag.OIDC_SSO), ssoRoutes);
app.use('/api/v1/privacy/jobs', requireFeatureFlag(FeatureFlag.REDACTION));
app.use('/api/v1/privacy', privacyRoutes);
app.use('/api/v1/floorplans', requireFeatureFlag(FeatureFlag.FLOORPLANS), floorplanRoutes);
app.use('/api/v1/crop-policy', requireFeatureFlag(FeatureFlag.OBJECT_CROPS), cropPolicyRoutes);
app.use('/api/v1/webrtc', webrtcRoutes);
app.use('/api/v1/system/storage', storageRoutes);
app.use('/api/v1/system/appliance', applianceRoutes);

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Server Error]', err);
  res.status(err.statusCode || 500).json({ error: err.message || 'Internal Server Error' });
});

export default app;
