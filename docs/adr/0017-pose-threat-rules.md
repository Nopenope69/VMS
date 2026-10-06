# 0017: Body pose for person down and fence climbing

## Status
Accepted (2026-10-06). Owner priority of 2026-10-05; plan in `PROJECT_STATE.md` section 9 and the model research in
`docs/strategy/model-research-2026-10-05/pose-fall-climb.md`. Builds on the threat rules of Session 28 (unattended bag, wrong way).

## Context
Fall and fence-climb detection need to know where a person's body is, not only their box. The research found no learned
action model with commercially clean weights, and recommended pose first with rules on top. The owner decided on 2026-10-05
that permissively licensed weights trained on non-commercial research data may ship, accepting the risk, and on 2026-10-06
approved running RTMPose-s (body7) in the product.

## Decision
* **Pose runs in the ai-worker, off by default** (`AI_POSE_ESTIMATION=true`). RTMPose-s (Apache-2.0 code and weights) runs
  top-down on CONFIRMED person detections: at most once per track per 500 ms and four persons per frame. The result is
  `attributesJson.pose` (17 keypoints as `[x, y, score]`, normalised to the source image, with the pinned model's name,
  version and SHA-256), like the colour attributes. The model is a candidate in `models.lock.json` and runs only with a person's
  approval for its SHA-256 (`model-license-exceptions.json`); with the switch on and the approval or file missing the worker
  stops with the reason. No new service, no new dependency: onnxruntime-node is already there.
* **Two spatial rule types**, `PERSON_DOWN` and `FENCE_CLIMB`, beside tripwire, loitering, unattended object and wrong way
  (same table, same ingestion path, same incident, canonical event and alarm chain, same cooldown). Their settings live in
  `paramsJson`. events.v1 gains `ai.person_down` and `ai.fence_climb` (v1.2, additive).
* **PERSON_DOWN**: torso angle (shoulder centre to hip centre, read in pixels) is upright (35 degrees or less), lying (60 or
  more) or unknown in between. A person seen upright within the fall window (3 s) before the first lying sample, who then stays
  lying and hardly moves for the rule's time, raises `FALL` once. Optionally someone found lying (never seen upright) and still
  for a longer time raises the weaker `LYING_STILL`. Weak keypoints fall back to the box shape (wide and short is lying), and
  the event says `basis: box`.
* **FENCE_CLIMB**: the operator draws the fence base line, the fence top line and the protected side. A wrist above the top
  line, with the hips near the base line, for the rule's time raises `CLIMBING`; later hips on the protected side, having
  started on the other, raises `CROSSED`. Without usable pose it does nothing: a box cannot show a raised hand, and a plain
  crossing is what a tripwire is for.
* **Advisory.** Both alerts describe themselves as advisory and say what they were read from. Pose never changes an alarm by
  itself, and nothing here is a finding about a person. The incident summary and explanation records name the new event types
  through their existing generic sentence; specific wording is a later change that must update the offline verifier too.

## Consequences
* Feet off the ground is not used (it needs depth); a hand above the fence top is the climbing signal. A picture of a person in
  a perspective view is not a measurement, so thresholds are first guesses to tune per camera on real footage.
* Pose is stored with each detection that carries it (about 17 small triples); like any per-person data it falls under the
  existing person-data purpose and retention controls. It is not a face template and identifies no one.
* CPU cost is small (about 6 ms per person on four cores in the research) but not measured on the reference hardware.
* Nothing here is verified on real cameras. The real model is checked on one photograph for anatomical sanity only.
