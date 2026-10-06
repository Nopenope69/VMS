import {
  PoseRuleLedger,
  classifyPosture,
  parsePose,
  sideOf,
  distanceToSegment,
  Keypoint,
  KP,
  NUM_KEYPOINTS,
  SAMPLE_GAP_MS,
  PersonDownRuleInput,
  FenceClimbRuleInput,
} from '../services/spatial/engine/poseRules';

const ZONE = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** 17 keypoints, all weak, with chosen ones set. */
function pose(set: Partial<Record<keyof typeof KP, [number, number, number?]>>): Keypoint[] {
  const k: Keypoint[] = Array.from({ length: NUM_KEYPOINTS }, () => [0.5, 0.5, 0.05] as Keypoint);
  for (const [name, v] of Object.entries(set)) {
    const [x, y, s] = v as [number, number, number?];
    k[(KP as any)[name]] = [x, y, s ?? 0.9];
  }
  return k;
}
/** Person standing: shoulders above hips. */
const standing = (x = 0.5) => pose({ leftShoulder: [x - 0.02, 0.4], rightShoulder: [x + 0.02, 0.4], leftHip: [x - 0.02, 0.6], rightHip: [x + 0.02, 0.6] });
/** Person lying: shoulders and hips side by side. */
const lying = (x = 0.5) => pose({ leftShoulder: [x - 0.12, 0.8], rightShoulder: [x - 0.12, 0.82], leftHip: [x + 0.06, 0.8], rightHip: [x + 0.06, 0.82] });

describe('parsePose', () => {
  it('accepts 17 [x, y, score] triples', () => {
    expect(parsePose({ pose: { keypoints: standing() } })).toHaveLength(17);
  });
  it.each([
    [undefined],
    [{}],
    [{ pose: {} }],
    [{ pose: { keypoints: standing().slice(0, 16) } }],
    [{ pose: { keypoints: [...standing().slice(0, 16), [0.5, 0.5]] } }],
    [{ pose: { keypoints: [...standing().slice(0, 16), [0.5, 'a', 0.5]] } }],
    [{ pose: { keypoints: [...standing().slice(0, 16), [0.5, 0.5, 1.5]] } }],
    [{ pose: { keypoints: [...standing().slice(0, 16), [NaN, 0.5, 0.5]] } }],
  ])('rejects a malformed pose: %j', (a) => {
    expect(parsePose(a)).toBeNull();
  });
});

describe('classifyPosture', () => {
  it('upright for a vertical torso, lying for a horizontal one', () => {
    expect(classifyPosture(standing(), null)).toMatchObject({ posture: 'UPRIGHT', basis: 'pose', torsoAngle: 0 });
    expect(classifyPosture(lying(), null).posture).toBe('LYING');
  });

  it('reads the angle in pixels: the same normalised offset is wider on a 16:9 frame than on a square one', () => {
    const k = pose({ leftShoulder: [0.4, 0.4], rightShoulder: [0.4, 0.4], leftHip: [0.5, 0.5], rightHip: [0.5, 0.5] }); // 45 degrees on a square image
    expect(classifyPosture(k, null, { aspect: 1 }).posture).toBe('UNKNOWN');
    expect(classifyPosture(k, null, { aspect: 16 / 9 }).torsoAngle).toBe(61);
    expect(classifyPosture(k, null, { aspect: 16 / 9 }).posture).toBe('LYING');
  });

  it('is UNKNOWN between 35 and 60 degrees (bending, sitting)', () => {
    const k = pose({ leftShoulder: [0.5, 0.4], rightShoulder: [0.5, 0.4], leftHip: [0.5 + 0.1 / (16 / 9), 0.5], rightHip: [0.5 + 0.1 / (16 / 9), 0.5] }); // 45 degrees
    expect(classifyPosture(k, null).posture).toBe('UNKNOWN');
  });

  it('falls back to the box shape, labelled as such, when the torso keypoints are weak', () => {
    const weak = pose({});
    expect(classifyPosture(weak, { x: 0.2, y: 0.7, width: 0.3, height: 0.1 })).toEqual({ posture: 'LYING', basis: 'box' });
    expect(classifyPosture(weak, { x: 0.4, y: 0.2, width: 0.05, height: 0.4 })).toEqual({ posture: 'UPRIGHT', basis: 'box' });
    expect(classifyPosture(null, { x: 0.4, y: 0.4, width: 0.1, height: 0.2 })).toEqual({ posture: 'UNKNOWN', basis: 'none' });
    expect(classifyPosture(weak, null)).toEqual({ posture: 'UNKNOWN', basis: 'none' });
  });

  it('needs both a shoulder and a hip above the score floor', () => {
    const k = pose({ leftShoulder: [0.5, 0.4], leftHip: [0.5, 0.6, 0.1] });
    expect(classifyPosture(k, null).basis).toBe('none');
  });
});

describe('person down', () => {
  const rule: PersonDownRuleInput = { id: 'r1', polygon: ZONE, lyingSeconds: 10, lyingStillSeconds: 0 };
  const c = { x: 0.5, y: 0.7 };
  const UP = classifyPosture(standing(), null);
  const DOWN = classifyPosture(lying(), null);
  const UNK = { posture: 'UNKNOWN' as const, basis: 'none' as const };
  const step = (l: PoseRuleLedger, reading: any, tSec: number, centroid = c, r = rule) => l.evaluatePersonDown(r, 't1', reading, centroid, tSec * 1000);
  /** One sample a second from `from` to `to` (as the worker delivers them); the first alert, if any. */
  const hold = (l: PoseRuleLedger, reading: any, from: number, to: number, centroid = c, r = rule, trackId = 't1') => {
    for (let t = from; t <= to; t++) {
      const res = l.evaluatePersonDown(r, trackId, reading, centroid, t * 1000);
      if (res) return res;
    }
    return null;
  };

  it('alerts once when a person seen upright goes down and stays down for the time', () => {
    const l = new PoseRuleLedger();
    expect(step(l, UP, 0)).toBeNull();
    expect(step(l, DOWN, 2)).toBeNull(); // falls 2 s after being upright: a fall seen
    expect(step(l, DOWN, 8)).toBeNull();
    const r = step(l, DOWN, 12.5);
    expect(r).toMatchObject({ kind: 'FALL', basis: 'pose', trackId: 't1', ruleId: 'r1' });
    expect(r!.lyingSeconds).toBeGreaterThanOrEqual(10);
    expect(step(l, DOWN, 30)).toBeNull(); // once
  });

  it('does not alert when they get up in time, and a later fall alerts again', () => {
    const l = new PoseRuleLedger();
    step(l, UP, 0);
    expect(hold(l, DOWN, 1, 8)).toBeNull();
    step(l, UP, 9);
    step(l, UP, 10);
    expect(hold(l, DOWN, 11, 15)).toBeNull(); // a new fall starts its clock at 11
    expect(step(l, UP, 16)).toBeNull(); // up again before the time: nothing
    expect(hold(l, DOWN, 17, 26)).toBeNull();
    expect(hold(l, DOWN, 27, 30)).toMatchObject({ kind: 'FALL' });
  });

  it('is not a fall seen when they were last upright long before lying (found lying), and says nothing by default', () => {
    const l = new PoseRuleLedger();
    step(l, UP, 0);
    for (let t = 20; t <= 200; t += 5) expect(step(l, DOWN, t)).toBeNull();
  });

  it('with lyingStillSeconds raises the weaker alert for a person found lying', () => {
    const l = new PoseRuleLedger();
    const r2 = { ...rule, lyingStillSeconds: 60 };
    expect(hold(l, DOWN, 0, 59, c, r2)).toBeNull();
    expect(hold(l, DOWN, 60, 62, c, r2)).toMatchObject({ kind: 'LYING_STILL' });
    expect(hold(l, DOWN, 63, 120, c, r2)).toBeNull();
  });

  it('moving about while down restarts the clock but a seen fall stays seen', () => {
    const l = new PoseRuleLedger();
    step(l, UP, 0);
    step(l, DOWN, 1);
    step(l, DOWN, 8, { x: 0.5, y: 0.7 });
    expect(step(l, DOWN, 9, { x: 0.6, y: 0.7 })).toBeNull(); // moved 0.1, clock restarts at 9
    expect(step(l, DOWN, 18, { x: 0.6, y: 0.7 })).toBeNull();
    expect(step(l, DOWN, 19.5, { x: 0.6, y: 0.7 })).toMatchObject({ kind: 'FALL' });
  });

  it('unknown postures neither confirm nor reset', () => {
    const l = new PoseRuleLedger();
    step(l, UP, 0);
    step(l, DOWN, 1);
    expect(step(l, UNK, 6)).toBeNull();
    expect(step(l, DOWN, 12)).toMatchObject({ kind: 'FALL' });
  });

  it('leaving the zone forgets the person; a gap in samples starts the story over', () => {
    const l = new PoseRuleLedger();
    step(l, UP, 0);
    step(l, DOWN, 1);
    expect(step(l, DOWN, 5, { x: 2, y: 2 })).toBeNull(); // outside
    expect(l.sizes().down).toBe(0);
    step(l, UP, 10);
    step(l, DOWN, 11);
    expect(step(l, DOWN, 11 + SAMPLE_GAP_MS / 1000 + 5)).toBeNull(); // too long without samples: fresh, no seen fall
    expect(l.sizes().down).toBe(1);
  });

  it('reports a box-based reading as such', () => {
    const l = new PoseRuleLedger();
    const BOX_UP = { posture: 'UPRIGHT' as const, basis: 'box' as const };
    const BOX_DOWN = { posture: 'LYING' as const, basis: 'box' as const };
    step(l, BOX_UP, 0);
    expect(hold(l, BOX_DOWN, 1, 14)).toMatchObject({ kind: 'FALL', basis: 'box', torsoAngle: null });
  });

  it('tracks are independent', () => {
    const l = new PoseRuleLedger();
    l.evaluatePersonDown(rule, 'a', UP, c, 0);
    let a: any = null;
    let b: any = null;
    for (let t = 1; t <= 14; t++) {
      a = a ?? l.evaluatePersonDown(rule, 'a', DOWN, c, t * 1000);
      b = b ?? l.evaluatePersonDown(rule, 'b', DOWN, c, t * 1000);
    }
    expect(b).toBeNull(); // b was never seen upright
    expect(a).toMatchObject({ kind: 'FALL' });
  });
});

describe('fence climb', () => {
  // Fence base along y = 0.7 from left to right; top along y = 0.4. Looking from A (left) to B (right) on the picture,
  // the area below the line (larger y) is on the RIGHT; above it is on the LEFT.
  const base: [any, any] = [{ x: 0.1, y: 0.7 }, { x: 0.9, y: 0.7 }];
  const top: [any, any] = [{ x: 0.1, y: 0.4 }, { x: 0.9, y: 0.4 }];
  const rule: FenceClimbRuleInput = { id: 'f1', polygon: ZONE, base, top, protectedSide: 'LEFT', climbSeconds: 1.5 };

  /** Hips at (0.5, hipY), wrists at wristY. Outer side = below the base line (larger y). */
  const person = (hipY: number, wristY: number) => pose({ leftHip: [0.48, hipY], rightHip: [0.52, hipY], leftWrist: [0.47, wristY], rightWrist: [0.53, wristY] });
  const step = (l: PoseRuleLedger, kps: Keypoint[] | null, tSec: number, r = rule) => l.evaluateFenceClimb(r, 't1', kps, { x: 0.5, y: 0.65 }, tSec * 1000);

  it('helpers: side and distance to a segment', () => {
    expect(sideOf({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 0.5 })).toBeGreaterThan(0); // below = right
    expect(sideOf({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: -0.5 })).toBeLessThan(0);
    expect(distanceToSegment({ x: 0.5, y: 0.3 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0.3, 6);
    expect(distanceToSegment({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(1, 6); // beyond the end
  });

  it('CLIMBING after a wrist stays above the fence top, at the fence, for the time; once', () => {
    const l = new PoseRuleLedger();
    expect(step(l, person(0.72, 0.3), 0)).toBeNull();
    expect(step(l, person(0.72, 0.3), 1)).toBeNull();
    const r = step(l, person(0.72, 0.3), 1.6);
    expect(r).toMatchObject({ stage: 'CLIMBING', ruleId: 'f1', trackId: 't1' });
    expect(step(l, person(0.72, 0.3), 3)).toBeNull();
  });

  it('CROSSED when the hips end up on the protected side after climbing, once', () => {
    const l = new PoseRuleLedger();
    step(l, person(0.72, 0.3), 0);
    step(l, person(0.72, 0.3), 1.6);
    const r = step(l, person(0.66, 0.5), 4); // hips now above the base line = protected side, hands down
    expect(r).toMatchObject({ stage: 'CROSSED' });
    expect(step(l, person(0.6, 0.5), 6)).toBeNull();
  });

  it('a hand wave away from the fence is nothing', () => {
    const l = new PoseRuleLedger();
    const far = pose({ leftHip: [0.48, 0.95], rightHip: [0.52, 0.95], leftWrist: [0.47, 0.3], rightWrist: [0.53, 0.3] }); // 0.25 from the base line
    for (let t = 0; t < 10; t += 0.5) expect(step(l, far, t)).toBeNull();
  });

  it('hands below the fence top at the fence are nothing', () => {
    const l = new PoseRuleLedger();
    for (let t = 0; t < 10; t += 0.5) expect(step(l, person(0.72, 0.55), t)).toBeNull();
  });

  it('someone who starts on the protected side never alerts (a guard inside)', () => {
    const l = new PoseRuleLedger();
    for (let t = 0; t < 10; t += 0.5) expect(step(l, person(0.66, 0.3), t)).toBeNull();
    expect(step(l, person(0.6, 0.5), 11)).toBeNull();
  });

  it('crossing without ever raising a hand over the top is not a climb (use a tripwire for that)', () => {
    const l = new PoseRuleLedger();
    expect(step(l, person(0.8, 0.6), 0)).toBeNull();
    expect(step(l, person(0.6, 0.5), 3)).toBeNull();
  });

  it('does nothing without a usable pose or hips, and forgets a person outside the zone', () => {
    const l = new PoseRuleLedger();
    expect(step(l, null, 0)).toBeNull();
    expect(step(l, pose({}), 0)).toBeNull(); // everything weak
    expect(l.evaluateFenceClimb(rule, 't9', person(0.72, 0.3), { x: 3, y: 3 }, 0)).toBeNull();
    expect(l.sizes().climbs).toBe(0);
  });

  it('CROSSED is not raised long after the climb (maxClimbSeconds)', () => {
    const l = new PoseRuleLedger();
    step(l, person(0.72, 0.3), 0);
    step(l, person(0.72, 0.3), 1.6);
    expect(step(l, person(0.66, 0.5), 200, { ...rule, maxClimbSeconds: 30 })).toBeNull();
  });

  it('protectedSide RIGHT flips the sides', () => {
    const l = new PoseRuleLedger();
    const r = { ...rule, protectedSide: 'RIGHT' as const };
    // outer is now above the base line (smaller y), protected below
    step(l, person(0.68, 0.3), 0, r);
    step(l, person(0.68, 0.3), 1.6, r);
    expect(step(l, person(0.74, 0.5), 4, r)).toMatchObject({ stage: 'CROSSED' });
  });
});
