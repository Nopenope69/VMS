import { PrismaClient, EventType, VehicleCategory, WatchlistCategory } from '@prisma/client';
import { BoundingBox, Centroid } from '../ai/edgeAiRuntime.service';
import {
  SpatialEngine,
  SpatialGeometry,
  SpatialSearchQuery,
  SpatialSearchResult,
} from '../spatial/engine';

export { SpatialSearchQuery, SpatialSearchResult };

export interface PlateSearchQuery {
  tenantId: string;
  cameraId?: string;
  plateQuery?: string;     // e.g. "DL*1234", "MH12", "KA"
  stateCode?: string;      // e.g. "DL", "MH"
  vehicleCategory?: VehicleCategory;
  watchlistCategory?: WatchlistCategory;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
  offset?: number;
}

export class SmartSearchService {
  private prisma: PrismaClient;
  private spatialEngine: SpatialEngine;

  constructor(prisma: PrismaClient, spatialEngine?: SpatialEngine) {
    this.prisma = prisma;
    this.spatialEngine = spatialEngine || new SpatialEngine(this.prisma);
  }

  /**
   * Evaluates AABB intersection between two normalized bounding boxes.
   */
  public static doesIntersect(a: BoundingBox, b: BoundingBox): boolean {
    return SpatialGeometry.doesAABBIntersect(a, b);
  }

  /**
   * Evaluates if a point/centroid is inside a bounding box.
   */
  public static isInside(point: Centroid, box: BoundingBox): boolean {
    return SpatialGeometry.isPointInAABB(point, box);
  }

  /**
   * Spatial motion forensics search: Finds detections whose spatial coordinates
   * intersect with the operator's drawn region of interest (ROI) box.
   */
  public async searchSpatialMotion(query: SpatialSearchQuery): Promise<SpatialSearchResult> {
    return this.spatialEngine.searchSpatialMotion(query);
  }

  /**
   * License Plate Forensic Query: Supports wildcards (e.g. DL*1234), state filters, and date ranges.
   */
  public async searchPlates(query: PlateSearchQuery): Promise<{
    observations: any[];
    total: number;
  }> {
    const limit = Math.min(query.limit ?? 50, 100);
    const offset = query.offset ?? 0;

    const where: any = {
      tenantId: query.tenantId,
    };

    if (query.cameraId) {
      where.cameraId = query.cameraId;
    }

    if (query.stateCode) {
      where.stateCode = query.stateCode.toUpperCase();
    }

    if (query.vehicleCategory) {
      where.vehicleCategory = query.vehicleCategory;
    }

    if (query.startTime || query.endTime) {
      where.lastSeenAt = {};
      if (query.startTime) where.lastSeenAt.gte = query.startTime;
      if (query.endTime) where.lastSeenAt.lte = query.endTime;
    }

    if (query.plateQuery) {
      const cleanQuery = query.plateQuery.toUpperCase().replace(/[^A-Z0-9*]/g, '');
      if (cleanQuery.includes('*')) {
        // Translate wildcard * into standard search filter
        const regexStr = cleanQuery.replace(/\*/g, '.*');
        // Prisma regex or contains
        const parts = cleanQuery.split('*').filter(Boolean);
        if (parts.length === 1) {
          where.normalizedPlate = { contains: parts[0] };
        } else if (parts.length > 1) {
          where.AND = parts.map((p) => ({ normalizedPlate: { contains: p } }));
        }
      } else {
        where.normalizedPlate = { contains: cleanQuery };
      }
    }

    if (query.watchlistCategory) {
      where.matchedWatchlist = {
        category: query.watchlistCategory,
      };
    }

    const [observations, total] = await Promise.all([
      this.prisma.vehicleObservation.findMany({
        where,
        include: {
          camera: { select: { id: true, name: true } },
          matchedWatchlist: { select: { id: true, category: true, notes: true, ownerName: true } },
        },
        orderBy: { lastSeenAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.vehicleObservation.count({ where }),
    ]);

    return { observations, total };
  }
}

export default SmartSearchService;
