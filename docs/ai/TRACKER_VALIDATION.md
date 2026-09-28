# Tracker and tripwire validation (P2.7)

The in-repo multi-object tracker (`services/ai-worker/src/tracker.ts`, greedy class-scoped IoU
association with constant-velocity prediction) and the spatial engine's tripwire
(`backend/src/services/spatial/engine`, three-state hysteresis) are compared with Roboflow
**supervision** (MIT) on shared, seeded synthetic trajectories.

- Reference generator: `tools/reference/tracker_reference.py` (supervision 0.30.5: `ByteTrack`,
  `LineZone` with the CENTER anchor). Output: `services/ai-worker/src/__tests__/fixtures/tracker/reference.json`.
- Test: `backend/src/__tests__/trackerValidation.test.ts` feeds the same noisy detections (4 px
  noise, one scenario with 15 % detector drop-outs) to our tracker and tripwire.

## Tolerances (enforced by the test)

| Quantity | Tolerance |
| --- | --- |
| ID switches per scenario | at most supervision ByteTrack + 1 |
| Distinct confirmed ids per ground-truth object | at most ByteTrack + 1 |
| Ground-truth objects with a confirmed track | all |
| Line crossings | exactly the ground truth |

Only CONFIRMED tracks are counted on our side, because only those leave the worker.

## Results (run of 2026-09-27)

| Scenario | ID switches ours / ByteTrack | Ids per object ours / ByteTrack | Crossings ours / LineZone / truth |
| --- | --- | --- | --- |
| single walker crossing | 0 / 0 | 1 / 1 | 1 / 1 / 1 |
| two walkers, opposite directions | 0 / 0 | 1,1 / 1,1 | 2 / 2 / 2 |
| crossing paths along the line | 0 / 0 | 1,1 / 1,1 | **0 / 24 / 0** |
| detector drop-outs (person + car) | 0 / 0 | 1,1 / 1,1 | 1 / 1 / 1 |
| person beside a vehicle | 0 / 0 | 1,1 / 1,1 | 2 / 2 / 2 |
| loitering near the line | 0 / 0 | 1 / 1 | 0 / 0 / 0 |

`LineZone` has no hysteresis, so two people walking along the line with 4 px of jitter produce 24
spurious crossings; the spatial engine's ON_LINE buffer produces none. This is the behaviour the
tripwire needs on real CCTV (noisy boxes near a line), and it is why the target is the ground truth,
not LineZone's count.

## What this does not show

- The scenarios are synthetic and simple (constant velocity, at most two objects). Identity metrics
  on real crowded footage (MOTA, IDF1 on labelled site video) are **HUMAN-REQUIRED**: they need
  labelled tracks from real sites.
- `sv.ByteTrack` is deprecated in supervision 0.28+ in favour of the `trackers` package; the
  reference will move to it when it is pinned.
