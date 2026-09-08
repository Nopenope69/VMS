import { PrismaClient, TripwireDirection } from '@prisma/client';
import {
  SpatialEngine,
  Point2D,
  TrackObservation,
  LineSide,
  TripwireCrossingResult,
  LoiteringResult,
} from '../spatial/engine';

export {
  Point2D,
  TrackObservation,
  LineSide,
  TripwireCrossingResult,
  LoiteringResult,
};

/**
 * Backward-compatibility facade delegating to authoritative SpatialEngine facade.
 */
export class SpatialAnalyticsService {
  private prisma: PrismaClient;
  private engine: SpatialEngine;

  constructor(prisma: PrismaClient, engine?: SpatialEngine) {
    this.prisma = prisma;
    this.engine = engine || new SpatialEngine(this.prisma);
  }

  /**
   * Evaluates tripwire crossing using SpatialEngine facade.
   */
  public evaluateTripwire(
    rule: {
      id: string;
      name: string;
      direction: TripwireDirection;
      lineCoordinates: [Point2D, Point2D];
      cooldownSeconds?: number;
    },
    track: TrackObservation,
    currentTimeMs: number = Date.now()
  ): TripwireCrossingResult | null {
    return this.engine.evaluateTripwire(rule, track, currentTimeMs);
  }

  /**
   * Evaluates continuous loitering dwell time using SpatialEngine facade.
   */
  public evaluateLoitering(
    rule: {
      id: string;
      name: string;
      polygon: Point2D[];
      dwellThresholdSeconds: number;
      cooldownSeconds?: number;
    },
    track: TrackObservation,
    currentTimeMs: number = Date.now()
  ): LoiteringResult | null {
    return this.engine.evaluateLoitering(rule, track, currentTimeMs);
  }

  /**
   * Point-in-polygon helper delegating to SpatialEngine facade.
   */
  private isPointInPolygon(point: Point2D, vs: Point2D[]): boolean {
    return this.engine.isPointInPolygon(point, vs);
  }
}

export default SpatialAnalyticsService;
