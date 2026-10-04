/**
 * Threat rules without a new model (spatial/engine/threatRules.ts): an unattended bag and movement against a zone's
 * allowed direction. Pure state, normalised image coordinates, synthetic tracks.
 */
import { ThreatRuleLedger, distanceToBox, UnattendedObjectRuleInput, WrongWayRuleInput } from '../services/spatial/engine';

const ZONE = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.9 }, { x: 0.2, y: 0.9 }];
const T0 = 1_000_000;
const s = (sec: number) => T0 + sec * 1000;
const bagRule: UnattendedObjectRuleInput = { id: 'r-bag', polygon: ZONE, thresholdSeconds: 60 };
const BAG = { x: 0.5, y: 0.6 };
const personBox = (x: number, y = 0.4) => ({ x, y, width: 0.06, height: 0.25 });

/** The bag seen once a second from `from` to `to` (inclusive); returns the first alert. */
function watch(l: ThreatRuleLedger, from: number, to: number, opts: { at?: (t: number) => { x: number; y: number }; person?: (t: number) => { x: number; y: number; width: number; height: number } | null; rule?: UnattendedObjectRuleInput } = {}) {
  let alert: any = null;
  for (let t = from; t <= to; t++) {
    const p = opts.person?.(t);
    if (p) l.notePerson('cam', 'p1', p, s(t));
    const r = l.evaluateUnattended(opts.rule ?? bagRule, 'cam', 'bag1', opts.at ? opts.at(t) : BAG, s(t));
    if (r && !alert) alert = { ...r, at: t };
  }
  return alert;
}

describe('distanceToBox', () => {
  it('is 0 inside the box and the gap to the nearest edge outside it', () => {
    expect(distanceToBox({ x: 0.5, y: 0.5 }, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 })).toBe(0);
    expect(distanceToBox({ x: 0.7, y: 0.5 }, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 })).toBeCloseTo(0.1);
    expect(distanceToBox({ x: 0.7, y: 0.7 }, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 })).toBeCloseTo(Math.hypot(0.1, 0.1));
  });
});

describe('unattended object', () => {
  it('alerts once the bag has lain still with nobody near it for the threshold, and only once', () => {
    const l = new ThreatRuleLedger();
    const a = watch(l, 0, 120);
    expect(a).toMatchObject({ ruleId: 'r-bag', trackId: 'bag1', unattendedSeconds: 60, at: 60 });
  });

  it('does not alert while its owner stands next to it, then counts from when the owner walks away', () => {
    const l = new ThreatRuleLedger();
    // Owner beside the bag for 100 s, then gone.
    const a = watch(l, 0, 200, { person: (t) => (t < 100 ? personBox(0.52) : null) });
    // Last seen at 99 s; attended through the 3 s grace (to 102 s), alone from 103 s, alert 60 s later.
    expect(a).toMatchObject({ at: 103 + 60 });
    expect(a.unattendedSeconds).toBe(60);
  });

  it('a person far away does not attend the bag', () => {
    const l = new ThreatRuleLedger();
    expect(watch(l, 0, 70, { person: () => personBox(0.05, 0.05) })).toMatchObject({ at: 60 });
  });

  it('a bag being carried is not left: moving restarts the clock', () => {
    const l = new ThreatRuleLedger();
    // Carried across the zone for 90 s (moves 0.004 per second, beyond the tolerance every 6 s), then put down.
    const a = watch(l, 0, 200, { at: (t) => (t < 90 ? { x: 0.25 + t * 0.004, y: 0.6 } : { x: 0.25 + 90 * 0.004, y: 0.6 }) });
    expect(a.at).toBeGreaterThanOrEqual(90 + 59);
  });

  it('small jitter of the box does not restart the clock', () => {
    const l = new ThreatRuleLedger();
    const a = watch(l, 0, 80, { at: (t) => ({ x: 0.5 + (t % 2 ? 0.008 : -0.008), y: 0.6 }) });
    expect(a).toMatchObject({ at: 60 });
  });

  it('outside the zone nothing happens; a bag left again after being moved alerts again', () => {
    const l = new ThreatRuleLedger();
    expect(watch(l, 0, 100, { at: () => ({ x: 0.1, y: 0.1 }) })).toBeNull();
    const first = watch(l, 0, 70);
    expect(first).not.toBeNull();
    // Picked up and put down 0.2 further on: a new stay, a new alert.
    const second = watch(l, 71, 150, { at: () => ({ x: 0.7, y: 0.6 }) });
    expect(second).toMatchObject({ at: 131 });
  });

  it('honours the owner radius setting', () => {
    const l = new ThreatRuleLedger();
    // Person 0.1 from the bag: inside a 0.15 radius, so the bag is attended.
    expect(watch(l, 0, 100, { person: () => personBox(0.62), rule: { ...bagRule, ownerRadius: 0.15 } })).toBeNull();
    const l2 = new ThreatRuleLedger();
    expect(watch(l2, 0, 100, { person: () => personBox(0.62), rule: { ...bagRule, ownerRadius: 0.05 } })).not.toBeNull();
  });
});

describe('wrong way', () => {
  // A one-way corridor: traffic must go left to right.
  const rule: WrongWayRuleInput = { id: 'r-way', polygon: ZONE, allowed: [{ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }] };
  const walk = (l: ThreatRuleLedger, track: string, xs: number[], y = 0.5) => xs.map((x, i) => l.evaluateWrongWay(rule, track, { x, y }, s(i))).find(Boolean) ?? null;

  it('moving with the arrow is fine', () => {
    expect(walk(new ThreatRuleLedger(), 't1', [0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75])).toBeNull();
  });

  it('moving against the arrow alerts once the track has travelled the minimum distance', () => {
    const l = new ThreatRuleLedger();
    const r = walk(l, 't2', [0.75, 0.72, 0.69, 0.66, 0.6, 0.5, 0.4]);
    expect(r).toMatchObject({ ruleId: 'r-way', trackId: 't2', angleDegrees: 180 });
    expect(r!.travel).toBeGreaterThanOrEqual(0.08);
    // Only once per track.
    expect(l.evaluateWrongWay(rule, 't2', { x: 0.3, y: 0.5 }, s(20))).toBeNull();
  });

  it('crossing the corridor (at right angles) is not wrong way', () => {
    const l = new ThreatRuleLedger();
    expect([0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85].map((y, i) => l.evaluateWrongWay(rule, 't3', { x: 0.5, y }, s(i))).find(Boolean)).toBeUndefined();
  });

  it('a U-turn after travelling the right way is caught', () => {
    const l = new ThreatRuleLedger();
    expect(walk(l, 't4', [0.3, 0.4, 0.5, 0.6, 0.65, 0.55, 0.45])).toMatchObject({ angleDegrees: 180 });
  });

  it('a short jitter backwards (under the minimum travel) does not alert', () => {
    expect(walk(new ThreatRuleLedger(), 't5', [0.5, 0.48, 0.46, 0.5, 0.48])).toBeNull();
  });

  it('leaving the zone forgets the track', () => {
    const l = new ThreatRuleLedger();
    expect(walk(l, 't6', [0.75, 0.7, 0.9, 0.1, 0.75, 0.72])).toBeNull();
  });
});

describe('bounds', () => {
  it('keeps at most 500 people per camera', () => {
    const l = new ThreatRuleLedger();
    for (let i = 0; i < 2000; i++) l.notePerson('cam', `p${i}`, personBox(0.5), s(i));
    expect(l.sizes().persons).toBeLessThanOrEqual(500);
  });
});
