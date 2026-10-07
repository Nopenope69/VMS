# VigilOne: North Star, V0.1, V1.0 and next steps

Status: planning doc, rewritten 1 Oct 2026 against master `4fd2d6c`. It replaces the 29 Sept version, which listed
Phases 5 to 8 as future work, and merges in an external product review the owner shared on 1 Oct 2026
("Executive conclusion ... Ask your cameras"). Everything kept from that review was checked against the code;
what was dropped, and why, is listed at the end.

Test and build status is not restated here. See `docs/generated/TEST_STATUS.md` (CI-generated) and
`docs/STATUS.md` (session logs with the commands run). Companion docs in this folder:

- `vigilone-ai-strategy-collated-2026-09-28.md`
- `vigilone-first-in-india-ai-features-2026-09-28.md`
- `vigilone-ai-features-and-research-2026-09-23.md`
- `vigilone-oss-ai-catalog-2026-09-23.md`
- `vigilone-vms-review-2026-09-13.md`
- `vigilone-vms-review-2026-09-14-remediation-round2.md`
- `vigilone-oss-reference-study-2026-10-05.md` (what open-source VMS and CV projects teach us; sets the order of the next work)

## 1. The North Star

> **An AI-native, edge-first investigation and operations platform for Indian physical environments.**
> Proposed tagline (owner decision): **"Ask your cameras."** Search, understand and act on everything your
> cameras have seen, privately, on site, with evidence you can trust.

The North Star workflow, in one request:

> "Find the man in a blue shirt who entered Gate 3 between 8 and 10 PM, show me where he went across cameras,
> tell me what happened before and after, find the vehicle associated with him, summarise the incident, and
> prepare a legally defensible evidence package."

and, optionally: "If that vehicle enters again, alert security and run the gate workflow."

**What changes, and what does not.** The architecture stays. The product's centre of gravity moves:

| Stage | Centre of gravity |
| --- | --- |
| Today | A reliable edge VMS with governed AI parts behind feature flags |
| V0.1 | The same VMS, field-proven, plus an AI investigation engine (search, follow, reconstruct, export) |
| V1.0 | AI that understands and acts: summaries, natural-language rules, AI-proposed actions run through the rule engine |

**Why this direction.** The leading vendors (Verkada, Genetec, Milestone/BriefCam, Axis, Eagle Eye, Rhombus,
Avigilon, Spot AI) are converging on natural-language search, cross-camera following, incident reconstruction
and VLM summaries. Indian vendors (Staqu, Videonetics, Awiros, AllGoVision, VMukti) compete on analytics breadth.
Person, vehicle, motion, intrusion and line crossing are now baseline everywhere. These are vendor claims from
the external review, not checked by us.

**The India wedge:** edge-first and offline-capable; camera-agnostic (keep the cameras, add intelligence);
Indian ANPR; privacy (DPDP) and court-grade evidence (BSA Section 63) as product features, not add-ons.

**The moat** is the combination of governed AI, evidence integrity and Indian data. No single feature is the moat.
That means India-specific labelled data and evaluation, the entity and event graph, and the investigation
workflow. It is not a proprietary foundation model, and not a long list of analytics.

## 2. Primary product metric: time-to-answer

For a question like "Who entered the warehouse after 10 PM and where did they go?", measure the time from typing
it to an answer the operator accepts.

- Target: under 60 seconds.
- The external review estimates about 30 minutes in a traditional VMS. We have not measured that baseline yet.
  Measure it on the pilot by timing the operators.

Supporting metrics: time to first result, search precision and recall@k on labelled queries, investigation
completion time, operator actions per incident, evidence-package generation time, and alarm false-positive rate.

## 3. Where the build stands (1 Oct 2026)

All eight phases of the build route are built and merged. **None of it has run on a real camera, real site
footage or real hardware.** Each item below is built and tested on simulated cameras, simulators, test doubles
or synthetic data unless stated. That gap is the single biggest risk to the product.

| Phase | Built | Not yet proven |
| --- | --- | --- |
| 0 Stabilise | Feature flags (default off), fail-loud and hygiene gates, generated status, versioned contracts | None open |
| 1 Field-proof core | Bench harness, fault drills, soak runner, backup and restore | Real cameras, clean-VM install, real 72-hour soak |
| 2 Real AI | ai-adapter.v1, YOLOX and RF-DETR (pinned hashes), per-camera tracker, model registry, eval harness, model cards | Detector accuracy on site footage |
| 3 Real events | ONVIF, Hikvision and Dahua events, notifications, alarm SLA, rule builder, correlation, automation dry-run | Physical cameras, real providers |
| 4 ANPR and privacy | Indian plate formats incl. BH, multi-frame voting, watchlists, redaction (solid boxes), AI provenance in evidence, `vigilone-verify`, DPDP purpose and retention controls, redaction console | Plate accuracy on Indian roads, redaction recall, licence and DPDP decisions |
| 5 Search and explain | Object crops; SigLIP 2 embeddings in pgvector; search by text and by example crop, purpose-gated and audited for people; evidence-chained explanations; SmolVLM2 second opinion on alarms (advisory) | Retrieval recall@k on site queries, VLM agreement with operators, SmolVLM2 licence approval |
| 6 Multi-site | Federation sync (events, alarms, audit) with link-loss recovery; S3/MinIO archive | Real WAN, customer bucket; reverse video tunnel and config push not built |
| 7 Physical security | Relay and door module (unlock, forced, held open), `DOOR_EVENT` rules | Real relays and doors; access-control, intrusion, POS and BMS integrations not built |
| 8 Platform | OIDC SSO, backend leader lease, private adapter SDK, certification readiness notes | PostgreSQL replication and recording failover not built; STQC/BIS scope unconfirmed |

**Against the North Star**, the external review's reading holds:

- **The parts exist:** detections, per-camera tracks, crops, embeddings, VLM, rules, zones, ANPR and evidence.
- **The missing piece is the layer that connects them.** That is an entity and event graph, and an
  investigation experience built on it. Today a user gets search results and synchronised playback (the
  Investigation page), not a followed entity or a reconstructed incident.

## 4. Human track (unchanged, still the critical path)

None of this is code, and all of it gates every "SIMULATED" and "NOT EVALUATED" label above. It runs in parallel
with the build work in sections 5 and 6.

1. **Hardware:** one Hikvision, one Dahua, one CP Plus and one generic ONVIF camera on PoE (1 to 4 camera bench,
   `docs/operations/NEXT_STEPS_PILOT_AND_HARDWARE_ROADMAP.md`). Clean-VM install drill per
   `docs/operations/GO_LIVE_RUNBOOK.md`. Real bench and soak. Capture redacted real event streams as test
   fixtures.
2. **Data:** see the evaluation datasets in section 5, item 1.
3. **Licence decisions** (numbered list in `docs/STATUS.md`): YuNet and WIDER FACE, ANPR training data,
   COCO-trained detector weights, SmolVLM2, BlueOak and MIT-0 dependencies. Each approved model needs its exact
   SHA-256 in `scripts/models/model-license-exceptions.json`.
4. **DPDP, per deployment:** allowed purposes, retention periods, lawful basis for face processing
   (`docs/operations/DPDP_DECISION_RECORD.md`). The DPDP Rules were notified in November 2025 with phased
   commencement over 18 months. The review cites this; confirm the dates with counsel.
5. **Providers:** a WhatsApp Business template, an SMS gateway, the site SMTP relay.
6. **Product decision:** may footage of a camera removed from the database ever be auto-deleted by the quarantine
   cap?
7. **Certification:** confirm STQC and BIS scope directly with each body. The review says STQC's IoT
   certification scheme covers CCTV cameras and that camera-hardware certification is now enforced on
   marketplaces. Both concern camera hardware. They matter to us only if we ship an appliance with cameras, and
   need confirming.

## 5. V0.1: the AI investigation MVP

V0.1 is redefined. The old definition was "the full eight-phase platform, field-proven". That code now exists.
The new definition is **a field-proven VMS plus the investigation loop**: search, follow, reconstruct, export.
Multi-site, physical security and platform items stay as built but are not V0.1 exit criteria.

### P0, in order

1. **Field validation and evaluation data (human track, items 1 and 2).** Do this before adding features. It
   produces the first real numbers.
   - **India ANPR benchmark.** This is how ANPR becomes a product capability rather than a checkbox. Cover:
     - conditions: day, night IR, rain, dirt, tilt, occlusion, distance, low-resolution cameras;
     - plate types: two-line plates, BH plates, temporary plates, regional variation;
     - vehicles: motorcycles, autos, trucks, fast movers.
   - **How to build it.** Start with a few thousand hand-labelled frames per camera position, held out by day.
     Then run the system over much larger unlabelled volumes to measure no-read rate and latency.
   - **What to report:** read rate, character error rate, false-read rate, no-read rate, latency, and
     confidence calibration.
   - **Search queries:** labelled queries on site footage (for example "white SUV at the gate") to measure
     recall@k.
   - **Detector footage:** annotated footage for detector precision and recall.
2. **Richer detection records (the AI event index).** Today a `DetectionEvent` carries class, box, confidence,
   an optional `trackId` and free-form attributes. Its crop and embedding hang off `ObjectCrop`. Add:
   - zone, direction and dwell per track;
   - track start and end and a short trajectory;
   - consistent colour and type attributes for people and vehicles;
   - the ANPR read linked to the vehicle track that produced it.

   Every field keeps its model version (provenance already does this).
3. **Search v1 as a product, not plumbing.**
   - **Today** we have text-to-crop and crop-to-crop search.
   - **Add:**
     - search by an uploaded reference image (needs an image-embed endpoint, which we do not have);
     - structured filters combined with semantic ranking (site, camera, time, zone, class, plus text);
     - AND and NOT terms;
     - results grouped by track, so one person is one result, not forty crops.
   - **Gate:** recall@k on the labelled queries, published.
4. **Cross-camera following.** "Show me this person or vehicle elsewhere":
   - **Vehicles first.** A plate read is an exact key, so a vehicle can be followed across cameras by ANPR
     with high confidence. Appearance similarity fills the gaps.
   - **People second.** People are linked by appearance-embedding similarity within a time window and the
     site's camera adjacency.
   - **Links are suggestions.** The system proposes; the operator confirms; a confirmed link is audited.
   - **No face recognition.** Person following stays behind the existing purpose and permission gates.
5. **Investigation workspace.** Search results lead to a timeline, then synchronised cameras (already built),
   then the entity's trajectory on the floorplan (floorplans exist), then an incident, then an evidence package
   (already built). Nothing in this item needs a new model.

### V0.1 exit gate

1. **Pilot:** 16 to 32 real cameras in a supervised pilot, with a real 72-hour soak.
2. **Published numbers:** detector precision and recall, and the ANPR benchmark numbers.
3. **Search:** recall@k published.
4. **Investigation:** one real investigation run end to end on pilot footage (search, follow across at least 3
   cameras, incident, export), timed against the time-to-answer target.
5. **Evidence:** a Section 63 BSA export with AI provenance that verifies with the standalone verifier.

## 6. V1.0: understand and act

### P1: North Star enablers

- **Investigation entity (the context graph).** One record per person, vehicle or object of interest that
  groups its tracks, appearances, cameras, zones, attributes, plate reads, door and access events, incidents and
  evidence.
  - Entities are built from confirmed links (P0 item 4), never inferred silently.
  - Store it in PostgreSQL alongside pgvector. Do not add a separate graph database until a measured query
    needs one.
  - This is what turns "14,238 detections" into "312 entities and what they did".
- **Automatic incident reconstruction.** Given an entity and a time window, assemble the ordered timeline
  ("19:42 enters Gate A ... 19:47 vehicle exits, plate DL..."). Then add a written summary.
  - The summary is generated from the timeline's facts and cites them.
  - It is hashed into the custody chain like the existing explanations, so it is checkable rather than free
    prose.
- **VLM on clips, after retrieval.** Today the VLM answers one question about one snapshot. Extend it to short
  clips (5 to 30 s) selected by cheap always-on detection, for "what happened here" and "did the person fall".
  - Never run it over every frame of every camera.
  - It stays advisory until its agreement with operators is measured.
- **Natural-language rules.** "Alert me if a person stays near the server room for more than five minutes after
  10 PM":
  - a local model drafts a normal rule;
  - the operator sees the rule;
  - the existing automation dry-run shows what it would have caught last week;
  - only then is it saved.
  - This replaces the old "zero-shot language rules" item.
- **Natural-language search queries.**
  - Same pattern: a local model turns the sentence into structured filters plus a text query, and shows them
    before running.
  - Queries that need access-control data ("entered without a badge event") wait for the access-control
    integration (Phase 7, not built).
  - Voice input comes after text works.

### P2: agentic actions, safely

**See, reason, act**, with one rule: **AI proposes, the deterministic rule engine acts.**

- **What the AI does:** a model may add context (unrecognised vehicle, night shift, no door event) and propose
  actions.
- **What the rule engine does:** it executes them (alarm, notification, PTZ preset, high-resolution recording,
  evidence pin, relay), with its existing cooldowns, permissions and audit trail.
- **Never:** a model never drives a relay or a door directly.

No separate "AI automation system". It is the existing rule engine with a new kind of input.

### P3: vertical packs (instead of 100 generic analytics)

Pick one or two with the first customers (owner decision):

- **Logistics and gates:** ANPR, gate throughput, dwell time, wrong-way movement, loading-bay events. The closest
  fit to what is built.
- **Factory:** PPE, restricted zones, forklift and pedestrian proximity, fire and smoke, worker fall.
- **Retail:** theft investigation, queues, footfall, repeat-visitor search, cash-counter events.
- **Campus and BFSI:** access and video correlation, tailgating, visitor tracking. Needs the access-control
  integration.

Fire and smoke and PPE (from the old V1.0 list) now ship inside packs.

**Owner decision (2026-10-07): build two packs, Factory safety and Public safety (Railways and Safe City).**

| Pack | Already built that it uses | Still needed |
| --- | --- | --- |
| **Factory safety** | Zones and tripwires (restricted areas), person down (worker fall, ADR 0017), alarm triage and incident windows, camera-sabotage detection | PPE (helmet, vest): first through an open-vocabulary check on person crops, then a licensed detector; fire and smoke (own fine-tune on D-Fire / Pyro-SDIS, licence check); forklift-pedestrian proximity (rules on tracks; needs a forklift class); site evaluation data |
| **Public safety: Railways and Safe City** | Unattended object, wrong way, person down (platforms: zones where lying is normal), fence climbing (track and yard intrusion), Indian ANPR, cross-camera following, cited incident summaries, footage sealing | Crowd density, then crowd-flow prediction; fight and accident (rules on tracks, then VLM on short clips); Hindi and regional talk-down; tender-specific reports; site evaluation data |

Both packs are configurations of the same appliance (rules, zones, reports), not separate products. Every detection
in them stays advisory until measured on real site footage.

**Detectors still to add:**
- **Weapon detection:** fine-tune a permissive detector on licence-cleared data, with a high false-positive bar.
- **Audio events** (gunshot, scream, glass break): opt-in, and needs camera audio.
- **Indian-conditions labelling loop:** opt-in, per site (two-wheelers, autos, Indian plates, local PPE and
  uniforms). This is where real annotation budget goes.

### Non-goals

- **Analytics count:** we do not race to 100 analytics. Staqu, AllGoVision and Awiros own that territory.
- **Face recognition:** not the core product. Face detection exists only for masking. 1:N face search, if ever
  built, is one governed, off-by-default capability, never the base of entity tracking.
- **Foundation models:** no proprietary foundation model. Use approved open models; our IP is indexing, the
  entity graph, Indian data, evaluation, workflow, evidence and deployment.
- **Deployment:** never cloud-only. Edge-first stays.
- **Dashboards:** do not over-invest in them. The market is moving from dashboard to search to answer to action.
- **Licences:** no YOLO-World (GPL-3.0; use Grounding DINO or OWLv2). No Jina CLIP v2 (CC BY-NC).
- **Marketing claims:** no "first in India" claims until checked against AllGoVision, Vehant OKEAN, SrivisifAI,
  Videonetics, Staqu and Awiros.

## 7. Software work open now (not blocked on hardware)

From `PROJECT_STATE.md` section 9 and `docs/BACKLOG.md`:

1. **Privacy:**
   - data-principal requests (access and erasure workflow);
   - an exportable record of processing (`GET /privacy/dpdp/ropa`);
   - a breach register.
2. **Search P0:** items 2 and 3 in section 5 above.
3. **Architecture follow-ups:** done in Bucket 7 (orchestrator injected, `Camera.isOnline` split into
   `monitored` and real liveness, one settings reader, unused evidence services deleted), except the ai-worker on
   the SDK server, which the owner moved to its own piece of work.
4. **Tests and repo:** `operations.spec.ts` rewritten and running (Bucket 7). The stale `main` branch is for the
   owner to delete on GitHub (agent sessions cannot delete branches).
5. **README:** the "Smart search" row now says what it covers and points to semantic and track search (Bucket 7).

## 8. Open decisions (owner)

1. **V0.1 scope:** is V0.1 the investigation MVP defined in section 5? Recommended: yes.
2. **Positioning:** adopt "Ask your cameras" and the investigation positioning?
3. **Reference hardware:** Intel Core Ultra, Hailo or Jetson. Embedding every crop and running the VLM on clips
   must be measured on it.
4. **Licences first:** which approvals to grant first. Recommended: the detector weights and SigLIP 2 search
   path, then ANPR data, then SmolVLM2.
5. **First vertical pack:** ~~one or two (section 6, P3)~~ **decided 2026-10-07: both Factory safety and Public safety
   (Railways and Safe City)**; see P3.
6. **Pilot sites:** which pilot site or sites provide the evaluation data.

No calendar estimate is given. Re-estimate after the bench shows how long real-hardware validation takes.

## 9. What was removed, and why

### From the external review

| Removed | Why |
| --- | --- |
| The list of what the repository already has (section 14) and the rules-engine trigger and action list (section 23) | Already built; they are status, not plan. Section 3 covers them. |
| "README says there is no semantic search" and "Semantic search: major pieces built" (sections 15, 19) | Stale. Text-to-crop and crop-to-crop search over SigLIP 2 embeddings are built and tested with the real model (Phase 5, `docs/STATUS.md` session 7). The README row it quotes is the separate SQL "smart search" feature. The review's conclusion (built, not field-proven) is right and kept. |
| The "contradiction" between README and status docs | Not a contradiction: features are built and also deliberately off by default until field-proven. Kept the point that matters: the product is not yet field-validated. |
| CI test counts (section 16) | This doc never restates test status; the numbers change every run. See `docs/generated/TEST_STATUS.md`. |
| Percentage maturity scores (sections 18, 32) | The previous North Star retired percentage scores because they imply a precision nobody measured. Section 3 states what is built and what is unproven instead. |
| MVP-A "reliable VMS" and MVP-E "evidence package" as build items | Built. What remains is field proof, which is the human track and the V0.1 gate. |
| ANPR validation "against hundreds of thousands of real frames" as the first step | Kept the goal, changed the order: thousands of hand-labelled frames first (needed for error rates), large unlabelled runs second (no-read rate and latency). Labelling hundreds of thousands of frames is not a realistic first gate. |
| An LLM "taking action" directly (section 28 example) | Kept agentic action, with a hard line: the model proposes, the audited rule engine executes. A model must not drive relays or doors. |
| Running queries like "entered without an access-control event" in the first search release | Needs an access-control integration, which is not built (Phase 7). Moved after that integration. |
| "Type or speak" as a launch feature | Voice comes after text search works and is measured. |
| Market and regulatory facts presented as settled (vendor capabilities, the 50 million cameras and 5% figure, the April 2026 camera-certification date, the Reuters item) | Not checked by us, and some dates in the review run past the date of this doc. Kept as context, labelled as the review's claims, and listed in section 4 to confirm. |
| Tracking described as "partial, analytics-specific" | Imprecise. A per-camera tracker feeds tripwire and loitering, and detections carry a `trackId`. Cross-camera linking is what is missing; P0 item 4 covers it. |

### From the previous North Star (29 Sept)

| Removed | Why |
| --- | --- |
| "Remaining phases" 5 to 8 as future work | Built and merged since. Section 3 records what each phase did not prove. |
| V0.1 = the full eight-phase platform | Replaced by the investigation MVP. The platform code exists; making multi-site, relays and SSO V0.1 gates would delay the pilot without testing the product's core claim. |
| Gait re-ID (OpenGait) | Parked. Research-grade, needs cross-camera re-ID first and labelled data we do not have. Revisit after appearance-based following is measured. |
| Predictive crowd-crush forecasting | Parked. Needs overlapping cameras and calibrated homography, and does not serve the investigation-first product. Revisit for a stadium or transit customer. |
| "Zero-shot language rules" | Merged into natural-language rules (section 6), which reuse the rule engine and dry-run instead of a separate zero-shot model. |
| Fire and smoke and PPE as standalone parity features | Moved into vertical packs. |
| "The intelligence graph" framing (Detect, Track, Understand, Search, Explain) | Superseded by the concrete investigation entity in section 6, which says what is stored and where. |
