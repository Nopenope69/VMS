import { MotionGate, meanAbsDiff, sampleGrey } from '../motionGate';
import { VideoFrame } from '../types';

function frame(cameraId: string, level: number, w = 32, h = 32): VideoFrame {
  return {
    cameraId, tenantId: 't', streamPath: 'p', streamSessionId: 's', sequenceNumber: 1,
    sampledAt: new Date(), receivedAt: new Date(), width: w, height: h, channels: 3,
    data: Buffer.alloc(w * h * 3, level),
    geometry: { sourceWidth: w, sourceHeight: h, modelWidth: w, modelHeight: h, scale: 1, padX: 0, padY: 0 },
  };
}

describe('MotionGate (P2.5)', () => {
  let now = 0;
  const clock = () => now;
  beforeEach(() => {
    now = 1_000_000;
  });

  it('infers the first frame, then skips a static scene until the keep-alive interval', () => {
    const g = new MotionGate({ now: clock, keepAliveMs: 30000, maxInferencesPerSecond: 100 });
    expect(g.decide(frame('c', 100), false)).toEqual({ run: true, reason: 'pixel_change' });
    now += 1000;
    expect(g.decide(frame('c', 100), false)).toEqual({ run: false, reason: 'static_scene' });
    now += 30000;
    expect(g.decide(frame('c', 100), false)).toEqual({ run: true, reason: 'keepalive' });
  });

  it('infers when the picture changes beyond the threshold', () => {
    const g = new MotionGate({ now: clock, diffThreshold: 6, maxInferencesPerSecond: 100 });
    g.decide(frame('c', 100), false);
    now += 1000;
    expect(g.decide(frame('c', 103), false).run).toBe(false); // 3 grey levels: noise
    now += 1000;
    expect(g.decide(frame('c', 120), false)).toEqual({ run: true, reason: 'pixel_change' });
  });

  it('always infers on armed cameras (rules need continuous tracks) and while tracks are live', () => {
    const g = new MotionGate({ now: clock, maxInferencesPerSecond: 100 });
    g.setActivity({ armed: { armed: true } });
    g.decide(frame('armed', 100), false);
    now += 1000;
    expect(g.decide(frame('armed', 100), false)).toEqual({ run: true, reason: 'armed' });
    g.decide(frame('idle', 100), false);
    now += 1000;
    expect(g.decide(frame('idle', 100), true)).toEqual({ run: true, reason: 'active_tracks' });
  });

  it('holds inference open after backend-reported motion (classical scene detector)', () => {
    const g = new MotionGate({ now: clock, motionHoldMs: 10000, maxInferencesPerSecond: 100 });
    g.decide(frame('c', 100), false);
    g.setActivity({ c: { armed: false, lastMotionAt: now } });
    now += 5000;
    expect(g.decide(frame('c', 100), false)).toEqual({ run: true, reason: 'backend_motion' });
    now += 6000;
    expect(g.decide(frame('c', 100), false).run).toBe(false);
  });

  it('enforces the global frame budget across cameras', () => {
    const g = new MotionGate({ now: clock, mode: 'off', maxInferencesPerSecond: 2 });
    const d = ['a', 'b', 'c', 'd'].map((c) => g.decide(frame(c, 1), false));
    expect(d.map((x) => x.run)).toEqual([true, true, false, false]);
    expect(d[2]).toEqual({ run: false, reason: 'budget_exhausted' });
    now += 1000; // refills 2 tokens
    expect(g.decide(frame('a', 1), false).run).toBe(true);
  });

  it('grey sampling and difference helpers', () => {
    const a = sampleGrey(frame('c', 10, 16, 16), 8);
    const b = sampleGrey(frame('c', 30, 16, 16), 8);
    expect(a.length).toBe(4);
    expect(meanAbsDiff(a, b)).toBeCloseTo(20, 0);
    expect(meanAbsDiff(a, new Uint8Array(1))).toBe(Number.POSITIVE_INFINITY);
  });
});
