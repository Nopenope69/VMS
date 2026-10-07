import { spawnSync } from 'child_process';
import path from 'path';
import { SabotageDetector, SabotageFinding, SabotageType, analyseFrame, ncc } from '../sabotageDetector';
import { FrameGeometry, VideoFrame } from '../types';

/**
 * Real photographs (the golden fixtures) decoded and altered by real ffmpeg filters, with per-frame sensor noise:
 * a cover over the lens, a defocused lens, a camera turned away, a light shone into it, and the changes that must
 * NOT raise anything (dusk, night, a person walking through, a small nudge).
 */
const FIXTURES = path.join(__dirname, 'fixtures', 'golden', 'source');
const W = 640;
const H = 360;
const NOISE = 'noise=alls=8:allf=t';
const GEOMETRY: FrameGeometry = { sourceWidth: W, sourceHeight: H, modelWidth: W, modelHeight: H, scale: 1, padX: 0, padY: 0 };

const FILTERS: Record<string, string> = {
  normal: NOISE,
  dusk: `eq=brightness=-0.25:contrast=0.7,${NOISE}`,
  night: `eq=brightness=-0.4:contrast=0.4,${NOISE}`,
  person: `drawbox=x=200:y=100:w=80:h=200:color=red@1:t=fill,${NOISE}`,
  nudged: `crop=iw*0.95:ih*0.95:iw*0.05:ih*0.03,scale=${W}:${H},${NOISE}`,
  covered: `drawbox=x=0:y=0:w=iw:h=ih:color=gray@1:t=fill,${NOISE}`,
  coveredBlack: `drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill,${NOISE}`,
  defocused: `gblur=sigma=6,${NOISE}`,
  handOverLens: `gblur=sigma=40,eq=brightness=-0.3,${NOISE}`,
  moved: `crop=iw*0.7:ih*0.7:iw*0.3:ih*0.3,scale=${W}:${H},${NOISE}`,
  blinded: `eq=brightness=0.7:contrast=0.5,${NOISE}`,
};

const cache = new Map<string, Buffer[]>();
function render(image: string, filter: string, frames = 4, extra = ''): Buffer[] {
  const key = `${image}|${filter}|${frames}|${extra}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const vf = `scale=${W}:${H},${FILTERS[filter]}${extra}`;
  const r = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-loop', '1', '-i', path.join(FIXTURES, image), '-vf', vf, '-frames:v', String(frames), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 }
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`);
  const size = r.stdout.length / frames;
  const out = Array.from({ length: frames }, (_, i) => r.stdout.subarray(i * size, (i + 1) * size));
  cache.set(key, out);
  return out;
}

const T0 = Date.UTC(2026, 9, 7, 10, 0, 0);
function frame(data: Buffer, second: number, opts: { cameraId?: string; width?: number; height?: number; geometry?: FrameGeometry } = {}): VideoFrame {
  return {
    cameraId: opts.cameraId ?? 'cam-1',
    tenantId: 'tenant-1',
    streamPath: 'cam-1/sub',
    streamSessionId: 's',
    sequenceNumber: second,
    sampledAt: new Date(T0 + second * 1000),
    receivedAt: new Date(T0 + second * 1000),
    width: opts.width ?? W,
    height: opts.height ?? H,
    channels: 3,
    data,
    geometry: opts.geometry ?? GEOMETRY,
  };
}

/** Learns the normal view for `learn` seconds, then shows `filter` for `seconds`; returns all findings and the clock. */
function run(det: SabotageDetector, image: string, filter: string, seconds: number, start = 0, learn = 20): { findings: SabotageFinding[]; t: number } {
  const findings: SabotageFinding[] = [];
  const normal = render(image, 'normal');
  let t = start;
  for (let i = 0; i < learn; i++) findings.push(...det.observe(frame(normal[i % normal.length], t++)));
  const shown = render(image, filter);
  for (let i = 0; i < seconds; i++) findings.push(...det.observe(frame(shown[i % shown.length], t++)));
  return { findings, t };
}

const IMAGES = ['chelsea.png', 'coffee.png', 'astronaut.png', 'camera.png'];

describe('SabotageDetector on real decoded frames', () => {
  const expected: Array<[string, SabotageType]> = [
    ['covered', 'OCCLUSION'],
    ['coveredBlack', 'OCCLUSION'],
    ['defocused', 'DEFOCUS'],
    ['handOverLens', 'DEFOCUS'],
    ['moved', 'DISPLACEMENT'],
    ['blinded', 'BLINDED'],
  ];
  for (const image of IMAGES) {
    for (const [filter, type] of expected) {
      it(`${image}: ${filter} is reported once as ${type} after the hold time`, () => {
        const det = new SabotageDetector({ holdMs: 10_000 });
        const { findings } = run(det, image, filter, 30);
        expect(findings.map((f) => [f.state, f.type])).toEqual([['CONFIRMED', type]]);
        const f = findings[0];
        expect(f.confirmedAt.getTime() - f.startedAt.getTime()).toBeGreaterThanOrEqual(10_000);
        expect(f.startedAt.getTime()).toBe(T0 + 20_000); // the first altered frame
        expect(f.score).toBeGreaterThanOrEqual(f.threshold);
        expect(f.cameraId).toBe('cam-1');
        expect(f.tenantId).toBe('tenant-1');
      });
    }
    for (const filter of ['dusk', 'night', 'person', 'nudged', 'normal']) {
      it(`${image}: ${filter} raises nothing`, () => {
        const det = new SabotageDetector();
        expect(run(det, image, filter, 60).findings).toEqual([]);
      });
    }
  }

  it('measures only the picture inside letterbox padding', () => {
    const plain = render('chelsea.png', 'normal')[0];
    const padded = render('chelsea.png', 'normal', 4, ',pad=640:640:0:140:black')[0];
    const geometry: FrameGeometry = { sourceWidth: W, sourceHeight: H, modelWidth: 640, modelHeight: 640, scale: 1, padX: 0, padY: 140, scaledWidth: W, scaledHeight: H };
    const a = analyseFrame({ data: plain, width: W, height: H, geometry: GEOMETRY })!;
    const b = analyseFrame({ data: padded, width: 640, height: 640, geometry })!;
    expect(b.darkFraction).toBeCloseTo(a.darkFraction, 2);
    expect(b.meanLuma).toBeCloseTo(a.meanLuma, 0);
    expect(ncc(a.thumb, b.thumb)).toBeGreaterThan(0.99);
  });
});

describe('SabotageDetector timing', () => {
  const image = 'coffee.png';

  it('does not report a cover shorter than the hold time', () => {
    const det = new SabotageDetector({ holdMs: 10_000 });
    const normal = render(image, 'normal');
    const covered = render(image, 'covered');
    const findings: SabotageFinding[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) findings.push(...det.observe(frame(normal[i % 4], t++)));
    for (let i = 0; i < 8; i++) findings.push(...det.observe(frame(covered[i % 4], t++)));
    for (let i = 0; i < 40; i++) findings.push(...det.observe(frame(normal[i % 4], t++)));
    expect(findings).toEqual([]);
  });

  it('learns before judging: a covered camera at start-up is not compared with anything', () => {
    const det = new SabotageDetector({ learnFrames: 20 });
    const covered = render(image, 'covered');
    for (let t = 0; t < 19; t++) {
      expect(det.observe(frame(covered[t % 4], t))).toEqual([]);
      expect(det.isReady('cam-1')).toBe(false);
    }
  });

  it('a camera covered while learning starts being checked a few minutes after it is uncovered', () => {
    const det = new SabotageDetector({ holdMs: 10_000 });
    const normal = render(image, 'normal');
    const covered = render(image, 'covered');
    const out: SabotageFinding[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    for (let i = 0; i < 180; i++) out.push(...det.observe(frame(normal[i % 4], t++)));
    expect(out).toEqual([]); // uncovering is not reported
    for (let i = 0; i < 15; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out.map((f) => f.type)).toEqual(['OCCLUSION']);
  });

  it('one odd frame inside the hold does not restart it; a longer break does', () => {
    const det = new SabotageDetector({ holdMs: 10_000, graceMs: 3_000 });
    const normal = render(image, 'normal');
    const covered = render(image, 'covered');
    let t = 0;
    for (let i = 0; i < 20; i++) det.observe(frame(normal[i % 4], t++));
    const out: SabotageFinding[] = [];
    for (let i = 0; i < 5; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    out.push(...det.observe(frame(normal[0], t++))); // one clean frame
    for (let i = 0; i < 5; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out.map((f) => f.type)).toEqual(['OCCLUSION']);
    expect(out[0].startedAt.getTime()).toBe(T0 + 20_000);

    const det2 = new SabotageDetector({ holdMs: 10_000, graceMs: 3_000 });
    t = 0;
    for (let i = 0; i < 20; i++) det2.observe(frame(normal[i % 4], t++));
    const out2: SabotageFinding[] = [];
    for (let i = 0; i < 6; i++) out2.push(...det2.observe(frame(covered[i % 4], t++)));
    for (let i = 0; i < 5; i++) out2.push(...det2.observe(frame(normal[i % 4], t++)));
    for (let i = 0; i < 6; i++) out2.push(...det2.observe(frame(covered[i % 4], t++)));
    expect(out2).toEqual([]);
  });

  it('reports once while it lasts, and again only after it has cleared', () => {
    const det = new SabotageDetector({ holdMs: 10_000, clearMs: 30_000 });
    const normal = render(image, 'normal');
    const covered = render(image, 'covered');
    let t = 0;
    const out: SabotageFinding[] = [];
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(normal[i % 4], t++)));
    for (let i = 0; i < 120; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out).toHaveLength(1);
    expect(det.activeConditions('cam-1')).toEqual(['OCCLUSION']);
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(normal[i % 4], t++))); // shorter than clearMs
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out).toHaveLength(1);
    const lastCovered = t - 1;
    for (let i = 0; i < 40; i++) out.push(...det.observe(frame(normal[i % 4], t++)));
    expect(det.activeConditions('cam-1')).toEqual([]);
    // Its end is reported once, clearMs after the last covered frame, with the original start and confirmation.
    expect(out.map((f) => [f.state, f.type])).toEqual([['CONFIRMED', 'OCCLUSION'], ['CLEARED', 'OCCLUSION']]);
    const end = out[1];
    expect(end.clearReason).toBe('RESTORED');
    expect(end.clearedAt!.getTime()).toBe(T0 + (lastCovered + 30) * 1000);
    expect(end.startedAt).toEqual(out[0].startedAt);
    expect(end.confirmedAt).toEqual(out[0].confirmedAt);
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out.map((f) => [f.state, f.type])).toEqual([['CONFIRMED', 'OCCLUSION'], ['CLEARED', 'OCCLUSION'], ['CONFIRMED', 'OCCLUSION']]);
  });

  it('a camera that stays moved learns its new view after relearnMs, and is then quiet', () => {
    const det = new SabotageDetector({ holdMs: 10_000, relearnMs: 60_000 });
    const normal = render(image, 'normal');
    const moved = render(image, 'moved');
    let t = 0;
    const out: SabotageFinding[] = [];
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(normal[i % 4], t++)));
    for (let i = 0; i < 300; i++) out.push(...det.observe(frame(moved[i % 4], t++)));
    expect(out.map((f) => [f.state, f.type, f.clearReason])).toEqual([
      ['CONFIRMED', 'DISPLACEMENT', undefined],
      ['CLEARED', 'DISPLACEMENT', 'RELEARNED'],
    ]);
    expect(out[1].clearedAt!.getTime() - out[0].confirmedAt.getTime()).toBe(60_000);
    expect(det.activeConditions('cam-1')).toEqual([]);
    // Moving it back to the original view is a move too.
    for (let i = 0; i < 30; i++) out.push(...det.observe(frame(normal[i % 4], t++)));
    expect(out.filter((f) => f.state === 'CONFIRMED').map((f) => f.type)).toEqual(['DISPLACEMENT', 'DISPLACEMENT']);
  });

  it('a gap in the stream drops a suspected condition', () => {
    const det = new SabotageDetector({ holdMs: 10_000, maxGapMs: 60_000 });
    const normal = render(image, 'normal');
    const covered = render(image, 'covered');
    let t = 0;
    const out: SabotageFinding[] = [];
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(normal[i % 4], t++)));
    for (let i = 0; i < 6; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    t += 120; // stream down for two minutes
    for (let i = 0; i < 6; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out).toEqual([]);
    for (let i = 0; i < 6; i++) out.push(...det.observe(frame(covered[i % 4], t++)));
    expect(out.map((f) => f.type)).toEqual(['OCCLUSION']);
    expect(out[0].startedAt.getTime()).toBe(T0 + (20 + 6 + 120) * 1000);
  });

  it('keeps cameras apart', () => {
    const det = new SabotageDetector({ holdMs: 10_000 });
    const normal = render(image, 'normal');
    const covered = render(image, 'covered');
    const out: SabotageFinding[] = [];
    for (let t = 0; t < 20; t++) {
      out.push(...det.observe(frame(normal[t % 4], t, { cameraId: 'a' })));
      out.push(...det.observe(frame(normal[t % 4], t, { cameraId: 'b' })));
    }
    for (let t = 20; t < 40; t++) {
      out.push(...det.observe(frame(covered[t % 4], t, { cameraId: 'a' })));
      out.push(...det.observe(frame(normal[t % 4], t, { cameraId: 'b' })));
    }
    expect(out.map((f) => [f.cameraId, f.type])).toEqual([['a', 'OCCLUSION']]);
    det.forget('a');
    expect(det.isReady('a')).toBe(false);
    expect(det.isReady('b')).toBe(true);
  });

  it('a scene with almost no detail is only judged for glare', () => {
    const det = new SabotageDetector({ holdMs: 5_000 });
    const flat = Buffer.alloc(W * H * 3, 90);
    const out: SabotageFinding[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(flat, t++)));
    const black = Buffer.alloc(W * H * 3, 2);
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(black, t++)));
    expect(out).toEqual([]);
    const white = Buffer.alloc(W * H * 3, 255);
    for (let i = 0; i < 20; i++) out.push(...det.observe(frame(white, t++)));
    expect(out.map((f) => f.type)).toEqual(['BLINDED']);
  });

  it('ignores a frame whose buffer is shorter than its size', () => {
    const det = new SabotageDetector();
    expect(det.observe(frame(Buffer.alloc(10), 0))).toEqual([]);
    expect(det.isReady('cam-1')).toBe(false);
  });
});
