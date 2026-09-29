# VigilOne: North Star (V0.1), V1.0 and next steps

Status: planning doc, rewritten 29 Sept 2026 against master `482b331`. It replaces the earlier draft of the same name, which was written from a stale local clone and still listed Phases 0 to 4 as future work.

Test and build status is not restated here. See `docs/generated/TEST_STATUS.md` (CI-generated) and `docs/STATUS.md` (session logs with the commands run). Companion docs in this folder:

- `vigilone-ai-strategy-collated-2026-09-28.md`
- `vigilone-first-in-india-ai-features-2026-09-28.md`
- `vigilone-ai-features-and-research-2026-09-23.md`
- `vigilone-oss-ai-catalog-2026-09-23.md`
- `vigilone-vms-review-2026-09-13.md`
- `vigilone-vms-review-2026-09-14-remediation-round2.md`

## Scope

- **VigilOne** is the only active product track. **VMS-LITE** is handed off (Antigravity will build it if needed) and is out of scope here. The two share contracts only (events.v1, media-provider.v1, recording-index.v1), never code.
- **V0.1 (North Star):** VigilOne as the full six-layer platform (video fabric, event fabric, AI runtime, rules, multi-site, unified physical security), field-proven, with a real AI runtime and published precision/recall.
- **V1.0:** V0.1 plus the AI/ML features from the research docs.
- Working assumption, to confirm: V0.1 is the full route through Phase 8. A smaller cut through Phase 5 (real AI, ANPR, search) is the fallback.

## Where the build stands

Phases 0 to 4 of the 8-phase route are built and merged. Every "verified" label below carries the repo's own qualifier: built and tested, but on simulated cameras, test doubles or synthetic data unless stated.

| Phase | Built | Not yet proven |
| --- | --- | --- |
| 0 Stabilise | Feature flags (default off), demo UI stripped from production bundle, fail-loud CI gate, generated status, docs hygiene gate, four versioned contracts | None open, apart from keeping CI green |
| 1 Field-proof core | Bench harness, fault drills, soak runner, acceptance automation; real defects found and fixed | Real cameras, clean-VM install, real 72-hour soak |
| 2 Real AI | ai-adapter.v1 server and conformance kit, YOLOX and RF-DETR with pinned hashes, tracker, model registry with audit, eval harness, model cards | Detector accuracy on site footage (not evaluated) |
| 3 Real events | ONVIF PullPoint and Profile M parser, Hikvision and Dahua events, SMTP/WhatsApp/SMS channels, alarm SLA and escalation, rule builder, correlation, false-alarm feedback | Physical cameras, real WhatsApp/SMS/SMTP providers, live Profile M metadata capture |
| 4 India ANPR and privacy | Indian plate formats, ANPR adapter, plate eval and fine-tune tools, real redaction, AI provenance in evidence packages, `vigilone-verify` CLI, DPDP controls | Accuracy on Indian roads, redaction recall on site footage, licence and DPDP decisions |

Layer view (qualitative on purpose; earlier percentage scores predate Phases 0 to 4 and are retired):

- **Video fabric:** built and crash-tested against simulated sources. Next gate is real cameras.
- **Event fabric:** built against test doubles and fixtures from published formats. Next gate is real device streams.
- **AI runtime:** real detectors, tracker and provenance chain. No accuracy number on real footage yet.
- **Rules:** real producers exist (tracker-fed tripwire and loitering, ANPR watchlist, camera analytics, correlation).
- **Multi-site:** federation and S3 archive exist as code. Earlier audits found no working outbound client and an in-memory S3 path. Re-verify at the start of Phase 6 before trusting either.
- **Unified physical security:** no physical relay driver, and digital inputs carry no "door contact" semantics. Phase 7.

## Human track (unblocks Phases 1 to 4, runs in parallel with Phase 5)

None of this is more code. It gates every "SIMULATED" and "NOT EVALUATED" label above.

1. **Hardware:** one Hikvision, one Dahua, one generic ONVIF camera with analytics, on PoE. Run the clean-VM install drill and the real bench and soak per `docs/operations/FIELD_VALIDATION_TOOLKIT.md`. Capture redacted real event streams as test fixtures.
2. **Data:** labelled plate frames per LPR camera (day, night IR, two-line plates, held-out days), real site clips for redaction recall, annotated footage for detector precision/recall.
3. **Licence decisions** (the numbered list in `docs/STATUS.md`): YuNet and WIDER FACE terms, the ANPR model training data, COCO-trained detector weights, BlueOak and MIT-0 dependencies, test-only tools. Each approved model needs an entry with its exact SHA-256 in `scripts/models/model-license-exceptions.json`.
4. **DPDP:** allowed purposes, retention periods and lawful basis for face processing, per deployment.
5. **Providers:** a WhatsApp Business test number with an approved template, an SMS gateway, the site SMTP relay.
6. **Product decision:** may footage of a camera removed from the database ever be auto-deleted by the quarantine cap?

## Remaining phases

Each phase has an exit gate. A phase is not closed on simulated evidence alone.

**Phase 5: Search and explain.**
- Semantic search over object crops using SigLIP-class embeddings in pgvector (not Jina CLIP v2, which is CC BY-NC). A parity feature, not a claimed first.
- Evidence-chained explanations first: the "why this was flagged" text is hashed into the custody chain and checked by `vigilone-verify`. Cheapest and most defensible, because it rides on the provenance work already built.
- Local VLM verification of flagged events, shipped as operator assist only (a recent study found weak zero-shot anomaly detection, F1 0.09 baseline and 0.64 with heavy prompting; arXiv 2603.04727).
- Exit gate: retrieval recall@k on labelled site queries, published; explanations verify offline; VLM precision/recall published.

**Phase 6: Multi-site.** Federation outbound client and reverse tunnel proven across a real network; S3/MinIO archive proven against a real bucket, with pinned evidence bypassing the off-peak window. Exit gate: two sites syncing events, audit and alarms with induced link loss.

**Phase 7: Unified physical security.** Physical relay driver with the confirmation handshake against real hardware; door-contact semantics for digital inputs (maps to `access.door_opened`); then access control, intrusion, POS and BMS integrations, one at a time.

**Phase 8: Platform.** Public AI adapter contract and SDK, SSO, high availability, certification. Confirm STQC/BIS scope directly with the body; a VMS certification requirement is unverified.

No calendar estimate is given here. Re-estimate after the human track shows how long real-hardware validation takes.

## V0.1 exit gate (proposed)

16 to 32 real cameras in a supervised pilot, a real 72-hour soak, published detector precision/recall, and a Section 63 BSA export that carries AI provenance and verifies with the standalone verifier.

## V1.0: AI/ML features on top of V0.1

Framing: Detect, Track, Understand, Search, Explain, materialised as an intelligence graph (camera, frame, object, track, attribute, action, relationship, event, incident, evidence).

- **Detect:** weapon detection (fine-tune a permissive detector on licence-cleared data; high false-positive bar); audio-visual threat detection (gunshot, scream, glass-break; opt-in, needs camera audio); fire/smoke and PPE for parity; face detection with 1:N face search off by default (DPDP).
- **Track:** gait re-ID for masked or helmeted people (OpenGait, MIT) as a forensic add-on; cross-camera re-ID.
- **Understand:** zero-shot language rules and predictive crowd-crush forecasting (needs overlapping cameras and calibrated homography; pilot at one site type). Operator assist only.
- **Search:** covered in Phase 5.
- **Explain:** covered in Phase 5, extended to multi-turn investigation later.
- **Moat:** an opt-in per-site frame collection and labelling loop for Indian-conditions fine-tuning (two-wheelers, auto-rickshaws, Indian plates, local PPE and uniforms). Budget real annotation effort; a base detector alone is not the moat.

Caveats carried from the research: do not embed YOLO-World (GPL-3.0; use Grounding DINO or OWLv2); "first in India" claims stay unverified until checked against AllGoVision, Vehant OKEAN, SrivisifAI and Videonetics.

## Open decisions

1. Is V0.1 the full Phase 8 platform, or the Phase 5 cut?
2. Reference hardware: Intel Core Ultra, Hailo or Jetson.
3. Which licence approvals to grant first, since they gate the production use of every AI model.
4. Whether Phase 5 starts before the human track finishes (recommended: yes, in parallel).
