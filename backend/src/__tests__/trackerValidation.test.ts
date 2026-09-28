/**
 * P2.7 tracker and tripwire validation against Roboflow supervision (MIT) on shared synthetic
 * trajectories (tools/reference/tracker_reference.py -> ai-worker fixtures/tracker/reference.json).
 *
 * The same noisy per-frame detections go through the in-repo MultiObjectTracker (ai-worker) and the
 * SpatialEngine tripwire (backend). Tolerances (docs/ai/TRACKER_VALIDATION.md):
 *   - identity: ID switches and distinct confirmed ids per ground-truth object at most 1 above
 *     supervision ByteTrack;
 *   - every ground-truth object gets a confirmed track;
 *   - line crossings: exactly the ground-truth count (supervision's LineZone has no hysteresis and
 *     is reported alongside for comparison, it is not the target).
 */
import fs from 'fs';
import path from 'path';
import { MultiObjectTracker } from '../../../services/ai-worker/src/tracker';
import { SpatialEngine } from '../services/spatial/engine';

const ref = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../services/ai-worker/src/__tests__/fixtures/tracker/reference.json'), 'utf8')
);

/** Ground truth: how many real line crossings each scenario contains (from its trajectories). */
const TRUE_CROSSINGS: Record<string, number> = {
  single_walker_crossing: 1,
  two_walkers_opposite_directions: 2,
  crossing_paths: 0,
  detector_dropouts: 1,
  person_beside_vehicle: 2,
  loiter_near_line_no_crossing: 0,
};

interface Outcome {
  idSwitches: number;
  uniqueIdsPerGt: Record<string, number>;
  crossings: number;
}

function runOurs(sc: any): Outcome {
  const tracker = new MultiObjectTracker({ iouThreshold: 0.3, minHitsToConfirm: 2, maxLostFrames: 3 });
  const engine = new SpatialEngine({} as any);
  const W = ref.canvas.width;
  const H = ref.canvas.height;
  const t0 = Date.parse('2026-09-27T10:00:00Z');
  const rule = {
    id: `wire-${sc.name}`,
    name: 'line',
    direction: 'BIDIRECTIONAL' as any,
    lineCoordinates: [
      { x: ref.line.start[0] / W, y: ref.line.start[1] / H },
      { x: ref.line.end[0] / W, y: ref.line.end[1] / H },
    ] as any,
    cooldownSeconds: 0,
  };
  const perGt: Record<string, Set<string>> = {};
  const last: Record<string, string> = {};
  let switches = 0;
  let crossings = 0;

  sc.frames.forEach((frame: any[], i: number) => {
    const ts = new Date(t0 + (i * 1000) / ref.fps);
    const dets = frame.map((d) => {
      const [x1, y1, x2, y2] = d.xyxy;
      return {
        gt: d.gt,
        box: { x: x1 / W, y: y1 / H, width: (x2 - x1) / W, height: (y2 - y1) / H },
        label: d.cls,
        type: d.cls === 'person' ? 'PERSON_DETECTED' : 'VEHICLE_DETECTED',
        classId: d.cls === 'person' ? 0 : 2,
        confidence: d.conf,
      } as any;
    });
    tracker.update(dets, ts);
    for (const d of dets) {
      if (d.trackState !== 'CONFIRMED' || !d.trackId) continue; // only confirmed tracks go downstream
      (perGt[d.gt] ||= new Set()).add(d.trackId);
      if (last[d.gt] && last[d.gt] !== d.trackId) switches++;
      last[d.gt] = d.trackId;
      const r = engine.evaluateTripwire(rule, { trackId: d.trackId, centroid: d.centroid, timestamp: ts, cameraId: 'cam' } as any, ts.getTime());
      if (r) crossings++;
    }
  });
  return {
    idSwitches: switches,
    uniqueIdsPerGt: Object.fromEntries(Object.entries(perGt).map(([k, v]) => [k, v.size])),
    crossings,
  };
}

describe('P2.7 tracker and tripwire vs supervision on shared trajectories', () => {
  const rows: any[] = [];

  afterAll(() => {
    // Printed so the numbers in docs/ai/TRACKER_VALIDATION.md can be regenerated from a real run.
    console.log('TRACKER_VALIDATION ' + JSON.stringify(rows));
  });

  for (const sc of ref.scenarios) {
    it(`${sc.name}: identity within tolerance of ByteTrack, crossings equal ground truth`, () => {
      const ours = runOurs(sc);
      const sv = sc.supervision;
      rows.push({
        scenario: sc.name,
        ours: { idSwitches: ours.idSwitches, uniqueIdsPerGt: ours.uniqueIdsPerGt, crossings: ours.crossings },
        supervision: { idSwitches: sv.idSwitches, uniqueIdsPerGt: sv.uniqueIdsPerGt, crossings: sv.lineIn + sv.lineOut },
        groundTruthCrossings: TRUE_CROSSINGS[sc.name],
      });

      // Every ground-truth object is confirmed.
      expect(Object.keys(ours.uniqueIdsPerGt).sort()).toEqual(Object.keys(sv.uniqueIdsPerGt).sort());
      // Identity within tolerance of ByteTrack.
      expect(ours.idSwitches).toBeLessThanOrEqual(sv.idSwitches + 1);
      for (const gt of Object.keys(sv.uniqueIdsPerGt)) {
        expect(ours.uniqueIdsPerGt[gt]).toBeLessThanOrEqual(sv.uniqueIdsPerGt[gt] + 1);
      }
      // Crossings: the ground truth, not a line-jitter count.
      expect(ours.crossings).toBe(TRUE_CROSSINGS[sc.name]);
    });
  }
});
