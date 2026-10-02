import { EventType, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AiProvenanceV1 } from '../../contracts/events.v1';
import { MetricsService } from '../observability/metrics.service';
import { automationRulesVersion } from '../automation/ruleCache';
import { incidentOrchestrator, IncidentOrchestrator, canonicalRow } from '../incident/orchestrator/incidentOrchestrator.service';
import {
  fromAiObjectDetection,
  fromLoiteringResult,
  fromTripwireCrossing,
} from '../incident/orchestrator/events';
import { AiProvenance, VigilOneEvent } from '../incident/orchestrator/types';
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';
import { CropCaptureService } from '../crops/cropCapture.service';
import { Point2D, TripwireRuleInput, LoiteringRuleInput } from '../spatial/engine';
import type { TrackIndexService } from '../tracks/trackIndex.service';

/**
 * AI detection ingestion (POST /internal/detections), Phase 2.
 *
 *  - P2.6 no success without provenance: every detection must carry the events.v1 provenance of
 *    the inference that produced it, and that provenance must name the registered manifest (id and
 *    SHA-256). Anything else is rejected, never stored.
 *  - Idempotent on inferenceId (database unique key).
 *  - CONFIRMED tracks feed the IncidentOrchestrator: one AI_OBJECT_DETECTED event per track
 *    (plus one per minimum-dwell milestone used by an enabled rule), and a TRIPWIRE_CROSS /
 *    LOITERING_DWELL event per spatial incident. Incident and canonical event are written in one
 *    transaction, so a crash between them cannot lose the event (inbox re-drive).
 *  - CONFIRMED detections also update their ObjectTrack (feature TRACK_INDEX, default OFF); a failure there is
 *    logged and counted, and never fails the ingestion.
 *  - Evidence isolation: nothing here touches recordings, segments or evidence manifests.
 */
export class DetectionIngestionError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(message);
  }
}

const Box = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().gt(0).max(1),
  height: z.number().finite().gt(0).max(1),
});

export const DetectionSubmission = z.object({
  tenantId: z.string().min(1),
  cameraId: z.string().min(1),
  modelManifestId: z.string().min(1),
  inferenceId: z.string().min(1),
  type: z.string().min(1),
  confidence: z.number().finite().min(0).max(1),
  boundingBox: Box.optional(),
  centroid: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  trackId: z.string().min(1).optional(),
  trackState: z.enum(['TENTATIVE', 'CONFIRMED', 'LOST', 'TERMINATED']).optional(),
  velocity: z.object({ vx: z.number(), vy: z.number() }).optional(),
  attributesJson: z.record(z.unknown()).optional(),
  timestamp: z.string().optional(),
  snapshotPath: z.string().optional(),
  /** JPEG crop from the worker (AI_ATTACH_CROPS), base64. Used only by the crop store; never persisted on the detection. */
  cropJpegBase64: z.string().max(400_000).optional(),
  objectClass: z.string().min(1).optional(),
  trackFirstSeenAt: z.string().optional(),
  provenance: AiProvenanceV1.optional(),
});
export type DetectionSubmission = z.infer<typeof DetectionSubmission>;

export interface SpatialEngineLike {
  evaluateTripwire(rule: TripwireRuleInput, obs: any, nowMs: number): any;
  evaluateLoitering(rule: LoiteringRuleInput, obs: any, nowMs: number): any;
}

export interface IngestOutcome {
  detectionId: string;
  inferenceId: string;
  duplicate: boolean;
  incidentsCreated: number;
  aiEventsEmitted: number;
}

const INGEST_METRIC = 'vigilone_ai_detections_ingested_total';
const INGEST_HELP = 'AI detections received by the backend, by outcome';

export class DetectionIngestionService {
  /** Event ids already handed to the orchestrator (bounded), to skip repeated DB round trips. */
  private emitted = new Map<string, number>();
  private dwellCache: { at: number; version: number; byTenant: Map<string, number[]> } | null = null;

  constructor(
    private prisma: PrismaClient,
    private getSpatialEngine: () => SpatialEngineLike,
    private orchestrator: Pick<IncidentOrchestrator, 'ingestEvent'> = incidentOrchestrator,
    private cropCapture: Pick<CropCaptureService, 'captureSafely'> = new CropCaptureService(prisma),
    private trackIndex: Pick<TrackIndexService, 'observeSafely'> | null = null
  ) {}

  public async ingest(body: unknown): Promise<IngestOutcome> {
    const parsed = DetectionSubmission.safeParse(body);
    if (!parsed.success) {
      MetricsService.incCounter(INGEST_METRIC, INGEST_HELP, { outcome: 'invalid' });
      const first = parsed.error.issues[0];
      throw new DetectionIngestionError(400, 'INVALID_DETECTION', `${first.path.join('.') || 'body'}: ${first.message}`);
    }
    const d = parsed.data;
    if (!Object.values(EventType).includes(d.type as EventType)) {
      throw new DetectionIngestionError(400, 'INVALID_DETECTION', `Invalid detection type: '${d.type}'. Must be a valid EventType.`);
    }
    if (!d.provenance) {
      MetricsService.incCounter(INGEST_METRIC, INGEST_HELP, { outcome: 'provenance_missing' });
      throw new DetectionIngestionError(400, 'PROVENANCE_REQUIRED', 'AI detections must carry per-inference provenance (events.v1 AiProvenanceV1)');
    }

    const camera = await this.prisma.camera.findFirst({
      where: { OR: [{ id: d.cameraId }, { streamPath: d.cameraId }], tenantId: d.tenantId },
      select: { id: true, tenantId: true },
    });
    if (!camera) throw new DetectionIngestionError(404, 'CAMERA_NOT_FOUND', `Camera '${d.cameraId}' not found for tenant '${d.tenantId}'`);

    const manifest = await this.prisma.modelManifest.findUnique({ where: { id: d.modelManifestId } });
    if (!manifest) throw new DetectionIngestionError(404, 'MODEL_NOT_FOUND', `ModelManifest '${d.modelManifestId}' not found`);
    if (!manifest.isActive) throw new DetectionIngestionError(400, 'MODEL_INACTIVE', `ModelManifest '${d.modelManifestId}' is inactive`);
    if (d.provenance.modelId !== manifest.id || d.provenance.modelSha256 !== manifest.sha256.toLowerCase()) {
      MetricsService.incCounter(INGEST_METRIC, INGEST_HELP, { outcome: 'provenance_mismatch' });
      throw new DetectionIngestionError(
        409,
        'PROVENANCE_MISMATCH',
        `Provenance names model ${d.provenance.modelId} / ${d.provenance.modelSha256}, but manifest ${manifest.id} has SHA-256 ${manifest.sha256}`
      );
    }

    const eventTime = d.timestamp ? new Date(d.timestamp) : new Date(d.provenance.frameTimestampUtc);
    if (Number.isNaN(eventTime.getTime())) throw new DetectionIngestionError(400, 'INVALID_DETECTION', 'timestamp is not a valid date');
    const centroid =
      d.centroid ??
      (d.boundingBox
        ? { x: +(d.boundingBox.x + d.boundingBox.width / 2).toFixed(4), y: +(d.boundingBox.y + d.boundingBox.height / 2).toFixed(4) }
        : undefined);

    // Idempotent on inferenceId. A concurrent retry that loses the race re-reads the winner.
    let detection: { id: string };
    let duplicate = false;
    const existing = await this.prisma.detectionEvent.findUnique({ where: { inferenceId: d.inferenceId }, select: { id: true } });
    if (existing) {
      detection = existing;
      duplicate = true;
    } else {
      try {
        detection = await this.prisma.detectionEvent.create({
          data: {
            tenantId: d.tenantId,
            cameraId: camera.id,
            modelManifestId: manifest.id,
            inferenceId: d.inferenceId,
            type: d.type as EventType,
            confidence: d.confidence,
            boundingBox: d.boundingBox ?? undefined,
            centroid: centroid ?? undefined,
            trackId: d.trackId ?? undefined,
            attributesJson: (d.attributesJson as any) ?? undefined,
            snapshotPath: d.snapshotPath ?? undefined,
            timestamp: eventTime,
            objectClass: d.objectClass ?? undefined,
            modelSha256: d.provenance.modelSha256,
            provenanceJson: d.provenance as any,
          },
          select: { id: true },
        });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        const winner = await this.prisma.detectionEvent.findUnique({ where: { inferenceId: d.inferenceId }, select: { id: true } });
        if (!winner) {
          throw new DetectionIngestionError(409, 'DETECTION_CONFLICT_UNRESOLVED', 'Detection conflicts with an existing record but no row matches this inferenceId');
        }
        detection = winner;
        duplicate = true;
      }
    }
    MetricsService.incCounter(INGEST_METRIC, INGEST_HELP, { outcome: duplicate ? 'duplicate' : 'stored' });

    let incidentsCreated = 0;
    let aiEventsEmitted = 0;
    if (!duplicate && d.trackId && d.trackState === 'CONFIRMED' && centroid) {
      aiEventsEmitted = await this.emitAiObjectEvents(d, camera.id, eventTime, d.provenance);
      incidentsCreated = await this.evaluateSpatialRules(d, camera.id, centroid, eventTime, d.provenance);
    }

    if (!duplicate && this.trackIndex && isFeatureEnabled(FeatureFlag.TRACK_INDEX) && d.trackId && d.trackState === 'CONFIRMED' && d.boundingBox && d.objectClass) {
      await this.trackIndex.observeSafely({
        tenantId: d.tenantId,
        cameraId: camera.id,
        detectionId: detection.id,
        trackId: d.trackId,
        objectClass: d.objectClass,
        confidence: d.confidence,
        boundingBox: d.boundingBox,
        at: eventTime,
        trackFirstSeenAt: d.trackFirstSeenAt && Number.isFinite(Date.parse(d.trackFirstSeenAt)) ? new Date(d.trackFirstSeenAt) : undefined,
        attributes: d.attributesJson,
        modelSha256: d.provenance.modelSha256,
      });
    }

    // Last, so cutting a crop can never delay the events above. captureSafely does not throw and
    // logs and counts its own failures (feature flag OBJECT_CROPS, default OFF).
    if (!duplicate && isFeatureEnabled(FeatureFlag.OBJECT_CROPS)) {
      await this.cropCapture.captureSafely({
        tenantId: d.tenantId,
        cameraId: camera.id,
        detectionId: detection.id,
        objectClass: d.objectClass,
        boundingBox: d.boundingBox,
        snapshotPath: d.snapshotPath,
        cropBytes: d.cropJpegBase64 ? Buffer.from(d.cropJpegBase64, 'base64') : undefined,
        capturedAt: eventTime,
      });
    }

    return { detectionId: detection.id, inferenceId: d.inferenceId, duplicate, incidentsCreated, aiEventsEmitted };
  }

  /** Distinct minimum-dwell milestones of enabled AI object rules per tenant (10 s cache). */
  private async dwellMilestones(tenantId: string): Promise<number[]> {
    const now = Date.now();
    const version = automationRulesVersion();
    if (!this.dwellCache || this.dwellCache.version !== version || now - this.dwellCache.at > 10000) {
      const rules = await this.prisma.automationRule.findMany({
        where: { enabled: true, triggerType: { in: ['PERSON_DETECTED', 'VEHICLE_DETECTED'] } },
        select: { tenantId: true, triggerConfigJson: true },
      });
      const byTenant = new Map<string, number[]>();
      for (const r of rules) {
        const n = Number((r.triggerConfigJson as any)?.minDwellSeconds);
        if (Number.isFinite(n) && n > 0) byTenant.set(r.tenantId, [...new Set([...(byTenant.get(r.tenantId) || []), n])]);
      }
      this.dwellCache = { at: now, version, byTenant };
    }
    return this.dwellCache.byTenant.get(tenantId) || [];
  }

  private async emitAiObjectEvents(d: DetectionSubmission, cameraId: string, at: Date, prov: AiProvenance): Promise<number> {
    const objectClass = d.objectClass;
    if (!objectClass || !d.boundingBox || !d.trackId) return 0;
    const firstSeen = d.trackFirstSeenAt ? Date.parse(d.trackFirstSeenAt) : NaN;
    const dwellSeconds = Number.isFinite(firstSeen) ? Math.max(0, Math.round((at.getTime() - firstSeen) / 100) / 10) : 0;
    const stages: Array<{ stage: 'confirmed' | 'dwell'; seconds: number }> = [{ stage: 'confirmed', seconds: 0 }];
    for (const m of await this.dwellMilestones(d.tenantId)) {
      if (dwellSeconds >= m) stages.push({ stage: 'dwell', seconds: m });
    }
    let n = 0;
    for (const st of stages) {
      const ev = fromAiObjectDetection({
        tenantId: d.tenantId,
        cameraId,
        objectClass,
        confidence: d.confidence,
        bbox: d.boundingBox,
        trackId: d.trackId,
        dwellSeconds,
        stage: st.stage,
        stageSeconds: st.seconds,
        timestampUtc: at,
        provenance: prov,
      });
      if (this.emitted.has(ev.id)) continue;
      await this.dispatch(ev);
      this.remember(ev.id);
      n++;
    }
    return n;
  }

  private async evaluateSpatialRules(
    d: DetectionSubmission,
    cameraId: string,
    centroid: { x: number; y: number },
    at: Date,
    prov: AiProvenance
  ): Promise<number> {
    const engine = this.getSpatialEngine();
    const rules = await this.prisma.spatialAnalyticsRule.findMany({ where: { cameraId, enabled: true } });
    const nowMs = at.getTime();
    const obs = { trackId: d.trackId!, centroid, timestamp: at, cameraId };
    let created = 0;

    for (const rule of rules) {
      let ev: VigilOneEvent | null = null;
      let incidentData: any = null;
      if (rule.type === 'TRIPWIRE' && rule.lineCoordinatesJson) {
        const result = engine.evaluateTripwire(
          { id: rule.id, name: rule.name, direction: rule.direction, lineCoordinates: rule.lineCoordinatesJson as unknown as [Point2D, Point2D], cooldownSeconds: rule.cooldownSeconds },
          obs,
          nowMs
        );
        if (!result) continue;
        const cooldownSec = rule.cooldownSeconds || 10;
        incidentData = {
          ruleType: 'TRIPWIRE',
          cooldownBucket: BigInt(Math.floor(nowMs / (cooldownSec * 1000))),
          title: `Tripwire Breach: ${rule.name}`,
          description: `Track ${d.trackId} crossed tripwire ${rule.name} (${result.directionCrossed})`,
          metadataJson: { directionCrossed: result.directionCrossed, ruleName: rule.name, centroid, inferenceId: d.inferenceId, objectClass: d.objectClass ?? null, provenance: prov },
        };
        ev = fromTripwireCrossing({
          tenantId: d.tenantId,
          cameraId,
          trackId: d.trackId!,
          tripwireId: rule.id,
          direction: result.directionCrossed === 'A_TO_B' ? 'FORWARD' : result.directionCrossed === 'B_TO_A' ? 'BACKWARD' : 'BIDIRECTIONAL',
          provenance: prov,
          title: `Tripwire crossed: ${rule.name}`,
        });
      } else if (rule.type === 'LOITERING' && rule.polygonCoordinatesJson) {
        const threshold = rule.dwellThresholdSeconds ?? 30;
        const result = engine.evaluateLoitering(
          { id: rule.id, name: rule.name, polygon: rule.polygonCoordinatesJson as unknown as Point2D[], dwellThresholdSeconds: threshold, cooldownSeconds: rule.cooldownSeconds },
          obs,
          nowMs
        );
        if (!result) continue;
        const cooldownSec = rule.cooldownSeconds || 30;
        incidentData = {
          ruleType: 'LOITERING',
          cooldownBucket: BigInt(Math.floor(nowMs / (cooldownSec * 1000))),
          title: `Loitering Detected: ${rule.name}`,
          description: `Track ${d.trackId} loitered in ${rule.name} for ${result.dwellDurationSeconds}s`,
          metadataJson: { dwellDurationSeconds: result.dwellDurationSeconds, ruleName: rule.name, centroid, inferenceId: d.inferenceId, objectClass: d.objectClass ?? null, provenance: prov },
        };
        ev = fromLoiteringResult({
          tenantId: d.tenantId,
          cameraId,
          trackId: d.trackId!,
          zoneId: rule.id,
          dwellTimeSeconds: result.dwellDurationSeconds,
          thresholdSeconds: threshold,
          provenance: prov,
          title: `Loitering: ${rule.name}`,
        });
      }
      if (!ev || !incidentData) continue;
      ev.timestampUtc = at;

      try {
        // Incident and canonical event commit together (transactional inbox).
        await this.prisma.$transaction(async (tx: any) => {
          const incident = await tx.incident.create({
            data: { tenantId: d.tenantId, cameraId, ruleId: rule.id, trackId: d.trackId!, timestamp: at, ...incidentData },
          });
          ev!.id = `ev_incident_${incident.id}`;
          ev!.rootEventId = ev!.id;
          await tx.canonicalEvent.create({ data: canonicalRow(ev!) });
        });
      } catch (err: any) {
        // (cameraId, ruleId, trackId, cooldownBucket) unique: the same crossing inside the cooldown.
        if (err?.code === 'P2002') continue;
        throw err;
      }
      created++;
      MetricsService.incCounter('vigilone_spatial_incidents_total', 'Spatial incidents created from AI tracks', { ruleType: incidentData.ruleType });
      await this.dispatch(ev);
    }
    return created;
  }

  /** Hands an event to the orchestrator. The canonical row makes a failure here recoverable. */
  private async dispatch(ev: VigilOneEvent): Promise<void> {
    try {
      await this.orchestrator.ingestEvent(ev);
      MetricsService.incCounter('vigilone_ai_events_dispatched_total', 'AI-derived events handed to the incident orchestrator', { type: ev.type, outcome: 'ok' });
    } catch (err: any) {
      MetricsService.incCounter('vigilone_ai_events_dispatched_total', 'AI-derived events handed to the incident orchestrator', { type: ev.type, outcome: 'error' });
      console.error(`[DetectionIngestion] orchestrator rejected ${ev.type} ${ev.id} (inbox re-drive will retry persisted events):`, err?.message || err);
    }
  }

  private remember(id: string) {
    this.emitted.set(id, Date.now());
    if (this.emitted.size > 20000) {
      const oldest = [...this.emitted.entries()].sort((a, b) => a[1] - b[1]).slice(0, 5000);
      for (const [k] of oldest) this.emitted.delete(k);
    }
  }
}
