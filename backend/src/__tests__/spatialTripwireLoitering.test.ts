import {
  SpatialAnalyticsService,
  Point2D,
  TrackObservation,
} from '../services/ai/spatialAnalytics.service';
import { TripwireDirection } from '@prisma/client';

describe('SpatialAnalyticsService (Vector Tripwire Hysteresis & Continuous Loitering Dwell)', () => {
  let service: SpatialAnalyticsService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {};
    service = new SpatialAnalyticsService(mockPrisma);
  });

  describe('Directional Tripwire with Vector Cross-Product & Track Hysteresis', () => {
    // Horizontal line cutting screen at Y = 0.5 from X=0 to X=1
    // Ax=0, Ay=0.5, Bx=1, By=0.5
    // Py > 0.5 => cross product > 0 => SIDE_A
    // Py < 0.5 => cross product < 0 => SIDE_B
    const horizontalTripwire = {
      id: 'rule_trip_01',
      name: 'South Boundary Tripwire',
      direction: TripwireDirection.A_TO_B, // Only trigger A -> B
      lineCoordinates: [
        { x: 0.0, y: 0.5 },
        { x: 1.0, y: 0.5 },
      ] as [Point2D, Point2D],
      cooldownSeconds: 10,
    };

    it('should detect valid A_TO_B crossing when track traverses line from SIDE_A to SIDE_B', () => {
      const trackId = 'trk_person_01';
      let t = 1000000;

      // 1. Initial observation on SIDE_A (y = 0.7 > 0.5)
      const obs1: TrackObservation = { trackId, centroid: { x: 0.5, y: 0.7 } };
      const res1 = service.evaluateTripwire(horizontalTripwire, obs1, t);
      expect(res1).toBeNull(); // Just registered side

      // 2. Track crosses to SIDE_B (y = 0.3 < 0.5)
      t += 500;
      const obs2: TrackObservation = { trackId, centroid: { x: 0.5, y: 0.3 } };
      const res2 = service.evaluateTripwire(horizontalTripwire, obs2, t);

      expect(res2).not.toBeNull();
      expect(res2?.directionCrossed).toBe('A_TO_B');
      expect(res2?.ruleId).toBe(horizontalTripwire.id);
      expect(res2?.trackId).toBe(trackId);
    });

    it('should ignore crossing in opposite direction (B_TO_A) when rule enforces A_TO_B', () => {
      const trackId = 'trk_person_02';
      let t = 1000000;

      // 1. Initial observation on SIDE_B (y = 0.2 < 0.5)
      const obs1: TrackObservation = { trackId, centroid: { x: 0.5, y: 0.2 } };
      service.evaluateTripwire(horizontalTripwire, obs1, t);

      // 2. Crosses to SIDE_A (y = 0.8 > 0.5)
      t += 500;
      const obs2: TrackObservation = { trackId, centroid: { x: 0.5, y: 0.8 } };
      const res2 = service.evaluateTripwire(horizontalTripwire, obs2, t);

      expect(res2).toBeNull(); // Filtered because rule is A_TO_B only
    });

    it('should suppress rapid jitter line-crossings during hysteresis cooldown period', () => {
      const bidirectionalRule = {
        ...horizontalTripwire,
        direction: TripwireDirection.BIDIRECTIONAL,
        cooldownSeconds: 5,
      };

      const trackId = 'trk_jitter_01';
      let t = 1000000;

      // 1. Starts at SIDE_A
      service.evaluateTripwire(bidirectionalRule, { trackId, centroid: { x: 0.5, y: 0.7 } }, t);

      // 2. Crosses to SIDE_B
      t += 500;
      const res1 = service.evaluateTripwire(bidirectionalRule, { trackId, centroid: { x: 0.5, y: 0.3 } }, t);
      expect(res1).not.toBeNull();
      expect(res1?.directionCrossed).toBe('A_TO_B');

      // 3. Jitters back to SIDE_A 1 second later (< 5s cooldown)
      t += 1000;
      const res2 = service.evaluateTripwire(bidirectionalRule, { trackId, centroid: { x: 0.5, y: 0.7 } }, t);
      expect(res2).toBeNull(); // Suppressed by cooldown

      // 4. Crosses again after cooldown expires (6 seconds later)
      t += 6000;
      const res3 = service.evaluateTripwire(bidirectionalRule, { trackId, centroid: { x: 0.5, y: 0.3 } }, t);
      expect(res3).not.toBeNull();
      expect(res3?.directionCrossed).toBe('A_TO_B');
    });
  });

  describe('Continuous Dwell Loitering & Exit Reset Invariant', () => {
    // 0.2 to 0.8 box
    const loiteringZone = {
      id: 'rule_loiter_01',
      name: 'Restricted Vault Area',
      polygon: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.8, y: 0.8 },
        { x: 0.2, y: 0.8 },
      ],
      dwellThresholdSeconds: 15,
      cooldownSeconds: 30,
    };

    it('should trigger loitering alert only when continuous dwell exceeds threshold', () => {
      const trackId = 'trk_loiter_01';
      let t = 2000000;

      // 1. Enter polygon (x=0.5, y=0.5)
      const res1 = service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      expect(res1).toBeNull(); // Just entered

      // 2. Still inside after 10s (dwell < 15s)
      t += 10000;
      const res2 = service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.55, y: 0.55 } }, t);
      expect(res2).toBeNull();

      // 3. Still inside after 16s total (dwell >= 15s)
      t += 6000;
      const res3 = service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.6, y: 0.6 } }, t);
      expect(res3).not.toBeNull();
      expect(res3?.dwellDurationSeconds).toBe(16);
      expect(res3?.trackId).toBe(trackId);
    });

    it('should IMMEDIATELY reset continuous dwell timer when track exits polygon', () => {
      const trackId = 'trk_loiter_02';
      let t = 2000000;

      // 1. Enter polygon and dwell for 12 seconds (< 15s threshold)
      service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      t += 12000;
      service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // 2. Exit polygon momentarily (x=0.1, y=0.1 outside)
      t += 1000;
      const resExit = service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.1, y: 0.1 } }, t);
      expect(resExit).toBeNull();

      // 3. Re-enter polygon (x=0.5, y=0.5) and dwell for 4 seconds
      t += 1000;
      service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);
      t += 4000;
      const resReenter = service.evaluateLoitering(loiteringZone, { trackId, centroid: { x: 0.5, y: 0.5 } }, t);

      // Total accumulated time in zone would have been 12 + 4 = 16s, but continuous dwell must be 4s < 15s!
      expect(resReenter).toBeNull();
    });
  });
});
