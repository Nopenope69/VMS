import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AiProvenanceV1 } from '../../contracts/events.v1';
import { NormalizedBox } from '../../contracts/common';
import { MetricsService } from '../observability/metrics.service';
import type PlateTrackAggregatorService from './plateTrackAggregator.service';
import type { TrackIndexService } from '../tracks/trackIndex.service';
import { FeatureFlag, isFeatureEnabled } from '../../config/featureFlags';

/**
 * Ingestion of plate reads from the ANPR adapter (P4.1). A read is accepted only with valid
 * provenance naming a registered, active plate_recognition pipeline whose SHA-256 matches, from
 * a camera of that tenant that is in LPR mode. Nothing without provenance reaches the
 * aggregator (the synthetic /anpr/detect endpoint exists in test builds only). With the track index on
 * (feature TRACK_INDEX), each read is then tied to the vehicle track whose box contains the plate.
 */
export const PlateReadV1 = z
  .object({
    plateText: z.string().min(1).max(16),
    rawText: z.string().max(32).optional(),
    confidence: z.number().min(0).max(1),
    bbox: NormalizedBox,
    lines: z.union([z.literal(1), z.literal(2)]).optional(),
    format: z.string().max(20).optional(),
  })
  .strict();

export const AnprObservationBatchV1 = z
  .object({
    tenantId: z.string().min(1),
    cameraId: z.string().min(1),
    frameTimestampUtc: z.string().datetime(),
    plates: z.array(PlateReadV1).max(20),
    provenance: AiProvenanceV1,
  })
  .strict();

export class AnprIngestionError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class AnprIngestionService {
  constructor(
    private prisma: PrismaClient,
    private aggregator: Pick<PlateTrackAggregatorService, 'processDetection'>,
    private trackIndex: Pick<TrackIndexService, 'linkPlateSafely'> | null = null
  ) {}

  async ingest(body: unknown) {
    const p = AnprObservationBatchV1.safeParse(body);
    if (!p.success) {
      MetricsService.incCounter('vigilone_anpr_reads_rejected_total', 'Plate reads refused at ingestion', { reason: 'invalid' });
      throw new AnprIngestionError(400, 'INVALID_OBSERVATION', `${p.error.issues[0].path.join('.')}: ${p.error.issues[0].message}`);
    }
    const b = p.data;
    const manifest = await this.prisma.modelManifest.findUnique({ where: { id: b.provenance.modelId } });
    if (!manifest || manifest.sha256 !== b.provenance.modelSha256 || !manifest.isActive || manifest.task !== 'plate_recognition') {
      MetricsService.incCounter('vigilone_anpr_reads_rejected_total', 'Plate reads refused at ingestion', { reason: 'provenance' });
      throw new AnprIngestionError(422, 'PROVENANCE_UNKNOWN_MODEL', 'provenance does not name a registered, active plate_recognition pipeline with that SHA-256');
    }
    if (!b.provenance.components || b.provenance.components.length === 0) {
      throw new AnprIngestionError(422, 'PROVENANCE_COMPONENTS_REQUIRED', 'ANPR provenance must list the pipeline components');
    }
    const cam = await this.prisma.camera.findUnique({ where: { id: b.cameraId }, select: { tenantId: true, lprMode: true } });
    if (!cam || cam.tenantId !== b.tenantId) throw new AnprIngestionError(404, 'CAMERA_NOT_FOUND', 'camera not found for tenant');
    if (!cam.lprMode) {
      MetricsService.incCounter('vigilone_anpr_reads_rejected_total', 'Plate reads refused at ingestion', { reason: 'not_lpr_camera' });
      throw new AnprIngestionError(409, 'CAMERA_NOT_IN_LPR_MODE', 'camera is not in LPR mode');
    }
    const results = [];
    const at = new Date(b.frameTimestampUtc);
    const linkTracks = this.trackIndex && isFeatureEnabled(FeatureFlag.TRACK_INDEX);
    for (const r of b.plates) {
      const result = await this.aggregator.processDetection({
        tenantId: b.tenantId,
        cameraId: b.cameraId,
        plateText: r.plateText,
        rawText: r.rawText,
        confidence: r.confidence,
        lines: r.lines,
        timestamp: at,
        provenance: b.provenance as any,
      });
      results.push(result);
      if (linkTracks) await this.trackIndex!.linkPlateSafely({ tenantId: b.tenantId, cameraId: b.cameraId, at, plateBox: r.bbox, vehicleObservationId: result.observationId });
    }
    MetricsService.incCounter('vigilone_anpr_reads_ingested_total', 'Plate reads accepted', undefined, b.plates.length);
    return results;
  }
}
