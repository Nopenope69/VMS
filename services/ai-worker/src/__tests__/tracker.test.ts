import { MultiObjectTracker, computeIoU, normalizeTrackClass } from '../tracker';
import { TrackerDetectionInput } from '../tracker';

describe('MultiObjectTracker (MOT Engine & Track State Management)', () => {
  let tracker: MultiObjectTracker;

  beforeEach(() => {
    tracker = new MultiObjectTracker({
      iouThreshold: 0.3,
      minHitsToConfirm: 2,
      maxLostFrames: 3,
      maxActiveTracks: 50,
      maxTrajectoryPoints: 30,
    });
  });

  // =========================================================================
  // A. Class-Scoped Association Invariant
  // =========================================================================
  describe('A. Class-Scoped Association Invariant', () => {
    it('strictly forbids associating a person detection with a vehicle track even with 100% IoU overlap', () => {
      const t1 = new Date('2026-09-25T10:00:00Z');
      const box = { x: 0.2, y: 0.2, width: 0.1, height: 0.2 };

      // 1. Initialize track with person detection
      const tracksF1 = tracker.update([{ box, label: 'person', type: 'PERSON_DETECTED' }], t1);
      expect(tracksF1.length).toBe(1);
      const personTrackId = tracksF1[0].trackId;
      expect(tracksF1[0].label).toBe('person');

      // 2. Next frame: vehicle detection with identical bounding box
      const t2 = new Date('2026-09-25T10:00:01Z');
      const tracksF2 = tracker.update([{ box, label: 'vehicle', type: 'VEHICLE_DETECTED' }], t2);

      // Person track should NOT match the vehicle detection (person track enters LOST)
      // Vehicle detection creates a brand NEW tentative track
      expect(tracksF2.length).toBe(2);

      const personTrack = tracksF2.find((t) => t.trackId === personTrackId);
      const vehicleTrack = tracksF2.find((t) => t.trackId !== personTrackId);

      expect(personTrack).toBeDefined();
      expect(personTrack?.label).toBe('person');
      expect(personTrack?.state).toBe('LOST'); // missed because vehicle could not match it!

      expect(vehicleTrack).toBeDefined();
      expect(vehicleTrack?.label).toBe('vehicle');
      expect(vehicleTrack?.state).toBe('TENTATIVE');
      expect(vehicleTrack?.trackId).not.toBe(personTrackId);
    });

    it('strictly forbids associating a vehicle detection with a person track', () => {
      const t1 = new Date('2026-09-25T10:00:00Z');
      const box = { x: 0.4, y: 0.4, width: 0.2, height: 0.2 };

      // 1. Initialize track with vehicle
      const tracksF1 = tracker.update([{ box, label: 'car', type: 'VEHICLE_DETECTED' }], t1);
      const vehicleTrackId = tracksF1[0].trackId;
      expect(tracksF1[0].label).toBe('vehicle');

      // 2. Next frame: person detection with identical box
      const t2 = new Date('2026-09-25T10:00:01Z');
      const tracksF2 = tracker.update([{ box, label: 'person', type: 'PERSON_DETECTED' }], t2);

      expect(tracksF2.length).toBe(2);
      const originalVehicle = tracksF2.find((t) => t.trackId === vehicleTrackId);
      expect(originalVehicle?.state).toBe('LOST');
      const newPerson = tracksF2.find((t) => t.trackId !== vehicleTrackId);
      expect(newPerson?.label).toBe('person');
      expect(newPerson?.state).toBe('TENTATIVE');
    });
  });

  // =========================================================================
  // B. Track Promotion Lifecycle (TENTATIVE -> CONFIRMED)
  // =========================================================================
  describe('B. Track Promotion Lifecycle', () => {
    it('promotes track from TENTATIVE to CONFIRMED only after minHitsToConfirm consecutive hits', () => {
      const t1 = new Date('2026-09-25T10:00:00Z');
      const t2 = new Date('2026-09-25T10:00:01Z');
      const box1 = { x: 0.1, y: 0.1, width: 0.1, height: 0.2 };
      const box2 = { x: 0.11, y: 0.11, width: 0.1, height: 0.2 };

      // Frame 1: Newly detected candidate -> TENTATIVE
      const f1 = tracker.update([{ box: box1, label: 'person' }], t1);
      expect(f1.length).toBe(1);
      expect(f1[0].state).toBe('TENTATIVE');
      expect(f1[0].hits).toBe(1);
      expect(f1[0].consecutiveHits).toBe(1);
      const trackId = f1[0].trackId;

      // Frame 2: Second matching detection -> CONFIRMED
      const f2 = tracker.update([{ box: box2, label: 'person' }], t2);
      expect(f2.length).toBe(1);
      expect(f2[0].trackId).toBe(trackId);
      expect(f2[0].state).toBe('CONFIRMED');
      expect(f2[0].hits).toBe(2);
      expect(f2[0].consecutiveHits).toBe(2);
    });
  });

  // =========================================================================
  // C. Track Persistence
  // =========================================================================
  describe('C. Track Persistence', () => {
    it('preserves the same persistent trackId across consecutive valid associations', () => {
      const baseTime = new Date('2026-09-25T10:00:00Z').getTime();
      let lastTrackId: string | null = null;

      for (let i = 0; i < 10; i++) {
        const time = new Date(baseTime + i * 1000);
        const box = { x: 0.1 + i * 0.005, y: 0.2, width: 0.08, height: 0.15 };
        const tracks = tracker.update([{ box, label: 'person' }], time);

        expect(tracks.length).toBe(1);
        if (lastTrackId === null) {
          lastTrackId = tracks[0].trackId;
        } else {
          expect(tracks[0].trackId).toBe(lastTrackId);
        }
      }

      const confirmed = tracker.getConfirmedTracks();
      expect(confirmed.length).toBe(1);
      expect(confirmed[0].hits).toBe(10);
    });
  });

  // =========================================================================
  // D. Deterministic Association
  // =========================================================================
  describe('D. Deterministic Association', () => {
    it('produces identical association results and lifecycle transitions for identical inputs', () => {
      const detections = [
        { box: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }, label: 'person' },
        { box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 }, label: 'vehicle' },
      ];

      const tracker1 = new MultiObjectTracker();
      const tracker2 = new MultiObjectTracker();

      const t1 = new Date('2026-09-25T10:00:00Z');
      const t2 = new Date('2026-09-25T10:00:01Z');

      const res1_1 = tracker1.update(detections, t1);
      const res2_1 = tracker2.update(detections, t1);

      expect(res1_1.length).toBe(res2_1.length);
      expect(res1_1.map((t) => t.label).sort()).toEqual(res2_1.map((t) => t.label).sort());
      expect(res1_1.map((t) => t.state)).toEqual(res2_1.map((t) => t.state));

      const detectionsF2 = [
        { box: { x: 0.11, y: 0.11, width: 0.1, height: 0.1 }, label: 'person' },
        { box: { x: 0.51, y: 0.51, width: 0.2, height: 0.2 }, label: 'vehicle' },
      ];

      const res1_2 = tracker1.update(detectionsF2, t2);
      const res2_2 = tracker2.update(detectionsF2, t2);

      expect(res1_2.length).toBe(res2_2.length);
      expect(res1_2.map((t) => t.state)).toEqual(res2_2.map((t) => t.state));
      expect(res1_2.every((t) => t.state === 'CONFIRMED')).toBe(true);
      expect(res2_2.every((t) => t.state === 'CONFIRMED')).toBe(true);
    });
  });

  // =========================================================================
  // E. Occlusion and Recovery
  // =========================================================================
  describe('E. Occlusion and Recovery', () => {
    it('transitions CONFIRMED -> LOST on missed frame and recovers CONFIRMED with identical trackId', () => {
      const t1 = new Date('2026-09-25T10:00:00Z');
      const t2 = new Date('2026-09-25T10:00:01Z');
      const t3 = new Date('2026-09-25T10:00:02Z');
      const t4 = new Date('2026-09-25T10:00:03Z');

      const box = { x: 0.3, y: 0.3, width: 0.1, height: 0.2 };

      // 1. Establish confirmed track (2 hits)
      tracker.update([{ box, label: 'person' }], t1);
      const f2 = tracker.update([{ box: { ...box, x: 0.31 }, label: 'person' }], t2);
      expect(f2[0].state).toBe('CONFIRMED');
      const originalTrackId = f2[0].trackId;

      // 2. Frame 3: Occlusion / detection missed
      const f3 = tracker.update([], t3);
      expect(f3.length).toBe(1);
      expect(f3[0].trackId).toBe(originalTrackId);
      expect(f3[0].state).toBe('LOST');
      expect(f3[0].lostFrames).toBe(1);

      // 3. Frame 4: Target reappears -> successfully recovered!
      const f4 = tracker.update([{ box: { ...box, x: 0.32 }, label: 'person' }], t4);
      expect(f4.length).toBe(1);
      expect(f4[0].trackId).toBe(originalTrackId); // PRESERVES TRACK ID!
      expect(f4[0].state).toBe('CONFIRMED');
      expect(f4[0].lostFrames).toBe(0);
    });
  });

  // =========================================================================
  // F. Track Termination
  // =========================================================================
  describe('F. Track Termination', () => {
    it('retains LOST track for up to maxLostFrames=3 missed frames, and terminates on the 4th miss', () => {
      const baseTime = new Date('2026-09-25T10:00:00Z').getTime();
      const box = { x: 0.3, y: 0.3, width: 0.1, height: 0.2 };

      // Establish confirmed track (2 hits)
      tracker.update([{ box, label: 'person' }], new Date(baseTime));
      const f2 = tracker.update([{ box, label: 'person' }], new Date(baseTime + 1000));
      expect(f2[0].state).toBe('CONFIRMED');

      // Miss 1
      const m1 = tracker.update([], new Date(baseTime + 2000));
      expect(m1.length).toBe(1);
      expect(m1[0].state).toBe('LOST');
      expect(m1[0].lostFrames).toBe(1);

      // Miss 2
      const m2 = tracker.update([], new Date(baseTime + 3000));
      expect(m2.length).toBe(1);
      expect(m2[0].state).toBe('LOST');
      expect(m2[0].lostFrames).toBe(2);

      // Miss 3 (still recoverable within maxLostFrames=3)
      const m3 = tracker.update([], new Date(baseTime + 4000));
      expect(m3.length).toBe(1);
      expect(m3[0].state).toBe('LOST');
      expect(m3[0].lostFrames).toBe(3);

      // Miss 4 (lostFrames = 4 > maxLostFrames -> TERMINATED and pruned from active memory)
      const m4 = tracker.update([], new Date(baseTime + 5000));
      expect(m4.length).toBe(0);
      expect(tracker.getTracks().length).toBe(0);
    });
  });

  // =========================================================================
  // G. Bounded Capacity and Eviction Protection
  // =========================================================================
  describe('G. Bounded Capacity and Eviction Protection', () => {
    it('evicts in order TERMINATED -> LOST -> TENTATIVE, and NEVER evicts CONFIRMED tracks', () => {
      const smallTracker = new MultiObjectTracker({
        maxActiveTracks: 3,
        minHitsToConfirm: 2,
        maxLostFrames: 3,
      });

      const t1 = new Date('2026-09-25T10:00:00Z');

      // 1. Add 3 tentative tracks (capacity reached)
      smallTracker.update([
        { box: { x: 0.0, y: 0.0, width: 0.05, height: 0.05 }, label: 'person' },
        { box: { x: 0.2, y: 0.2, width: 0.05, height: 0.05 }, label: 'person' },
        { box: { x: 0.4, y: 0.4, width: 0.05, height: 0.05 }, label: 'person' },
      ], t1);

      expect(smallTracker.getTracks().length).toBe(3);
      expect(smallTracker.getTracks().every((t) => t.state === 'TENTATIVE')).toBe(true);

      // 2. Introducing a 4th unmatched detection must evict the oldest TENTATIVE track
      const t2 = new Date('2026-09-25T10:00:01Z');
      smallTracker.update([
        { box: { x: 0.6, y: 0.6, width: 0.05, height: 0.05 }, label: 'person' },
      ], t2);

      expect(smallTracker.getTracks().length).toBe(3);
      expect(smallTracker.getStats().evictions).toBe(1);

      // 3. Confirm 3 tracks to test CONFIRMED immunity
      const strictTracker = new MultiObjectTracker({
        maxActiveTracks: 2,
        minHitsToConfirm: 1, // immediate confirmation for test simplicity
      });

      strictTracker.update([
        { box: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, label: 'person' },
        { box: { x: 0.3, y: 0.3, width: 0.05, height: 0.05 }, label: 'person' },
      ], t1);

      const confirmedTracks = strictTracker.getConfirmedTracks();
      expect(confirmedTracks.length).toBe(2);
      const confirmedIds = new Set(confirmedTracks.map((t) => t.trackId));

      // Attempt to add a 3rd unmatched detection when all 2 slots are CONFIRMED
      strictTracker.update([
        { box: { x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, label: 'person' }, // matches track 1
        { box: { x: 0.3, y: 0.3, width: 0.05, height: 0.05 }, label: 'person' }, // matches track 2
        { box: { x: 0.8, y: 0.8, width: 0.05, height: 0.05 }, label: 'person' }, // unmatched 3rd!
      ], t2);

      // CONFIRMED tracks MUST NOT be evicted!
      const activeAfter = strictTracker.getTracks();
      expect(activeAfter.length).toBe(2);
      expect(activeAfter.every((t) => confirmedIds.has(t.trackId))).toBe(true);
      expect(strictTracker.getStats().capacityDrops).toBe(1);
    });

    it('rejects new candidate when all 50 slots are occupied by confirmed tracks', () => {
      const baseTime = new Date('2026-09-25T10:00:00Z').getTime();

      // Create 50 distinct detections
      const initialDets: TrackerDetectionInput[] = [];
      for (let i = 0; i < 50; i++) {
        initialDets.push({
          box: { x: (i % 10) * 0.08, y: Math.floor(i / 10) * 0.18, width: 0.05, height: 0.1 },
          label: 'person',
        });
      }

      // Frame 1: 50 tentative tracks
      tracker.update(initialDets, new Date(baseTime));
      // Frame 2: confirm all 50 tracks
      tracker.update(initialDets, new Date(baseTime + 1000));

      expect(tracker.getConfirmedTracks().length).toBe(50);
      const originalIds = new Set(tracker.getConfirmedTracks().map((t) => t.trackId));

      // Introduce a 51st new detection far away
      const overflowDets = [
        ...initialDets,
        { box: { x: 0.95, y: 0.95, width: 0.04, height: 0.04 }, label: 'person' },
      ];

      tracker.update(overflowDets, new Date(baseTime + 2000));

      expect(tracker.getTracks().length).toBe(50);
      expect(tracker.getConfirmedTracks().length).toBe(50);
      expect(tracker.getTracks().every((t) => originalIds.has(t.trackId))).toBe(true);
      expect(tracker.getStats().capacityDrops).toBe(1);
    });
  });

  // =========================================================================
  // H. Trajectory Recording & Capping
  // =========================================================================
  describe('H. Trajectory Recording & Capping', () => {
    it('maintains chronological ordering and caps history at maxTrajectoryPoints=30 points', () => {
      const baseTime = new Date('2026-09-25T10:00:00Z').getTime();

      for (let i = 0; i < 40; i++) {
        const time = new Date(baseTime + i * 1000);
        const x = 0.1 + i * 0.01;
        const y = 0.2;
        tracker.update([{ box: { x, y, width: 0.05, height: 0.1 }, label: 'person' }], time);
      }

      const tracks = tracker.getTracks();
      expect(tracks.length).toBe(1);
      const track = tracks[0];

      expect(track.trajectory.length).toBe(30);

      // Verify chronological ordering
      for (let i = 1; i < track.trajectory.length; i++) {
        expect(track.trajectory[i].timestamp.getTime()).toBeGreaterThan(
          track.trajectory[i - 1].timestamp.getTime()
        );
      }

      // Oldest points (0..9) should have been shifted out; first point should be index 10 (i=10)
      const expectedFirstTimestamp = new Date(baseTime + 10 * 1000);
      expect(track.trajectory[0].timestamp.toISOString()).toBe(expectedFirstTimestamp.toISOString());
    });
  });

  // =========================================================================
  // I. Velocity Calculation
  // =========================================================================
  describe('I. Velocity Calculation', () => {
    it('computes vx = dx / dt and vy = dy / dt using actual observation elapsed time', () => {
      const t1 = new Date('2026-09-25T10:00:00.000Z');
      const t2 = new Date('2026-09-25T10:00:02.000Z'); // dt = 2.0s

      // Centroid 1: (0.20 + 0.10/2, 0.20 + 0.10/2) = (0.25, 0.25)
      tracker.update([{ box: { x: 0.20, y: 0.20, width: 0.10, height: 0.10 }, label: 'person' }], t1);

      // Centroid 2: (0.22 + 0.10/2, 0.24 + 0.10/2) = (0.27, 0.29)
      // Overlap: x in [0.22, 0.30] (0.08), y in [0.24, 0.30] (0.06) -> IoU ~ 0.32 >= 0.30
      // dx = 0.27 - 0.25 = 0.02
      // dy = 0.29 - 0.25 = 0.04
      // vx = 0.02 / 2.0 = 0.01
      // vy = 0.04 / 2.0 = 0.02
      const tracks = tracker.update(
        [{ box: { x: 0.22, y: 0.24, width: 0.10, height: 0.10 }, label: 'person' }],
        t2
      );

      expect(tracks.length).toBe(1);
      expect(tracks[0].velocity.vx).toBeCloseTo(0.01, 3);
      expect(tracks[0].velocity.vy).toBeCloseTo(0.02, 3);
    });
  });

  // =========================================================================
  // J. Constant-Velocity Predicted Box Projection
  // =========================================================================
  describe('J. Constant-Velocity Predicted Box Projection', () => {
    it('translates box by velocity * dt and uses predicted box for IoU matching', () => {
      const track = {
        trackId: 'test-trk',
        classId: 0,
        label: 'person',
        state: 'CONFIRMED' as const,
        box: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 },
        centroid: { x: 0.25, y: 0.25 },
        velocity: { vx: 0.05, vy: -0.02 },
        trajectory: [],
        hits: 5,
        consecutiveHits: 5,
        lostFrames: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
      };

      const dt = 1.5; // seconds
      const predicted = tracker.predictBox(track, dt);

      expect(predicted.x).toBeCloseTo(0.2 + 0.05 * 1.5, 4); // 0.275
      expect(predicted.y).toBeCloseTo(0.2 - 0.02 * 1.5, 4); // 0.17
      expect(predicted.width).toBe(0.1);
      expect(predicted.height).toBe(0.1);
    });
  });

  // =========================================================================
  // K. Crossing-Friendly Continuity (Fast Moving Objects)
  // =========================================================================
  describe('K. Crossing-Friendly Continuity', () => {
    it('maintains continuous track association across 1 FPS observations during rapid motion using velocity projection', () => {
      const t1 = new Date('2026-09-25T10:00:00Z');
      const t2 = new Date('2026-09-25T10:00:01Z');
      const t3 = new Date('2026-09-25T10:00:02Z');

      // Frame 1: Initial detection at x=0.10, width=0.10
      tracker.update([{ box: { x: 0.10, y: 0.3, width: 0.10, height: 0.1 }, label: 'person' }], t1);

      // Frame 2: Moves to x=0.14 (IoU with frame 1 is 0.43 >= 0.30)
      // Confirms track and establishes velocity vx = (0.19 - 0.15) / 1.0 = 0.04 / sec
      const f2 = tracker.update(
        [{ box: { x: 0.14, y: 0.3, width: 0.10, height: 0.1 }, label: 'person' }],
        t2
      );
      const trackId = f2[0].trackId;
      expect(f2[0].state).toBe('CONFIRMED');
      expect(f2[0].velocity.vx).toBeCloseTo(0.04, 3);

      // Frame 3: Moves to x=0.20 (without velocity projection, overlap with frame 2 [0.14..0.24]
      // and frame 3 [0.20..0.30] would have IoU = 0.04 / 0.16 = 0.25 < 0.30, which would fail!)
      // With velocity projection: predicted box is translated by vx * 1.0s = 0.14 + 0.04 = 0.18!
      // Overlap between predicted [0.18..0.28] and detection [0.20..0.30] is 0.08 / 0.12 = 0.67 >= 0.30!
      const f3 = tracker.update(
        [{ box: { x: 0.20, y: 0.3, width: 0.10, height: 0.1 }, label: 'person' }],
        t3
      );

      expect(f3.length).toBe(1);
      expect(f3[0].trackId).toBe(trackId);
      expect(f3[0].state).toBe('CONFIRMED');
    });
  });
});
