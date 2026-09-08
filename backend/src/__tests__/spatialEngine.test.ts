import { TripwireDirection, ZoneType, DetectionZone } from '@prisma/client';
import {
  SpatialEngine,
  SpatialGeometry,
  Point2D,
  BoundingBox2D,
  CalibrationProfile,
} from '../services/spatial/engine';

describe('SpatialEngine - Comprehensive Architecture & Geometric Rigor', () => {
  let engine: SpatialEngine;

  beforeEach(() => {
    engine = new SpatialEngine();
    engine.clearTrackState();
  });

  describe('Correction 1 & 2: Topological Polygon vs. BBox Intersection Semantics', () => {
    // 10x10 polygon from (10, 10) to (20, 20)
    const poly: Point2D[] = [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 10, y: 20 },
    ];

    it('distinguishes between point containment, center containment, and full containment', () => {
      // Bbox completely inside poly: (12, 12), width 2, height 2
      const insideBox: BoundingBox2D = { x: 12, y: 12, width: 2, height: 2 };
      expect(SpatialGeometry.isBBoxCenterInPolygon(insideBox, poly)).toBe(true);
      expect(SpatialGeometry.isBBoxContainedInPolygon(insideBox, poly)).toBe(true);
      expect(SpatialGeometry.intersectsPolygonBBox(poly, insideBox)).toBe(true);

      // Bbox partially overlapping: (8, 12), width 4, height 2 -> center is (10, 13) which is on boundary/inside
      // Center (10, 13) is on boundary; let's test bbox where center is outside: (5, 12), width 6, height 2 -> center (8, 13) outside!
      const straddlingBox: BoundingBox2D = { x: 5, y: 12, width: 6, height: 2 };
      expect(SpatialGeometry.isBBoxCenterInPolygon(straddlingBox, poly)).toBe(false);
      expect(SpatialGeometry.isBBoxContainedInPolygon(straddlingBox, poly)).toBe(false);
      // But intersectsPolygonBBox must detect the topological overlap!
      expect(SpatialGeometry.intersectsPolygonBBox(poly, straddlingBox)).toBe(true);
    });

    it('detects topological intersection when polygon vertex is inside bbox', () => {
      // Large bbox (5, 5) to (15, 15) containing vertex (10, 10) of poly
      const box: BoundingBox2D = { x: 5, y: 5, width: 10, height: 10 };
      expect(SpatialGeometry.intersectsPolygonBBox(poly, box)).toBe(true);
    });

    it('detects topological intersection when edges cross without corners inside each other', () => {
      // Diamond polygon centered at (15, 15): (15, 5), (25, 15), (15, 25), (5, 15)
      const diamond: Point2D[] = [
        { x: 15, y: 5 },
        { x: 25, y: 15 },
        { x: 15, y: 25 },
        { x: 5, y: 15 },
      ];
      // Thin wide cross bar bbox: (0, 14) to (30, 16) - width 30, height 2
      // None of the 4 bbox corners are inside diamond, but bbox edges intersect diamond edges!
      const crossBar: BoundingBox2D = { x: 0, y: 14, width: 30, height: 2 };
      expect(SpatialGeometry.isBBoxContainedInPolygon(crossBar, diamond)).toBe(false);
      expect(SpatialGeometry.intersectsPolygonBBox(diamond, crossBar)).toBe(true);
    });

    it('returns false when polygon and bbox are completely disjoint', () => {
      const disjointBox: BoundingBox2D = { x: 50, y: 50, width: 5, height: 5 };
      expect(SpatialGeometry.intersectsPolygonBBox(poly, disjointBox)).toBe(false);
    });
  });

  describe('Correction 3: Three-State Tripwire Hysteresis with ON_LINE Buffer', () => {
    const lineA: Point2D = { x: 0.0, y: 0.5 };
    const lineB: Point2D = { x: 1.0, y: 0.5 };

    it('classifies points into SIDE_A, ON_LINE, and SIDE_B according to epsilon buffer', () => {
      // Above line (cross product > 0.005)
      expect(SpatialGeometry.computeLineSide(lineA, lineB, { x: 0.5, y: 0.6 }, 0.005)).toBe('SIDE_A');
      // Below line (cross product < -0.005)
      expect(SpatialGeometry.computeLineSide(lineA, lineB, { x: 0.5, y: 0.4 }, 0.005)).toBe('SIDE_B');
      // Exactly on line or within epsilon buffer
      expect(SpatialGeometry.computeLineSide(lineA, lineB, { x: 0.5, y: 0.5 }, 0.005)).toBe('ON_LINE');
      expect(SpatialGeometry.computeLineSide(lineA, lineB, { x: 0.5, y: 0.501 }, 0.005)).toBe('ON_LINE');
    });

    it('requires traversal through the buffer to trigger crossing, suppressing line-edge noise', () => {
      const rule = {
        id: 'rule-trip-1',
        name: 'Gate Entrance',
        direction: TripwireDirection.A_TO_B,
        lineCoordinates: [lineA, lineB] as [Point2D, Point2D],
        cooldownSeconds: 5,
      };

      const trackId = 'trk-hysteresis-1';
      let t = 10000;

      // 1. Starts on SIDE_A
      expect(engine.evaluateTripwire(rule, { trackId, centroid: { x: 0.5, y: 0.7 } }, t)).toBeNull();

      // 2. Enters ON_LINE buffer (noise near line)
      t += 100;
      expect(engine.evaluateTripwire(rule, { trackId, centroid: { x: 0.5, y: 0.501 } }, t)).toBeNull();

      // 3. Jitters back to SIDE_A (never traversed to SIDE_B) -> NO crossing triggered!
      t += 100;
      expect(engine.evaluateTripwire(rule, { trackId, centroid: { x: 0.5, y: 0.65 } }, t)).toBeNull();

      // 4. Now crosses into ON_LINE and all the way to SIDE_B -> Valid A_TO_B crossing!
      t += 100;
      engine.evaluateTripwire(rule, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      t += 100;
      const crossing = engine.evaluateTripwire(rule, { trackId, centroid: { x: 0.5, y: 0.3 } }, t);

      expect(crossing).not.toBeNull();
      expect(crossing?.directionCrossed).toBe('A_TO_B');
      expect(crossing?.trackId).toBe(trackId);
    });
  });

  describe('Correction 4: Loitering Observation-Loss Rule (Dropout vs. Explicit Exit)', () => {
    const loiterZone = {
      id: 'rule-loiter-secure',
      name: 'Vault Room',
      polygon: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      dwellThresholdSeconds: 10,
      cooldownSeconds: 30,
    };

    it('immediately resets continuous dwell timer on explicit exit (OBSERVED_OUTSIDE)', () => {
      const trackId = 'trk-exit-test';
      let t = 100000;

      // Enter and dwell for 8 seconds (< 10s threshold)
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      t += 8000;
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // Explicit exit outside polygon
      t += 500;
      const exitRes = engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.05, y: 0.05 } }, t);
      expect(exitRes).toBeNull();

      // Re-enter 500ms later: dwell timer must have reset to 0!
      t += 500;
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // Dwell 3 more seconds (accumulated would be 8 + 3 = 11s, but continuous dwell is 3s < 10s)
      t += 3000;
      const reenterRes = engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      expect(reenterRes).toBeNull();
    });

    it('preserves dwell timer during short detector dropouts (<= observationTimeoutMs)', () => {
      const trackId = 'trk-dropout-preserve';
      let t = 200000;

      // 1. Enter and dwell for 8 seconds
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      t += 8000;
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // 2. Detector reports TEMPORARILY_UNOBSERVED 1000ms later
      t += 1000;
      engine.evaluateLoitering(
        loiterZone,
        { trackId, centroid: { x: 0.5, y: 0.5 } },
        t,
        { observationStatus: 'TEMPORARILY_UNOBSERVED', observationTimeoutMs: 2000 }
      );

      // 3. Re-observed inside zone 500ms later (total gap from last observation: 1000ms + 500ms = 1500ms <= 2000ms timeout)
      t += 500;
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // 4. Dwell for 2 more seconds (total time 8s + 1.5s + 2s = 11.5s >= 10s threshold)
      t += 2000;
      const alert = engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      expect(alert).not.toBeNull();
      expect(alert?.dwellDurationSeconds).toBeGreaterThanOrEqual(10);
      expect(alert?.trackId).toBe(trackId);
    });

    it('resets dwell timer when detector dropout exceeds observationTimeoutMs (> 2000ms)', () => {
      const trackId = 'trk-dropout-exceed';
      let t = 300000;

      // 1. Enter and dwell for 7 seconds
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      t += 7000;
      engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // 2. Detector reports dropout for 3500ms (> 2000ms timeout)
      t += 3500;
      engine.evaluateLoitering(
        loiterZone,
        { trackId, centroid: { x: 0.5, y: 0.5 } },
        t,
        { observationStatus: 'TEMPORARILY_UNOBSERVED', observationTimeoutMs: 2000 }
      );

      // 3. Target re-acquired inside zone 2 seconds later: dwell timer must have reset
      t += 2000;
      const alert = engine.evaluateLoitering(loiterZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      expect(alert).toBeNull(); // Reset! Only 2 seconds since re-acquisition
    });
  });

  describe('Correction 5: Calibrated PTZ FOV with Fallback', () => {
    const basePlacement = {
      x: 100,
      y: 100,
      mountHeightMeters: 3.5,
      headingDegrees: 90,
      pitchDegrees: 30,
      fovHorizontalDegrees: 90,
      zoom: 2.0,
    };

    it('falls back to FOV / zoom calculation when no calibration profile exists', () => {
      const cone = engine.calculateFovCone(basePlacement, 20.0);
      // 90 / 2.0 = 45°
      expect(cone.effectiveFovDegrees).toBe(45.0);
    });

    it('uses calibrated FOV profile lookup when available', () => {
      const calibration: CalibrationProfile = {
        cameraModel: 'Axis-Q6125',
        calibratedFovDegrees: 60.0, // Calibrated wider lens
      };
      const cone = engine.calculateFovCone(basePlacement, 20.0, calibration);
      // 60 / 2.0 = 30°
      expect(cone.effectiveFovDegrees).toBe(30.0);
    });

    it('uses explicit zoom map from calibration profile', () => {
      const calibration: CalibrationProfile = {
        cameraModel: 'Hanwha-XNP',
        zoomMap: {
          2.0: 41.5, // Empirically measured 41.5° at 2x
        },
      };
      const cone = engine.calculateFovCone(basePlacement, 20.0, calibration);
      expect(cone.effectiveFovDegrees).toBe(41.5);
    });
  });

  describe('Correction 6: Bounded TrackStateLedger with LRU & TTL Eviction', () => {
    it('enforces per-camera and global LRU eviction caps and tracks telemetry', () => {
      // Create engine with tiny ledger caps to test eviction
      const cappedEngine = new SpatialEngine(undefined, {
        ledgerConfig: {
          maxTracksPerCamera: 3,
          maxTracksGlobal: 5,
          ttlMs: 5000,
        },
      });

      const rule = {
        id: 'rule-cap-1',
        name: 'Turnstile',
        direction: TripwireDirection.BIDIRECTIONAL,
        lineCoordinates: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] as [Point2D, Point2D],
      };

      let t = 1000;

      // Add 4 tracks on cam-1 (cap is 3)
      cappedEngine.evaluateTripwire(rule, { trackId: 'trk-1', centroid: { x: 0.5, y: 0.8 }, cameraId: 'cam-1' }, t);
      cappedEngine.evaluateTripwire(rule, { trackId: 'trk-2', centroid: { x: 0.5, y: 0.8 }, cameraId: 'cam-1' }, t);
      cappedEngine.evaluateTripwire(rule, { trackId: 'trk-3', centroid: { x: 0.5, y: 0.8 }, cameraId: 'cam-1' }, t);
      cappedEngine.evaluateTripwire(rule, { trackId: 'trk-4', centroid: { x: 0.5, y: 0.8 }, cameraId: 'cam-1' }, t);

      let metrics = cappedEngine.getLedgerMetrics();
      expect(metrics.evictedCount).toBeGreaterThanOrEqual(1);

      // TTL expiration check
      t += 6000; // > 5000ms TTL
      cappedEngine.evaluateTripwire(rule, { trackId: 'trk-fresh', centroid: { x: 0.5, y: 0.8 }, cameraId: 'cam-2' }, t);

      metrics = cappedEngine.getLedgerMetrics();
      expect(metrics.expiredCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Exclusion Precedence Invariant & Snapshot Integrity', () => {
    const inclusionZone: DetectionZone = {
      id: 'z-inc',
      tenantId: 't1',
      cameraId: 'c1',
      name: 'Corridor',
      type: ZoneType.INCLUSION,
      priority: 1,
      enabled: true,
      polygonCoordinates: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.9 },
        { x: 0.1, y: 0.9 },
      ] as any,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const exclusionZone: DetectionZone = {
      id: 'z-exc',
      tenantId: 't1',
      cameraId: 'c1',
      name: 'Fan Mask',
      type: ZoneType.EXCLUSION,
      priority: 10,
      enabled: true,
      polygonCoordinates: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.4 },
        { x: 0.6, y: 0.6 },
        { x: 0.4, y: 0.6 },
      ] as any,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('exclusion zone always overrides inclusion zone (veto power)', () => {
      // Point (0.5, 0.5) is inside BOTH inclusion and exclusion
      const res = engine.evaluateDetection({ x: 0.5, y: 0.5 }, [inclusionZone, exclusionZone]);
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe('BLOCKED_BY_EXCLUSION');
      expect(res.matchedZoneId).toBe('z-exc');
    });

    it('produces immutable forensic snapshot', () => {
      const snapshot = engine.createZoneSnapshot([inclusionZone, exclusionZone]);
      expect(snapshot.zonesCount).toBe(2);
      expect(snapshot.snapshotTimestamp).toBeDefined();
      expect(snapshot.zones[0].id).toBe('z-inc');
    });
  });
});
