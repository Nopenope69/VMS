import { CameraSpatialPlacement, Floorplan, PrismaClient } from '@prisma/client';
import {
  SpatialEngine,
  CreateFloorplanInput,
  UpdateFloorplanInput,
  UpsertCameraPlacementInput,
  EnrichedCameraPlacement,
  EnrichedFloorplan,
  FovConeGeometry,
  SpatialProjectedEvent,
} from './engine';
import { SpatialProjectionService } from './spatialProjection.service';

export {
  CreateFloorplanInput,
  UpdateFloorplanInput,
  UpsertCameraPlacementInput,
  EnrichedCameraPlacement,
  EnrichedFloorplan,
};

/**
 * Backward-compatibility facade delegating to authoritative SpatialEngine facade.
 */
export class FloorplanService {
  private engine: SpatialEngine;

  constructor(
    prisma: PrismaClient,
    _spatialProjection?: SpatialProjectionService,
    engine?: SpatialEngine
  ) {
    this.engine = engine || new SpatialEngine(prisma);
  }

  public async createFloorplan(input: CreateFloorplanInput): Promise<Floorplan> {
    return this.engine.createFloorplan(input);
  }

  public async getFloorplan(tenantId: string, id: string): Promise<Floorplan | null> {
    return this.engine.getFloorplan(tenantId, id);
  }

  public async listFloorplans(tenantId: string, siteId?: string): Promise<Floorplan[]> {
    return this.engine.listFloorplans(tenantId, siteId);
  }

  public async updateFloorplan(
    tenantId: string,
    id: string,
    input: UpdateFloorplanInput
  ): Promise<Floorplan> {
    return this.engine.updateFloorplan(tenantId, id, input);
  }

  public async deleteFloorplan(tenantId: string, id: string): Promise<Floorplan> {
    return this.engine.deleteFloorplan(tenantId, id);
  }

  public async upsertCameraPlacement(
    tenantId: string,
    input: UpsertCameraPlacementInput
  ): Promise<CameraSpatialPlacement> {
    return this.engine.upsertCameraPlacement(tenantId, input);
  }

  public async removeCameraPlacement(
    tenantId: string,
    cameraId: string
  ): Promise<CameraSpatialPlacement> {
    return this.engine.removeCameraPlacement(tenantId, cameraId);
  }

  public async getFloorplanWithPlacements(
    tenantId: string,
    floorplanId: string
  ): Promise<EnrichedFloorplan | null> {
    return this.engine.getFloorplanWithPlacements(tenantId, floorplanId);
  }
}

export default FloorplanService;
