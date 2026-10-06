/**
 * Real RTMPose-s model on a real photograph of a person (the public-domain astronaut picture used by the other golden
 * fixtures), through the worker's own preprocessing, session and decoder. There is no reference implementation to
 * compare to here, so this checks what any correct pose estimator must satisfy on this picture: the keypoints are inside
 * the person's box, in anatomical order (eyes above shoulders above elbows), left and right on the correct sides, and
 * the upper-body keypoints are confident. It does not measure accuracy on camera footage.
 *
 * Needs the model file (scripts/models/fetch-model.sh rtmpose-s-body7-256x192). Skipped when absent unless
 * VIGILONE_REQUIRE_MODEL_TESTS=1 (set in CI), in which case it fails.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { artifactPathFor, findCandidateEntry } from '../modelCatalog';
import { OrtSession } from '../anpr/ortSession';
import { PoseEstimator, KEYPOINT_NAMES } from '../poseEstimator';
import { FrameGeometry } from '../types';

const GOLDEN = path.join(__dirname, 'fixtures', 'golden');
const geometry = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'inputs', 'geometry.json'), 'utf8'))['astronaut_416.png'].geometry as FrameGeometry;
const entry = findCandidateEntry('rtmpose-s-body7-256x192');
const artifact = artifactPathFor(entry);
const present = fs.existsSync(artifact);
const requireModels = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';

if (!present && requireModels) {
  test('rtmpose: model artefact required (VIGILONE_REQUIRE_MODEL_TESTS=1)', () => {
    throw new Error(`Model file ${artifact} missing; run scripts/models/fetch-model.sh rtmpose-s-body7-256x192`);
  });
}

(present ? describe : describe.skip)('golden: RTMPose-s on a real photograph', () => {
  const kp = (r: any, n: (typeof KEYPOINT_NAMES)[number]) => r.keypoints[KEYPOINT_NAMES.indexOf(n)];
  let result: any;

  beforeAll(async () => {
    const model = fs.readFileSync(artifact);
    const frame = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(GOLDEN, 'inputs', 'astronaut_416.png'), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    const est = new PoseEstimator(await OrtSession.create(model));
    // The person's box in the picture: COCO annotation [18, 14, 344, 498] of 512x512 (tools/eval/sample).
    result = await est.estimate(frame, geometry, { x: 18 / 512, y: 14 / 512, width: 344 / 512, height: 498 / 512 });
  });

  it('returns 17 keypoints with finite coordinates', () => {
    expect(result.keypoints).toHaveLength(17);
    for (const k of result.keypoints) {
      expect(Number.isFinite(k.x) && Number.isFinite(k.y)).toBe(true);
      expect(k.score).toBeGreaterThanOrEqual(0);
      expect(k.score).toBeLessThanOrEqual(1);
    }
  });

  it('puts the upper-body keypoints inside the person box and confident', () => {
    const box = { x1: 18 / 512, x2: 362 / 512, y1: 14 / 512, y2: 512 / 512 };
    for (const n of ['nose', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow'] as const) {
      const k = kp(result, n);
      expect(k.x).toBeGreaterThan(box.x1);
      expect(k.x).toBeLessThan(box.x2);
      expect(k.y).toBeGreaterThan(box.y1);
      expect(k.y).toBeLessThan(box.y2);
    }
    for (const n of ['nose', 'left_shoulder', 'right_shoulder'] as const) expect(kp(result, n).score).toBeGreaterThan(0.4);
  });

  it('is in anatomical order: head above shoulders above elbows', () => {
    const nose = kp(result, 'nose');
    const shoulders = (kp(result, 'left_shoulder').y + kp(result, 'right_shoulder').y) / 2;
    const elbows = (kp(result, 'left_elbow').y + kp(result, 'right_elbow').y) / 2;
    expect(nose.y).toBeLessThan(shoulders);
    expect(shoulders).toBeLessThan(elbows);
  });

  it('keeps the person facing the camera: her left shoulder is on the image right of her right shoulder', () => {
    expect(kp(result, 'left_shoulder').x).toBeGreaterThan(kp(result, 'right_shoulder').x);
  });
});
