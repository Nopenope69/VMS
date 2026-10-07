# 0019: Camera-sabotage detection from the substream

## Status
Accepted (2026-10-07). Second part of footage integrity (landscape doc, Tier 1 item 5; `PROJECT_STATE.md` section 9, item 1
of "remaining"). The first part is footage sealing (ADR 0018). C2PA-style export manifests remain a separate decision.

## Context
A camera that is covered, knocked out of focus, turned away or blinded by a torch keeps streaming and recording, so the
stream watchdog sees nothing wrong, yet the footage is useless as evidence. Tenders treat detecting this as table stakes.
Some cameras report it themselves (`TAMPER`, `DEFOCUS`, `SCENE_CHANGE` camera events), many do not, and their reports do not
share one meaning. The backend already had a `SCENE_CHANGE` event kind with `OCCLUSION | DEFOCUS | DISPLACEMENT`, a
`SCENE_CHANGE` rule trigger and the events.v1 mapping `camera.degraded` / `TAMPER_<type>`, but nothing produced it.

## Decision
* **Classical image measurements in the AI worker, no model.** The worker already decodes every monitored camera's substream
  from the MediaMTX loopback (1 frame per second by default). `sabotageDetector.ts` measures each sampled frame on its
  picture area only (letterbox padding excluded), reduced to 320 pixels wide by block averaging: grey-level mean and spread,
  dark and saturated shares, sharpness (99th-percentile gradient divided by the spread, so dim light and sensor noise barely
  move it), a 32x18 picture and a 16x9 edge map. No dependency, no licence question. It runs before the motion gate, because
  a covered camera shows no motion.
* **A reference per camera.** The first 20 frames are learnt; afterwards the reference follows normal frames slowly (2% per
  frame) so daylight changes are absorbed. While anything is suspected the reference is frozen.
* **Four conditions, at most one per frame, in this order:**
  * `BLINDED`: 40% or more of the picture saturated, in a scene whose reference has under 20%.
  * `OCCLUSION`: the picture is flat (grey-level spread 12 or less, or 95% dark) and no longer resembles the reference
    (similarity below 0.5). Similarity is the higher of the normalised cross-correlations of the picture and of the edge map,
    so overall brightness and contrast do not count.
  * `DEFOCUS`: sharpness at half the reference or less. A hand or cloth close to the lens usually lands here: the message
    says "out of focus or lens obscured".
  * `DISPLACEMENT`: still sharp, but similarity below 0.45.
  A reference with almost no detail (spread under 18: a blank wall, a dark scene) is judged for glare only.
* **Held, reported once.** A condition must last 10 s (`AI_SABOTAGE_HOLD_SECONDS`; one odd frame within 3 s does not restart
  the count) and is reported once; it is reported again only after 30 s without it. A gap of over a minute in the stream drops
  what was suspected (stream loss is the watchdog's business). A camera that stays moved for 15 minutes after the report
  learns its new view, because otherwise it would stay suspect for ever; moving it back is reported as a move again.
* **Recorded as the existing event kind.** The worker posts the finding to `POST /api/v1/internal/camera-sabotage`
  (internal secret, flag `CAMERA_SABOTAGE`, 501 when off). The backend checks the camera belongs to the stated tenant, then
  ingests a `SCENE_CHANGE` event (source `WATCHDOG`, severity WARNING) with a plain title, a description of what was measured,
  the method (`classical-v1`), the start time and the measurements. The event id is derived from camera, type and start, so a
  retried report is evaluated once. `SCENE_CHANGE` rules (already in the rule builder) turn it into an alarm; without a rule
  it is only recorded. `BLINDED` is new: `TAMPER_BLINDED` in events.v1 (`reason` is a free string; additive).
* **Advisory and separate.** Recording, live view and the camera's state are untouched. The event names its measurements so
  an operator can judge it against the live view.

## Consequences
* Two switches, both off: `AI_SABOTAGE_DETECTION=true` on the worker, `VIGILONE_FEATURE_CAMERA_SABOTAGE=true` on the
  backend. The worker's pipeline only runs with a deployed detection model, so a site without the AI worker has no
  sabotage detection (cameras' own tamper events still arrive through `CAMERA_EVENTS`).
* No "restored" event: the end of a condition is only visible as the absence of new reports. An operator closes the alarm.
* The thresholds were set on four photographs with simulated sensor noise, blur, covers, moves, glare, dusk and night
  (`sabotageDetector.test.ts`, decoded by real ffmpeg). Known misses and likely false alarms, to measure on site footage:
  a nudge of about 5% is not a move; a large vehicle parked across the view, a lights-off event without infrared, or rain and
  fog on the lens can be reported; an infrared switch at dusk is expected to pass (brightness-invariant similarity) but is not
  tested on a real camera.
* CPU: one pass over a 640x640 frame per camera per sampled frame, a few milliseconds; not measured on the reference hardware.
