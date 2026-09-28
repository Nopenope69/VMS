import { buildMaskFilter, planMasks, SampledDetection } from '../services/privacy/maskPlanner';

const opts = { fps: 4, durationSec: 10, frameWidth: 1280, frameHeight: 720, margin: 0.1, mergeAreaFactor: 1.3 };
const face = (t: number, x: number, y = 100, s = 100): SampledDetection => ({ kind: 'FACE', t, box: [x, y, x + s, y + s], score: 0.9 });

describe('planMasks', () => {
  it('holds an isolated detection for one sample interval each side, with a margin', () => {
    const m = planMasks([face(2, 500)], opts);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'FACE', x: 490, y: 90, width: 120, height: 120, startSec: 1.75, endSec: 2.25 });
  });

  it('covers a moving face continuously between samples', () => {
    // 40 px per sample (160 px/s), 3 s of samples
    const dets = Array.from({ length: 13 }, (_, i) => face(i * 0.25, 100 + i * 40));
    const masks = planMasks(dets, opts);
    // every sampled position, and the midpoint between samples, lies inside a mask active then
    for (let k = 0; k < 24; k++) {
      const t = k * 0.125;
      const i = Math.min(12, t / 0.25);
      const cx = 100 + i * 40 + 50;
      const covered = masks.some((m) => m.startSec <= t && m.endSec >= t && m.x <= cx - 50 && m.x + m.width >= cx + 50 && m.y <= 100 && m.y + m.height >= 200);
      expect(covered).toBe(true);
    }
    // merging keeps the filter far smaller than one box per piece
    expect(masks.length).toBeLessThan(25);
    expect(new Set(masks.map((m) => m.track)).size).toBe(1);
  });

  it('keeps separate tracks for two distant faces and clamps to the clip and frame', () => {
    const m = planMasks([face(0, 0, 0), face(0, 1200, 650, 100)], opts);
    expect(m).toHaveLength(2);
    expect(m[0].startSec).toBe(0);
    const right = m.find((x) => x.x > 600)!;
    expect(right.x + right.width).toBeLessThanOrEqual(1280);
    expect(right.y + right.height).toBeLessThanOrEqual(720);
  });

  it('does not link across a gap of more than one and a half sample intervals', () => {
    const m = planMasks([face(1, 500), face(3, 500)], opts);
    expect(m.some((x) => x.startSec < 2 && x.endSec > 2.5)).toBe(false);
  });

  it('plans faces and plates independently', () => {
    const m = planMasks([face(1, 100), { kind: 'LICENSE_PLATE', t: 1, box: [120, 120, 260, 160], score: 0.7 }], opts);
    expect(m.map((x) => x.kind).sort()).toEqual(['FACE', 'LICENSE_PLATE']);
  });
});

describe('buildMaskFilter', () => {
  it('draws opaque boxes with millisecond time windows, clamped to the frame', () => {
    const f = buildMaskFilter([{ kind: 'FACE', x: 1250, y: -5, width: 100, height: 50, startSec: 1.2346, endSec: 2.0001 }], 1280, 720);
    expect(f).toBe("drawbox=x=1250:y=0:w=30:h=50:color=black@1.0:t=fill:enable='between(t,1.234,2.001)'");
  });

  it('is a pass-through with no masks', () => {
    expect(buildMaskFilter([], 1280, 720)).toBe('null');
  });
});
