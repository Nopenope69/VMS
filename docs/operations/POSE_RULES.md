# Person down and fence climbing (body pose rules)

Advisory detections built on body pose. Decision record: `docs/adr/0017-pose-threat-rules.md`.

## Turn it on

1. Fetch the model: `scripts/models/fetch-model.sh rtmpose-s-body7-256x192` (SHA-256 verified, about 20 MB).
   The model is a *candidate*; the owner's approval for its exact SHA-256 is recorded in
   `scripts/models/model-license-exceptions.json` (2026-10-06). Its training data includes non-commercial research datasets
   (see `trainingData` in the lock file); the owner accepted that risk and Indian legal advice has not been taken.
2. Start the ai-worker with `AI_POSE_ESTIMATION=true`. Optional: `AI_POSE_INTERVAL_MS` (default 500, per track),
   `AI_POSE_MAX_PER_FRAME` (4), `AI_POSE_THREADS` (1), `AI_POSE_MODEL_KEY`. If the file or approval is missing the worker
   stops and says why; it does not run without pose.
3. Draw the rules: Cameras, camera menu, "Vector Tripwire Analytics", then **Person down** or **Fence climbing**. Add
   automation rules with trigger `PERSON_DOWN` or `FENCE_CLIMB` to raise alarms (the `spatialRuleId` filter picks one rule).

## Person down
Area where a person going down matters (leave out places where lying is normal). "Down for" is how long a person who was
seen going down must stay down (default 10 s, 3 to 3600). Optional "found lying" time (0 = off) for people found lying who
were never seen upright. A person who gets up in time raises nothing; moving about while down restarts the clock.
Event: `PERSON_DOWN` / events.v1 `ai.person_down` with `kind` `FALL` (critical) or `LYING_STILL` (warning) and `basis`
`pose` or `box`.

## Fence climbing
Draw the area around the fence, the **fence base** (2 points along the ground edge, A then B), the **fence top** (2 points along
the top edge) and pick the **protected side** (left or right of the base line looking from A to B). Alerts: `CLIMBING` (a hand
above the fence top, hips near the base, for 1.5 s) and `CROSSED` (hips on the protected side after climbing). A person who
starts on the protected side never alerts. Event: `FENCE_CLIMB` / `ai.fence_climb`.

## Limits
- Advisory: look at the picture. Torso angle and "hand above the top" are read in the image, so camera height and angle matter;
  tune per camera. Thresholds are first guesses.
- Pose is sampled about twice a second per person; a detection without a pose adds nothing. If a person is missing for more
  than 10 s the lying story starts over.
- No pose (weak keypoints, pose switched off): person-down falls back to box shape and says so; fence climbing does nothing.
- Not verified on any real camera. The real model was checked on one photograph (`goldenPose.test.ts`) and the rules on
  synthetic tracks (`poseRules.test.ts`, `poseRulesRealDb.test.ts`, `e2e/pose-rules.spec.ts`).
- Pose keypoints are stored with the detection that carries them; they are person data under the existing purpose and
  retention settings, not face templates.
