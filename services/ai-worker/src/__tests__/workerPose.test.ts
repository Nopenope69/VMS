import { AiWorker, DEFAULT_POSE_INTERVAL_MS } from '../worker';
import { NUM_KEYPOINTS, POSE_METHOD } from '../poseEstimator';

const geometry: any = { sourceWidth: 416, sourceHeight: 416, modelWidth: 416, modelHeight: 416, scale: 1, padX: 0, padY: 0, scaledWidth: 416, scaledHeight: 416 };
const frame = Buffer.alloc(416 * 416 * 3);
const model = { name: 'rtmpose-s-body7-256x192', version: 'v', sha256: 'a'.repeat(64) };

const keypoints = Array.from({ length: NUM_KEYPOINTS }, (_, i) => ({ x: i / 100 + 0.123456, y: 0.5, score: 0.9 }));
const fakeEstimator = (impl?: () => any) => ({ estimate: jest.fn(impl ?? (async () => ({ method: POSE_METHOD, keypoints, meanScore: 0.9 }))) }) as any;

const ev = (over: any = {}) => ({
  cameraId: 'cam1',
  trackId: 't1',
  objectClass: 'person',
  boundingBox: { x: 0.3, y: 0.2, width: 0.2, height: 0.6 },
  attributesJson: { colour: { upper: 'red' } },
  ...over,
});

function worker() {
  return new AiWorker({ backendBaseUrl: 'http://127.0.0.1:4000', internalSecret: 's' }) as any;
}
const attach = (w: any, e: any, budget = { left: 4 }, now = 1_000_000) => w.attachPose(e, frame, geometry, budget, now);

describe('AiWorker pose attachment', () => {
  it('does nothing until an estimator is set', async () => {
    const w = worker();
    const e = ev();
    await attach(w, e);
    expect(e.attributesJson.pose).toBeUndefined();
  });

  it('adds rounded keypoints, the method and the pinned model, and keeps other attributes', async () => {
    const w = worker();
    const est = fakeEstimator();
    w.setPoseEstimator({ estimator: est, model });
    const e = ev();
    await attach(w, e);
    expect(est.estimate).toHaveBeenCalledWith(frame, geometry, e.boundingBox);
    expect(e.attributesJson.colour).toEqual({ upper: 'red' });
    const p = e.attributesJson.pose;
    expect(p.method).toBe(POSE_METHOD);
    expect(p.model).toEqual(model);
    expect(p.keypoints).toHaveLength(17);
    expect(p.keypoints[0]).toEqual([0.1235, 0.5, 0.9]);
    expect(p.meanScore).toBe(0.9);
  });

  it('only runs for persons with a track and a box', async () => {
    const w = worker();
    const est = fakeEstimator();
    w.setPoseEstimator({ estimator: est, model });
    for (const e of [ev({ objectClass: 'car' }), ev({ trackId: undefined }), ev({ boundingBox: undefined })]) {
      await attach(w, e);
      expect(e.attributesJson.pose).toBeUndefined();
    }
    expect(est.estimate).not.toHaveBeenCalled();
  });

  it('limits one track to one pose per interval', async () => {
    const w = worker();
    const est = fakeEstimator();
    w.setPoseEstimator({ estimator: est, model });
    await attach(w, ev(), { left: 4 }, 1_000_000);
    await attach(w, ev(), { left: 4 }, 1_000_000 + DEFAULT_POSE_INTERVAL_MS - 1);
    expect(est.estimate).toHaveBeenCalledTimes(1);
    await attach(w, ev(), { left: 4 }, 1_000_000 + DEFAULT_POSE_INTERVAL_MS);
    expect(est.estimate).toHaveBeenCalledTimes(2);
    await attach(w, ev({ trackId: 't2' }), { left: 4 }, 1_000_000 + DEFAULT_POSE_INTERVAL_MS);
    expect(est.estimate).toHaveBeenCalledTimes(3); // another track is independent
  });

  it('stops at the per-frame budget', async () => {
    const w = worker();
    const est = fakeEstimator();
    w.setPoseEstimator({ estimator: est, model });
    const budget = { left: 2 };
    const events = [ev({ trackId: 'a' }), ev({ trackId: 'b' }), ev({ trackId: 'c' })];
    for (const e of events) await attach(w, e, budget);
    expect(events.map((e) => !!e.attributesJson.pose)).toEqual([true, true, false]);
  });

  it('never throws: a failing estimator counts a failure and the detection goes on without pose', async () => {
    const w = worker();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    w.setPoseEstimator({ estimator: fakeEstimator(async () => { throw new Error('model broke'); }), model });
    const e = ev();
    await expect(attach(w, e)).resolves.toBeUndefined();
    expect(e.attributesJson.pose).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('model broke'));
    warn.mockRestore();
  });

  it('a box too small to read adds nothing and does not start the interval', async () => {
    const w = worker();
    const est = fakeEstimator(async () => null);
    w.setPoseEstimator({ estimator: est, model });
    const e = ev();
    await attach(w, e, { left: 4 }, 1_000_000);
    expect(e.attributesJson.pose).toBeUndefined();
    await attach(w, ev(), { left: 4 }, 1_000_001);
    expect(est.estimate).toHaveBeenCalledTimes(2);
  });
});
