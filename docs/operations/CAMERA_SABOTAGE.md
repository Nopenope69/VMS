# Camera-sabotage detection (`CAMERA_SABOTAGE`, ADR 0019)

Off by default. Two switches, both needed:

- AI worker: `AI_SABOTAGE_DETECTION=true` (and optionally `AI_SABOTAGE_HOLD_SECONDS`, default 10, between 2 and 3600).
- Backend: `VIGILONE_FEATURE_CAMERA_SABOTAGE=true`. With it off the worker's reports are refused (501) and the worker logs
  that once.

Restart both after changing them.

## What it does

The AI worker looks at every frame it samples from each monitored camera's substream (1 per second by default) and compares
it with what that camera normally shows. It reports, once per occurrence:

| Type | Title on the event | What was seen |
| --- | --- | --- |
| `OCCLUSION` | Camera view covered or blocked | The picture is flat and no longer resembles the normal view |
| `DEFOCUS` | Camera out of focus or lens obscured | Edges much softer than normal (also a hand, cloth, rain or fog close to the lens) |
| `DISPLACEMENT` | Camera moved: the view differs from its reference | Sharp, but showing something else |
| `BLINDED` | Camera blinded by bright light | Most of the picture saturated |

A condition must last 10 seconds before it is reported. When it has been gone for 30 seconds the worker reports that too: the
system records a **"Camera view restored"** notice (information only, no alarm, events.v1 `system.alert` code
`CAMERA_TAMPER_CLEARED`), and the condition can be reported again. A moved camera whose new view is accepted after
15 minutes records "Moved camera: new view accepted" instead.
The event's description says what was measured, for example "sharpness fell to 0.21 against a reference of 0.62".

To get an **alarm**, add an automation rule with the trigger "SCENE_CHANGE (Camera Tamper / Obscuration)", optionally limited
to one camera. Without a rule the event is only recorded. In events.v1 it is `camera.degraded` with reason
`TAMPER_OCCLUSION`, `TAMPER_DEFOCUS`, `TAMPER_DISPLACEMENT` or `TAMPER_BLINDED`.

## The Footage Integrity page

Operators and administrators have a **Footage Integrity** tab (Alt+I). Per camera it shows:

- whether the view looks normal or which condition is open, and since when;
- conditions that ended in the last 7 days, how long they lasted, and whether the view was restored or a new view accepted;
- how many recordings are sealed and when the last one was (`FOOTAGE_SEALING.md`), with a **Check chain** button that runs
  the backend's chain check for that camera now and lists any problem;
- how many recordings are held by an integrity finding (`RECORDING_INTEGRITY.md`).

The page reads only. It says when camera-sabotage detection or sealing is switched off, so an empty column is never
mistaken for "all fine". If the worker restarts while a condition is open, the page keeps showing it open until the same
condition is reported and cleared again; check the live view.

## Things to know on site

- **Learning.** After the worker starts (or a camera's stream starts) it learns the normal view from the first 20 frames
  (about 20 seconds). A camera that is already covered then is learnt as a view with no detail and is not reported; once it
  is uncovered the reference slowly takes in the real view (a few minutes) and checking starts.
- **Daylight** is followed slowly. Nothing is learnt while something is suspected.
- **A moved camera** that stays moved for 15 minutes after the report becomes the new normal view. Moving it back is
  reported as another move.
- **Scenes with almost no detail** (a blank wall, a dark yard at night without infrared) are only checked for glare.
- **Likely false alarms, not yet measured:** a lorry or bus parked across the whole view (moved), lights switched off with no
  infrared (covered), heavy rain or fog on the lens (out of focus). Treat every report as advisory and check the live view.
- **Not detected:** a small nudge (about 5% of the view), a partial cover of a corner, a camera replaced by a photo of its own
  view.
- The stream going down is not sabotage detection's job: the stream watchdog reports `CAMERA_OFFLINE` / `STREAM_DEGRADED`.
- The cameras' own tamper analytics, where they exist, still arrive separately through `CAMERA_EVENTS`.

## Metrics (AI worker `/metrics`)

| Metric | Meaning |
| --- | --- |
| `vigilone_ai_sabotage_findings_total{type}` | Conditions confirmed |
| `vigilone_ai_sabotage_reports_total{outcome}` | `accepted`, `backend_disabled` (flag off), `refused` (4xx, not retried), `failed` (no answer after three tries) |
| `vigilone_ai_sabotage_errors_total` | Checks that threw (the frame still goes to inference) |

## Limits

Thresholds were set on four photographs with simulated noise, blur, covers, moves, glare, dusk and night, decoded by real
ffmpeg. Nothing has been run on a real camera; false-alarm and miss rates on real sites are unknown and the thresholds may
need tuning per site. The CPU cost (one pass over each sampled frame) is not measured on the reference hardware. The worker's
pipeline runs only with a deployed detection model.
