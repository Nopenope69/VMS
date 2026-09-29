# VigilOne — North Star (V0.1), V1.0 and Next Steps, 29 Sept 2026

Status: planning doc, written 29 Sept 2026. Reconciles the project research docs in this folder with the state of the two repos. Companion docs in `docs/strategy/`:

- `vigilone-ai-strategy-collated-2026-09-28.md`
- `vigilone-first-in-india-ai-features-2026-09-28.md`
- `vigilone-ai-features-and-research-2026-09-23.md`
- `vigilone-oss-ai-catalog-2026-09-23.md`
- `vigilone-vms-review-2026-09-13.md`
- `vigilone-vms-review-2026-09-14-remediation-round2.md`

## Product ladder (definitions)

- **VMS-LITE ("Basic VMS")** — github.com/Nopenope69/VMS-LITE. The MVP gate: 8 frozen domains (camera onboarding, live, recording, playback/search, evidence export, health, events/alerts, users/RBAC). Not part of V0.1 or V1.0; it is the stepping stone and pilot vehicle.
- **V0.1 — North Star.** VigilOne as the full 6-layer platform (video fabric, event fabric, AI runtime, rules, multi-site, unified physical security), field-proven, with the AI runtime real (detector, tracker, published precision/recall) but not yet feature-rich.
- **V1.0.** V0.1 plus every AI/ML feature from the AI research docs.

Assumption to confirm: V0.1 = the full 8-phase platform route below. A smaller alternative is a cut through Phase 5 (real AI + ANPR + search).

## What was checked on 29 Sept 2026

- **VMS-LITE** (cloud clone, HEAD `9c3d1b1`, 92 commits, phases 13–21 landed 27 Sept). `.planning/STATE.md` says 100% complete. Two claims do not hold when read in code:
  - `src/mediamtx/mediamtx.client.ts` lines ~118–120 still store a mock path and return `true` when MediaMTX is unreachable, contradicting its own roadmap Workstream 1.1 ("fail explicitly").
  - The "72-hour soak" (`tests/soak-acceptance.test.ts`) runs on a simulated clock (72 virtual ticks); it is not a real soak.
  - The client is a real Vite shell but has only 2 pages (`LiveViewPage`, `PlaybackPage`); the rest are modals.
  - Tests: 24 of 34 test files could not load in the review sandbox (Prisma engine download blocked), 82 tests passed — inconclusive, not a pass or fail. Its own STATE.md claims 162 passing.
- **VigilOne local working clone** (`optimistic-newton`, HEAD `f38adf5`, 25 Sept, 56 commits, clean tree): includes `services/ai-worker`, tracking engine, spatial analytics integration, "561-test baseline" per its own docs. No `.onnx`/`.pt` model files tracked. Live GitHub state was not re-fetched (no credentials in the review shell).
- The older clone `~/vigilone-vms` is stale (13 Sept, `f6a6c11`).

## V0.1 — what is left to build

| Layer | State at 27 Sept (arch / working) | Left for V0.1 |
|---|---|---|
| Video fabric | 80 / 30 | Field-proof on real cameras (4-camera bench, then a real 72-hour soak); real browser e2e run; one unedited CI run linked from docs; `dr-drill.sh` executed once outside its sandbox; demo "Bypass & Test UI" stripped from pilot builds |
| Event fabric | 75 / 50 | ONVIF Profile M ingestion and event subscription (client does discovery and PTZ only); WhatsApp and email; incident workflow |
| AI runtime | 50 / 5 | Real ONNX model file; `onnxruntime-node` in a package.json; `ai-worker` in docker-compose; RF-DETR or YOLOX with a tracker feeding the spatial engine; published precision/recall on own footage; model registry with SHA-256 and licence in the audit chain |
| Rules | 70 / 30 | Real producers for `TRIPWIRE_CROSS`, `LOITERING_DWELL`, `ANPR_WATCHLIST` |
| Multi-site | 35 / 0 | Federation outbound client and tunnel; real S3 archive (in-memory today) |
| Unified physical security | 25 / 5 | Physical relay driver, then access-control, intrusion, POS, BMS |

Also required: India ANPR (plate detector + OCR fine-tuned on Indian plates incl. two-line two-wheeler plates); real redaction with derivative hash chained to the master evidence hash; SSO, HA, SDK and AI adapter contract (Phase 8); confirm STQC/BIS scope directly (VMS certification requirement is unverified).

Proposed V0.1 exit gate: 16–32 real cameras in a supervised pilot, 72-hour real soak, published detector precision/recall, and a Section 63 BSA export that carries AI provenance.

## V1.0 — AI/ML features on top of V0.1

Framing (from the 28 Sept collated strategy): Detect → Track → Understand → Search → Explain, materialised as an Intelligence Graph (camera → frame → object → track → attribute → action → relationship → event → incident → evidence).

- **Detect:** weapon detection (gun/knife; fine-tune a permissive detector on licence-cleared data; much lower false-positive bar); audio-visual threat detection (gunshot, scream, glass-break; opt-in, needs camera audio); fire/smoke and PPE for parity; face detection with 1:N face search off by default (DPDP).
- **Track:** gait-based re-ID for helmeted/masked people (OpenGait, MIT), as a forensic add-on; cross-camera re-ID.
- **Understand:** zero-shot natural-language anomaly rules (operator-assist only — arXiv 2603.04727 found baseline F1 0.09, 0.64 with heavy prompt engineering); predictive crowd-crush forecasting (needs overlapping cameras and calibrated homography; pilot at one site type).
- **Search:** SigLIP/Jina-class embeddings of object crops in pgvector with a natural-language query box. Parity feature, not a "first" (CP Plus × Qualcomm, Videonetics already claim it). Note Jina CLIP v2 is CC BY-NC — use SigLIP instead.
- **Explain:** verbalised, evidence-chained reasoning (the "why the AI flagged this" text hashed into the tamper-evident chain), plus local-VLM verification of flagged events. Cheapest and most defensible "first" because it rides on the existing Section 63 chain.
- **Moat:** opt-in per-site frame collection and labelling loop for Indian-conditions fine-tuning.

Caveats carried from the research: do not embed YOLO-World (GPL-3.0; use Grounding DINO or OWLv2); "first in India" claims are unverified until checked against vendors (AllGoVision, Vehant OKEAN and SrivisifAI already cover more than the first pass implied).

## Next steps, in order

1. **This week — fix LITE gaps.** Remove the mock fallback in `mediamtx.client.ts`; get the full suite passing on a machine where Prisma works (or CI); replace the simulated 72-hour soak with a real one before claiming the field gate.
2. **Weeks 1–4 — LITE on real cameras.** Clean-VM install, 4 mixed-brand cameras, then a 16-camera real soak. Add real pages for health/storage, events, users, settings. This is the LITE pilot.
3. **In parallel — stabilise VigilOne (Phase 0).** Flag out-of-scope features, strip the bypass UI, fix the CI job gap, link one unedited CI run in the docs.
4. **V0.1 Phases 1–3.** Field-proof the core; first real detector with published precision/recall; real events (ONVIF Profile M, WhatsApp/email, incident workflow).
5. **V0.1 Phases 4–8.** India ANPR, real redaction and AI provenance; semantic search; multi-site; unified physical security; platform layer. Estimate from the 27 Sept status: ~18–24 months with 3–4 engineers plus one data/model person.
6. **V1.0 only after V0.1.** Ship evidence-chained explainability first, then zero-shot rules as operator-assist, then weapon and audio detection; gait and crowd forecasting last.

## Open decisions

- Is V0.1 the full 8-phase platform or the Phase-5 cut?
- Should LITE and VigilOne share only contracts (event names/payloads, media-provider interface, recording-index shape) and no code? (Earlier recommendation: yes.)
- Reference hardware: Intel Core Ultra, Hailo, or Jetson.
