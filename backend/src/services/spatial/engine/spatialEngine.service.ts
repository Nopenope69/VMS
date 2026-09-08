import {
  CameraSpatialPlacement,
  DetectionZone,
  EventType,
  Floorplan,
  PrismaClient,
} from '@prisma/client';
import {
  BoundingBox2D,
  CalibrationProfile,
  CameraPlacementParams,
  FovConeGeometry,
  LineSide,
  Point2D,
  SpatialGeometry,
} from './geometry';
import {
  LedgerMetrics,
  LoiteringEvaluationOptions,
  LoiteringResult,
  LoiteringRuleInput,
  TrackObservation,
  TrackStateLedger,
  TrackStateLedgerConfig,
  TripwireCrossingResult,
  TripwireRuleInput,
} from './trackStateLedger';
import {
  ZoneConfigSnapshot,
  ZoneEvaluationResult,
  ZoneEvaluator,
} from './zoneEvaluator';
import {
  CameraPlacementReference,
  FloorplanProjector,
  ProjectEventInput,
  SpatialProjectedEvent,
} from './floorplanProjector';

export interface CreateFloorplanInput {
  tenantId: string;
  siteId?: string;
  name: string;
  imageObjectKey: string;
  geoAnchorLat?: number;
  geoAnchorLng?: number;
  rotationDegrees?: number;
  scalePixelsPerMeter?: number;
  floorLevel?: number;
}

export interface UpdateFloorplanInput {
  name?: string;
  imageObjectKey?: string;
  geoAnchorLat?: number;
  geoAnchorLng?: number;
  rotationDegrees?: number;
  scalePixelsPerMeter?: number;
  floorLevel?: number;
}

export interface UpsertCameraPlacementInput {
  cameraId: string;
  floorplanId: string;
  x: number;
  y: number;
  mountHeightMeters?: number;
  headingDegrees?: number;
  pitchDegrees?: number;
  fovHorizontalDegrees?: number;
  fovVerticalDegrees?: number;
  zoom?: number;
}

export interface EnrichedCameraPlacement extends CameraSpatialPlacement {
  fovGeometry: FovConeGeometry;
  cameraName?: string;
  isOnline?: boolean;
}

export interface EnrichedFloorplan extends Floorplan {
  cameraPlacements: EnrichedCameraPlacement[];
  activeAlarms?: SpatialProjectedEvent[];
}

export interface SpatialSearchQuery {
  tenantId: string;
  cameraId: string;
  startTime: Date;
  endTime: Date;
  boundingBox: BoundingBox2D;
  types?: EventType[];
  minConfidence?: number;
  limit?: number;
}

export interface SpatialSearchResult {
  totalDetections: number;
  clusters: Array<{
    startTime: Date;
    endTime: Date;
    durationSeconds: number;
    peakConfidence: number;
    type: EventType;
    snapshotPath?: string | null;
    detectionCount: number;
  }>;
}

/**
 * Authoritative SpatialEngine Facade.
 * Consolidates all 2D vector geometry, detection zone masking, tripwires,
 * continuous dwell loitering, camera FOV vision cones, floorplan projection,
 * and spatial motion searches behind a single deep module interface.
 */
export class SpatialEngine {
  private prisma: PrismaClient;
  private trackLedger: TrackStateLedger;

  constructor(
    prisma?: PrismaClient,
    config?: { ledgerConfig?: TrackStateLedgerConfig }
  ) {
    this.prisma = prisma || new PrismaClient();
    this.trackLedger = new TrackStateLedger(config?.ledgerConfig);
  }

  // ==========================================
  // 1. Zone Evaluation & Geometry
  // ==========================================

  public static isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    return SpatialGeometry.isPointInPolygon(point, polygon);
  }

  public isPointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
    return SpatialGeometry.isPointInPolygon(point, polygon);
  }

  public static isBBoxInPolygon(bbox: BoundingBox2D, polygon: Point2D[]): boolean {
    return SpatialGeometry.intersectsPolygonBBox(polygon, bbox);
  }

  public isBBoxInPolygon(bbox: BoundingBox2D, polygon: Point2D[]): boolean {
    return SpatialGeometry.intersectsPolygonBBox(polygon, bbox);
  }

  public evaluateDetection(
    detection: Point2D | BoundingBox2D,
    zones: DetectionZone[]
  ): ZoneEvaluationResult {
    return ZoneEvaluator.evaluateDetection(detection, zones);
  }

  public static evaluateDetection(
    detection: Point2D | BoundingBox2D,
    zones: DetectionZone[]
  ): ZoneEvaluationResult {
    return ZoneEvaluator.evaluateDetection(detection, zones);
  }

  public createZoneSnapshot(zones: DetectionZone[]): ZoneConfigSnapshot {
    return ZoneEvaluator.createZoneSnapshot(zones);
  }

  public static createZoneSnapshot(zones: DetectionZone[]): ZoneConfigSnapshot {
    return ZoneEvaluator.createZoneSnapshot(zones);
  }

  // ==========================================
  // 2. Spatial Analytics (Tripwires & Loitering)
  // ==========================================

  public evaluateTripwire(
    rule: TripwireRuleInput,
    track: TrackObservation,
    currentTimeMs: number = Date.now()
  ): TripwireCrossingResult | null {
    return this.trackLedger.evaluateTripwire(rule, track, currentTimeMs);
  }

  public evaluateLoitering(
    rule: LoiteringRuleInput,
    track: TrackObservation,
    currentTimeMs: number = Date.now(),
    options?: LoiteringEvaluationOptions
  ): LoiteringResult | null {
    return this.trackLedger.evaluateLoitering(rule, track, currentTimeMs, options);
  }

  public handleObservationLoss(
    ruleId: string,
    trackId: string,
    currentTimeMs: number = Date.now(),
    observationTimeoutMs: number = 2000
  ): void {
    this.trackLedger.handleDropout(ruleId, trackId, currentTimeMs, observationTimeoutMs);
  }

  public getLedgerMetrics(): LedgerMetrics {
    return this.trackLedger.getMetrics();
  }

  public clearTrackState(): void {
    this.trackLedger.clear();
  }

  // ==========================================
  // 3. Vision Cones & Camera Projection
  // ==========================================

  public calculateFovCone(
    placement: CameraPlacementParams,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): FovConeGeometry {
    return SpatialGeometry.calculateFovCone(
      placement,
      scalePixelsPerMeter,
      calibrationProfile
    );
  }

  public static calculateFovCone(
    placement: CameraPlacementParams,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): FovConeGeometry {
    return SpatialGeometry.calculateFovCone(
      placement,
      scalePixelsPerMeter,
      calibrationProfile
    );
  }

  public isPointInFov(
    placement: CameraPlacementParams,
    point: Point2D,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): boolean {
    return SpatialGeometry.isPointInFov(
      placement,
      point,
      scalePixelsPerMeter,
      calibrationProfile
    );
  }

  public static isPointInFov(
    placement: CameraPlacementParams,
    point: Point2D,
    scalePixelsPerMeter: number = 20.0,
    calibrationProfile?: CalibrationProfile
  ): boolean {
    return SpatialGeometry.isPointInFov(
      placement,
      point,
      scalePixelsPerMeter,
      calibrationProfile
    );
  }

  public projectEvent(
    placement: CameraPlacementReference,
    event: ProjectEventInput
  ): SpatialProjectedEvent {
    return FloorplanProjector.projectEvent(placement, event);
  }

  public static projectEvent(
    placement: CameraPlacementReference,
    event: ProjectEventInput
  ): SpatialProjectedEvent {
    return FloorplanProjector.projectEvent(placement, event);
  }

  // ==========================================
  // 4. Floorplan Entity Management
  // ==========================================

  public async createFloorplan(input: CreateFloorplanInput): Promise<Floorplan> {
    return this.prisma.floorplan.create({
      data: {
        tenantId: input.tenantId,
        siteId: input.siteId,
        name: input.name,
        imageObjectKey: input.imageObjectKey,
        geoAnchorLat: input.geoAnchorLat,
        geoAnchorLng: input.geoAnchorLng,
        rotationDegrees: input.rotationDegrees ?? 0.0,
        scalePixelsPerMeter: input.scalePixelsPerMeter ?? 20.0,
        floorLevel: input.floorLevel ?? 1,
      },
    });
  }

  public async getFloorplan(
    tenantId: string,
    id: string
  ): Promise<Floorplan | null> {
    return this.prisma.floorplan.findFirst({
      where: { id, tenantId },
    });
  }

  public async listFloorplans(
    tenantId: string,
    siteId?: string
  ): Promise<Floorplan[]> {
    return this.prisma.floorplan.findMany({
      where: {
        tenantId,
        ...(siteId ? { siteId } : {}),
      },
      orderBy: [{ floorLevel: 'asc' }, { name: 'asc' }],
    });
  }

  public async updateFloorplan(
    tenantId: string,
    id: string,
    input: UpdateFloorplanInput
  ): Promise<Floorplan> {
    const existing = await this.getFloorplan(tenantId, id);
    if (!existing) {
      throw new Error(`Floorplan ${id} not found`);
    }

    return this.prisma.floorplan.update({
      where: { id },
      data: input,
    });
  }

  public async deleteFloorplan(
    tenantId: string,
    id: string
  ): Promise<Floorplan> {
    const existing = await this.getFloorplan(tenantId, id);
    if (!existing) {
      throw new Error(`Floorplan ${id} not found`);
    }

    return this.prisma.floorplan.delete({
      where: { id },
    });
  }

  public async upsertCameraPlacement(
    tenantId: string,
    input: UpsertCameraPlacementInput
  ): Promise<CameraSpatialPlacement> {
    // Verify floorplan belongs to tenant
    const floorplan = await this.getFloorplan(tenantId, input.floorplanId);
    if (!floorplan) {
      throw new Error(`Floorplan ${input.floorplanId} not found for tenant`);
    }

    // Verify camera belongs to tenant
    const camera = await this.prisma.camera.findFirst({
      where: { id: input.cameraId, tenantId },
    });
    if (!camera) {
      throw new Error(`Camera ${input.cameraId} not found for tenant`);
    }

    return this.prisma.cameraSpatialPlacement.upsert({
      where: { cameraId: input.cameraId },
      create: {
        cameraId: input.cameraId,
        floorplanId: input.floorplanId,
        x: input.x,
        y: input.y,
        mountHeightMeters: input.mountHeightMeters ?? 3.0,
        headingDegrees: input.headingDegrees ?? 0.0,
        pitchDegrees: input.pitchDegrees ?? 30.0,
        fovHorizontalDegrees: input.fovHorizontalDegrees ?? 85.0,
        fovVerticalDegrees: input.fovVerticalDegrees ?? 50.0,
        zoom: input.zoom ?? 1.0,
      },
      update: {
        floorplanId: input.floorplanId,
        x: input.x,
        y: input.y,
        mountHeightMeters: input.mountHeightMeters,
        headingDegrees: input.headingDegrees,
        pitchDegrees: input.pitchDegrees,
        fovHorizontalDegrees: input.fovHorizontalDegrees,
        fovVerticalDegrees: input.fovVerticalDegrees,
        zoom: input.zoom,
      },
    });
  }

  public async removeCameraPlacement(
    tenantId: string,
    cameraId: string
  ): Promise<CameraSpatialPlacement> {
    const placement = await this.prisma.cameraSpatialPlacement.findUnique({
      where: { cameraId },
      include: { floorplan: true },
    });

    if (!placement || placement.floorplan.tenantId !== tenantId) {
      throw new Error(`Camera placement for camera ${cameraId} not found`);
    }

    return this.prisma.cameraSpatialPlacement.delete({
      where: { cameraId },
    });
  }

  public async getFloorplanWithPlacements(
    tenantId: string,
    floorplanId: string
  ): Promise<EnrichedFloorplan | null> {
    const floorplan = await this.prisma.floorplan.findFirst({
      where: { id: floorplanId, tenantId },
      include: {
        cameraPlacements: {
          include: { camera: true },
        },
      },
    });

    if (!floorplan) {
      return null;
    }

    const scale = floorplan.scalePixelsPerMeter || 20.0;
    const enrichedPlacements: EnrichedCameraPlacement[] =
      floorplan.cameraPlacements.map((cp) => {
        const fovGeometry = this.calculateFovCone(cp, scale);
        return {
          ...cp,
          cameraName: (cp as any).camera?.name,
          isOnline: (cp as any).camera?.isOnline,
          fovGeometry,
        };
      });

    // Project unacknowledged active alarms on this floorplan
    const cameraIds = enrichedPlacements.map((p) => p.cameraId);
    const activeAlarms = await this.prisma.alarm.findMany({
      where: {
        tenantId,
        cameraId: { in: cameraIds },
        state: 'ACTIVE',
      },
      take: 20,
    });

    const projectedAlarms: SpatialProjectedEvent[] = [];
    for (const alarm of activeAlarms) {
      if (alarm.cameraId) {
        const placement = enrichedPlacements.find(
          (p) => p.cameraId === alarm.cameraId
        );
        if (placement) {
          projectedAlarms.push(
            this.projectEvent(placement, {
              id: alarm.id,
              type: alarm.title,
              severity: alarm.severity,
              timestampUtc: alarm.triggeredAt,
            })
          );
        }
      }
    }

    return {
      ...floorplan,
      cameraPlacements: enrichedPlacements,
      activeAlarms: projectedAlarms,
    };
  }

  // ==========================================
  // 5. Spatial Motion Forensics Search
  // ==========================================

  public async searchSpatialMotion(
    query: SpatialSearchQuery
  ): Promise<SpatialSearchResult> {
    const minConfidence = query.minConfidence ?? 0.3;
    const limit = query.limit ?? 500;

    const events = await this.prisma.detectionEvent.findMany({
      where: {
        tenantId: query.tenantId,
        cameraId: query.cameraId,
        timestamp: {
          gte: query.startTime,
          lte: query.endTime,
        },
        confidence: { gte: minConfidence },
        ...(query.types && query.types.length > 0
          ? { type: { in: query.types } }
          : {}),
      },
      orderBy: { timestamp: 'asc' },
      take: limit,
    });

    const matchingEvents = events.filter((evt) => {
      if (evt.boundingBox) {
        const box = evt.boundingBox as unknown as BoundingBox2D;
        if (SpatialGeometry.doesAABBIntersect(box, query.boundingBox)) return true;
      }
      if (evt.centroid) {
        const point = evt.centroid as unknown as Point2D;
        if (SpatialGeometry.isPointInAABB(point, query.boundingBox)) return true;
      }
      return false;
    });

    if (matchingEvents.length === 0) {
      return { totalDetections: 0, clusters: [] };
    }

    const clusters: SpatialSearchResult['clusters'] = [];
    let currentCluster: {
      startTime: Date;
      endTime: Date;
      peakConfidence: number;
      type: EventType;
      snapshotPath?: string | null;
      count: number;
    } | null = null;

    for (const evt of matchingEvents) {
      if (!currentCluster) {
        currentCluster = {
          startTime: evt.timestamp,
          endTime: evt.timestamp,
          peakConfidence: evt.confidence,
          type: evt.type,
          snapshotPath: evt.snapshotPath,
          count: 1,
        };
      } else {
        const diffMs =
          evt.timestamp.getTime() - currentCluster.endTime.getTime();
        if (diffMs <= 30000 && evt.type === currentCluster.type) {
          currentCluster.endTime = evt.timestamp;
          currentCluster.count++;
          if (evt.confidence > currentCluster.peakConfidence) {
            currentCluster.peakConfidence = evt.confidence;
            currentCluster.snapshotPath = evt.snapshotPath;
          }
        } else {
          clusters.push({
            startTime: currentCluster.startTime,
            endTime: currentCluster.endTime,
            durationSeconds: Math.max(
              1,
              Math.round(
                (currentCluster.endTime.getTime() -
                  currentCluster.startTime.getTime()) /
                  1000
              )
            ),
            peakConfidence: Number(currentCluster.peakConfidence.toFixed(2)),
            type: currentCluster.type,
            snapshotPath: currentCluster.snapshotPath,
            detectionCount: currentCluster.count,
          });
          currentCluster = {
            startTime: evt.timestamp,
            endTime: evt.timestamp,
            peakConfidence: evt.confidence,
            type: evt.type,
            snapshotPath: evt.snapshotPath,
            count: 1,
          };
        }
      }
    }

    if (currentCluster) {
      clusters.push({
        startTime: currentCluster.startTime,
        endTime: currentCluster.endTime,
        durationSeconds: Math.max(
          1,
          Math.round(
            (currentCluster.endTime.getTime() -
              currentCluster.startTime.getTime()) /
              1000
          )
        ),
        peakConfidence: Number(currentCluster.peakConfidence.toFixed(2)),
        type: currentCluster.type,
        snapshotPath: currentCluster.snapshotPath,
        detectionCount: currentCluster.count,
      });
    }

    return {
      totalDetections: matchingEvents.length,
      clusters,
    };
  }
}

// Canonical singleton instance for application use
export const spatialEngine = new SpatialEngine();
export default spatialEngine;
