# VigilOne: what AI we have, what the market ships, what to build next (3 Oct 2026)

Status: research for an owner decision. It updates the 23 and 28 Sept research in this folder with what was built
since (North Star Buckets 1 to 5 and 7, the SDK change) and a fresh sweep of competitor news for 2026. Nothing
here is a commitment. The owner picks what to build in section 6.

**How to read the competitor facts.** They come from vendor press releases and trade-press articles found by web
search on 3 Oct 2026. Most vendor sites could not be opened from this sandbox, so several facts rest on the
search summaries of those pages. They are vendor claims, not tested products. Check before quoting any of them
externally.

## 1. Summary

- **We have the building blocks most leaders sell in 2026**, and all of them run on real models: detection,
  tracking, Indian ANPR, face and plate redaction, crop and track search by text, photo and example,
  cross-camera following, journeys, incident packages, and a local VLM second opinion. **None of it has run on a
  real camera or site yet.** That is still the biggest gap. It is not a feature.
- **The 2026 market has moved from "search" to "describe and act".** Leaders now let an operator *type what to
  watch for* (Brivo/Eagle Eye "Eeva", Verkada compound alerts, i-PRO free-text detection on the camera). They
  *write the incident up* (Genetec case files with AI summaries, Ambient case management, Milestone
  summarisation). They *act* (Verkada AI talk-down deterrence, Spot AI agents). And they *plug into AI agents*
  (Verkada Catalyst over MCP, NVIDIA VSS 3 "agent skills").
- **In India**, natural-language search is now table stakes or about to be (Hikvision AcuSeek, CP Plus with
  Qualcomm, Videonetics' positioning). Detector analytics (PPE, fire, crowd density, ANPR, women safety) are
  crowded (Staqu, Videonetics, Vehant, AllGoVision). The big public buyers (Safe City, Railways) ask for
  abnormal-activity alerts, unattended luggage, track intrusion and crowd management.
- **Our real edge is unchanged:** on-site and offline, a permissive-licence model stack, per-inference
  provenance, and court-grade evidence (BSA s.63). AI features that *produce evidence* (cited summaries, hashed
  into custody) or *protect evidence* (signed footage, tamper detection) are where no competitor found can
  follow quickly.
- **Recommendation (section 6):** build five software-only features next on what exists:
  1. natural-language search;
  2. "describe what to watch" rules;
  3. a reconstructed incident with a cited summary;
  4. alarm triage that learns from operator verdicts;
  5. footage integrity.

  One owner decision gates the first three: **which local language model we may run**.

## 2. What we have built (AI/ML), as of master `2f250ad`

Every item is behind a feature flag (off by default) and tested on simulated cameras, synthetic data or golden
images. **Accuracy on real site footage is not measured for any of them.**

| Area | What it does | Model / method | State |
| --- | --- | --- | --- |
| Object detection | Person, bicycle, motorcycle, car, bus, truck on the camera substream | YOLOX (Apache-2.0), RF-DETR (Apache-2.0), pinned SHA-256, ONNX Runtime | Golden-image tests vs official code; no site precision/recall |
| Tracking | Per-camera multi-object tracker, 4-state lifecycle, class-scoped | IoU + constant velocity | Unit tests |
| Track index | One record per tracked object: path, direction, dwell, zone visits, clothing/body colour, plate tied to the vehicle | Rules + pixel-count colours (no colour model) | Real DB, synthetic detections |
| Spatial rules | Directional tripwire, continuous loitering, zones | Geometry with hysteresis | Real DB |
| Indian ANPR | Plate detect + OCR, multi-frame voting, state/BH validation, watchlists, LPR camera mode | PP-OCRv4 det + fast-plate-ocr (candidate models, need licence approval) | Golden images; benchmark tool built, no Indian site numbers |
| Redaction | Faces and plates found and burned out with opaque masks, derivative hashed into custody | YuNet + PP-OCRv4 det | Real ffmpeg; recall on site footage not measured |
| Semantic search | Crops embedded; search by text, by example crop, by uploaded photo; AND/NOT; one result per track; filters before ranking; person searches purpose-gated and audited | SigLIP 2 (owner-approved) in pgvector | Real DB, controlled embeddings; recall@k not measured |
| Cross-camera following | Suggests the same vehicle by plate (anywhere) or the same person or vehicle by appearance (neighbouring cameras, travel time); operator confirms; confirmed links form a journey | Embedding similarity + plate keys + camera adjacency | Real DB; top-5 accuracy needs pilot data |
| Investigation workspace | Find, open, follow, decide, journey on the floorplan, journey to incident, sealed multi-camera package, time-to-answer stopwatch | No model | Browser tests |
| Alarm explanations | "Why was this flagged" record, hashed into evidence and re-checked by the verifier | Template (no model) | Real DB |
| Alarm second opinion | Is the detected object really in the snapshot: yes / no / unclear, advisory only | SmolVLM2 2.2B via llama.cpp (needs licence approval) | 8 labelled questions; agreement with operators not measured |
| Camera-native events | ONVIF, Hikvision ISAPI, Dahua events into the same rule engine | Camera-side analytics | Protocol stubs |
| Scene change / motion | Episode detection on the substream | Classical (ffmpeg scene score) | Real |
| Rule engine | Event-action matrix, correlation, dry-run against past events, relays and doors | Deterministic | Real DB, simulated I/O |
| Evaluation tools | ANPR benchmark (calibration, operating points), recall@k, detector eval, time-to-answer report | Harness | Synthetic data |
| Adapter platform | ai-adapter.v1 contract, conformance kit, SDK 0.2.0 that the worker's pipelines run on | Contract | 19/19 conformance on 4 worker modes |

**Not built:** natural-language queries and rules (no text LLM in the stack), a summary of a whole incident,
a VLM over clips, open-vocabulary detection, PPE, fire/smoke, fall, weapon, unattended object, crowd density,
audio, face recognition (deliberately), deterrence/talk-down, an agent/MCP interface, and signing footage at
capture.

## 3. What the market ships in 2026

### Global

| Vendor | 2026 AI features (vendor claims) |
| --- | --- |
| **Verkada** | AI search; **AI-powered deterrence** (detects loitering and plays escalating AI-generated warnings that use scene context, with a random voice each time; also on intercoms); **compound alerts** (motion + attributes, e.g. loitering near machinery without PPE; GA 30 Mar 2026); live two-way intercom translation incl. Hindi; **Catalyst**: connects Command to ChatGPT, Claude and Gemini over MCP, read-only tools, private beta; fleet video, audio. |
| **Genetec** (Security Center SaaS, rolling out from Feb 2026) | Natural-language search across sites and camera brands; similarity search; entry/exit detection; visual trajectory search; **case and evidence management with AI-written video summaries**, clips ordered by time. |
| **Milestone** | Hafnia VLM (on NVIDIA Cosmos Reason, released 22 Dec 2025, traffic-focused); XProtect **Video Summarization** (clip + prompt gives a written summary, pay per prompt; vendor says up to 30% less false-alarm fatigue); VLM as a service; AI Search announced for end of 2026. |
| **Brivo / Eagle Eye** | Smart Video Search (type a description); **Eeva** (Mar 2026): type what to watch for ("worker not wearing a safety vest") and it monitors and notifies, VLM-based, camera-neutral; gun detection; LPR. |
| **Ambient.ai** (26 Aug 2026) | **Agentic video walls** (an agent per camera decides what an operator should see now); **case management** that turns clips into one connected incident story; double camera density on the same hardware. |
| **Spot AI** (Aug 2026) | "Video AI agents" that detect issues and act (alert, lights, sound, voice messages, machinery); AI Safety Manager, AI Security Guard, Operations Assistant. |
| **i-PRO, Hanwha** | i-PRO: first cameras with generative AI on the camera (Ambarella CV72), **free-text detection from a natural-language description**, shipped June 2026. Hanwha: about 4x on-camera inference with Ambarella. |
| **Hikvision** | AcuSeek NVR on the Guanlan multimodal model: natural-language search beyond fixed classes ("e-bike rider without a helmet", "wheeled luggage"). |
| **NVIDIA VSS 3** (reference, not a VMS) | Agentic search, real-time VLM alerts, alert verification, long-video summarisation, 16 "agent skills"; one H100 handles 330 streams for search ingest and 147 for alert verification (NVIDIA's numbers). |

### India

| Vendor | 2026 position |
| --- | --- |
| **CP Plus × Qualcomm** | Gen-AI assistant for natural-language event queries, "Merlin" audits, video search and summarisation, PPE, crowd density, blocked pathways, on device; announced for Q1 2026 (shipment not confirmed in this sweep). |
| **Staqu JARVIS** | 50+ use cases and 100+ analytics: fire, PPE, face access, footfall, queues, intrusion, ANPR, retail, patient safety; prisons, police, factories, smart city. |
| **Videonetics** | Broadest catalogue (incl. women-safety analytics); markets semantic search, cross-camera correlation, multimodal AI; "AI Company of the Year 2026" award. |
| **Vehant OKEAN, AllGoVision, SrivisifAI** | Broad analytics, attribute and text search (SrivisifAI), video summarisation (Vehant); no VLM, audio or weapon features found (28 Sept research). |
| **Public buyers** | Safe City (8 metros, Nirbhaya Fund): AI "abnormal activity" alerts into command centres. Indian Railways: AI CCTV at major stations, facial recognition at CST and New Delhi, unattended luggage, unusual behaviour, track/yard intrusion; a reported ₹75,000 crore plan for AI cameras in coaches and locomotives. |

## 4. Gap matrix

✔ shipped · ◐ partial or announced · ✘ not found

| Capability | VigilOne | Global leaders | Indian vendors |
| --- | --- | --- | --- |
| Detection, tracking, zones, line crossing, loitering | ✔ | ✔ | ✔ |
| ANPR tuned for Indian plates | ✔ (not benchmarked) | ◐ | ✔ |
| Search by description / photo / example | ✔ (crop and track) | ✔ | ✔ (Hikvision, SrivisifAI); ◐ CP Plus |
| **Natural-language query** ("white van at gate 3 after 10 pm" → filters) | ✘ (keyword text only) | ✔ Genetec, Eagle Eye | ◐ CP Plus, Hikvision |
| Cross-camera following, journey | ✔ | ✔ Genetec trajectories | ◐ Videonetics (claimed) |
| **Describe what to watch** (NL → live alert) | ✘ | ✔ Eeva, i-PRO, Verkada compound alerts | ✘ found |
| **Incident story / case file with AI summary** | ◐ (journey + package, no summary) | ✔ Genetec, Ambient, Milestone | ◐ Vehant summarisation |
| VLM verification of alarms | ✔ (snapshot, advisory) | ✔ Milestone, NVIDIA | ✘ found |
| VLM over clips ("what happened here") | ✘ | ✔ Milestone, NVIDIA | ◐ CP Plus |
| **Alarm prioritisation / agentic video wall** | ✘ | ✔ Ambient | ✘ |
| Deterrence / talk-down | ✘ | ✔ Verkada, Spot AI | ✘ found |
| **AI agent / MCP interface** | ✘ | ◐ Verkada (beta), NVIDIA | ✘ |
| PPE, fire/smoke, fall, crowd density | ✘ | ✔ | ✔ (crowded) |
| Unattended object, track intrusion | ◐ (zones only) | ✔ | ✔ (Railways demand) |
| Weapon, audio, gait | ✘ | ◐ (gun: Eagle Eye) | ✘ (28 Sept) |
| **Evidence-chained AI output** (hashed, verifiable) | ✔ (explanations, provenance) | ✘ found | ✘ found |
| **Signed footage / tamper evidence** | ◐ (segment hashes, custody) | ◐ (C2PA talk, little shipped) | ✘ found |
| Fully offline / on-site AI | ✔ | ◐ (mostly cloud: Verkada, Eagle Eye, Ambient, Spot) | ◐ (CP Plus on device) |

## 5. Need of the hour, 2026 and after

1. **Alarm fatigue.** False alarms are still quoted at 90–98% (SIAC / Urban Institute data, via a 2026 trade
   article), and operators degrade after a few hours. Everything that cuts or ranks alarms sells.
2. **From search to "describe, then act".** Operators expect to *say* what they want, both for past footage and
   for live alerts, and expect the system to write the incident up.
3. **Agents.** Buyers now ask whether the VMS works with *their* AI assistant (MCP). For Indian government and
   critical sites the answer must also work offline, with a local model.
4. **Evidence you can trust in a deepfake era.** Deepfake incidents grew steeply (8 million cases in 2025, per a
   2026 briefing). Courts are writing rules for machine-generated evidence (proposed US FRE 707). C2PA signs
   media at capture. In India, BSA s.63 already asks for certified electronic records. Signed, tamper-evident
   footage is turning into a requirement.
5. **India specifics.** Hindi and regional languages in the UI, the queries and the talk-down; DPDP (Rules
   notified Nov 2025, phased start); public-safety tenders (Safe City, Railways) with unattended luggage,
   intrusion, crowd and women-safety asks; and factory safety (PPE, forklift, fall) as the main enterprise
   use.
6. **Edge hardware is catching up.** Small open VLMs now run in about 6 GB (Qwen3-VL-8B at Q4, Apache-2.0,
   per a 2026 roundup), and VLMs run on cameras (i-PRO). On-site generative AI is feasible on our reference
   appliance, which keeps "never cloud-only" intact.

## 6. Candidates, ranked

Effort is relative: S = days, M = 1–2 weeks, L = several weeks or needs data/hardware. "Reuses" lists what is
already built.

### Tier 1: build next (software only, on what exists, closes the biggest gaps)

| # | Feature | What it is | Why | Reuses | Effort | Risk / gate |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Natural-language search** | Operator types "white SUV at Gate 3 between 8 and 10 pm, not a taxi". A local LLM turns it into structured filters + text terms + AND/NOT. These are **shown before running**, then track search runs. | Parity with Genetec, Eagle Eye, Hikvision, CP Plus; time-to-answer is our North Star metric | Track search, filters, AND/NOT, purpose gates | M | Needs a local text LLM (licence decision); Hindi queries as a stretch |
| 2 | **"Describe what to watch" rules** | "Alert me if a person stays near the server room more than 5 minutes after 10 pm." The LLM drafts a normal rule; the dry-run shows what it would have caught last week; the operator saves it. For things our detectors can't see ("no vest", "ladder against the fence"), add an **open-vocabulary check**: SigLIP 2 text-vs-crop score, then a VLM check on the few hits. Advisory until measured. | The 2026 headline feature (Eeva, i-PRO, Verkada); no Indian vendor found | Rule engine, dry-run, zones, track index, SigLIP 2, VLM adapter | M (rules) + M (open-vocab) | Same LLM decision; open-vocab precision must be measured before it can raise real alarms |
| 3 | **Incident reconstruction with a cited summary** | From a journey or alarm: an ordered timeline ("19:42 enters Gate A … 19:47 vehicle exits, plate …"), then a short written summary **in which every sentence cites timeline facts**. Hashed into custody and checked by `vigilone-verify`, like explanations. | Genetec, Ambient and Milestone sell "the incident story"; **only we can make it court-grade** | Journey, journey-to-incident, explanations chain, evidence package | M | LLM for the prose (or a template first, the LLM later) |
| 4 | **Alarm triage that learns** | Rank open alarms by risk (rule severity, after-hours, VLM "no", zone, repeat camera); learn from operator verdicts which camera + rule + time pairs are mostly false; **propose** (never apply silently) a quieter rule or a VLM gate; report false-alarm rate per camera. | Alarm fatigue is the top 2026 pain; Ambient's "agentic video wall" | Alarm verdicts, SLA, VLM second opinion, rule engine, dry-run | M | None external; keep "AI proposes, rule engine acts" |
| 5 | **Footage integrity** | Sign segment hashes at ingest (a per-device key, with the chain anchored in the audit log), **C2PA-style manifests on exports**, and classic **camera-sabotage detection** (covered, defocused, moved or blinded camera) from the substream. | Deepfake-era evidence; extends our strongest moat; sabotage detection is table stakes in tenders | Segment hashing, custody chain, verifier, watchdog | M | C2PA library licence check; sabotage detection is classical CV, no model licence |

### Tier 2: next, after Tier 1 or alongside a pilot

| # | Feature | Notes | Effort |
| --- | --- | --- | --- |
| 6 | **VLM on short clips** ("what happened here", "did the person fall") | Only on clips picked by cheap detection, never every frame; advisory. Candidate models: Qwen3-VL small sizes (Apache-2.0), InternVL (MIT-style). Needs reference hardware numbers. | M–L |
| 7 | **Local agent interface (MCP)** | Read-only tools (search, tracks, journeys, alarms, reports) over MCP for the customer's assistant, plus the same tools for our local model; every call audited and purpose-gated. Matches Verkada Catalyst, works air-gapped. | M |
| 8 | **Shift / overnight digest** | "What happened overnight" built from events and alarms, cited and hashed like item 3. Cheap once item 3 exists. | S |
| 9 | **Talk-down deterrence** | A rule-engine action: on loitering in a zone after hours, play an escalating message through an IP speaker or the camera's audio out, in **Hindi and regional languages**. Pre-recorded clips first, generated speech later. Needs speakers on the bench. | M |
| 10 | **Factory safety pack** (PPE, restricted zone, forklift proximity, fall) | The main enterprise use in India, but crowded. Needs licensed training data and site evaluation. Item 2's open-vocab check can cover "no vest / no helmet" first, without training. | L |

### Tier 3: needs data, hardware or a vertical decision

- **Public-safety pack:** unattended object (static object in a zone + dwell; doable on our tracks), track and
  yard intrusion (zones already work), crowd density, then *predictive* crowd flow (still a gap in India).
  Aimed at Railways and Safe City tenders.
- **Women-safety analytics** (isolation, encirclement, SOS gesture): Videonetics already ships them. Needs data
  and careful DPDP handling.
- **Weapon detection, audio events, gait re-ID:** still gaps in India (28 Sept), but need cleared data, audio
  ingestion or careful governance.

### Do not build (unchanged)

1:N face recognition as a core feature; anything cloud-only; YOLO-World (GPL-3.0) or other non-permissive models;
racing to "100 analytics".

## 7. Decisions for the owner

1. **Pick the Tier 1 order.** Recommended: 1 (natural-language search) → 3 (cited incident summary) → 2 (describe
   what to watch) → 4 (alarm triage) → 5 (footage integrity). Items 4 and 5 need no model decision and can start
   at once.
2. **Local text LLM.** Items 1–3, 7 and 8 need a small instruction model running on site. Candidates to evaluate
   for licence and size: the Qwen3 family (Apache-2.0) and Phi-4-mini (MIT). Llama and Gemma carry custom terms,
   so they need a legal read first. Same governance as SmolVLM2: pinned hash, licence approval, model card.
3. **Languages.** Should Hindi be in scope for natural-language queries and talk-down from the start?
4. **Vertical.** Factory safety or public safety (Railways / Safe City) first? This decides Tier 2–3.
5. **The pilot still comes first for credibility.** Every feature above still needs measured precision and
   recall on real footage before it is sold.

## Not verified / caveats

- Vendor features come from press releases and trade-press summaries returned by web search; verkada.com and
  ambient.ai could not be opened from this sandbox (egress blocked). Nothing was tried hands-on.
- CP Plus × Qualcomm's Q1 2026 availability was announced; actual shipment was not confirmed.
- Model sizes and scores (Qwen3-VL-8B in about 6 GB at Q4) come from a third-party 2026 roundup, not our
  measurements. Licences must be checked on each model card before approval.
- The false-alarm (90–98%) and deepfake (8 million in 2025) figures are quoted from vendor and consultancy
  articles.
- The Railways figures (₹75,000 crore, coach and locomotive cameras) are from news coverage.
- The 28 Sept "first in India" gaps (weapon, audio, gait, evidence-chained explanations, predictive crowd) were
  not re-checked in this sweep.

## Sources

- Verkada: [Feb 2026 deterrence (PR Newswire)](https://www.prnewswire.com/news-releases/verkada-launches-ai-powered-deterrence-ushering-in-a-new-era-where-intelligent-systems-can-help-prevent-crimes-before-they-happen-302686606.html), [Feb 2026 update summary](https://bluecapit.com/blog/verkada-february-2026-product-update.html), [MCP and transportation (PR Newswire)](https://www.prnewswire.com/news-releases/verkada-expands-physical-ai-platform-with-transportation-security-cloud-managed-sound-systems-and-mcp-integrations-302882121.html), [SecurityInfoWatch](https://www.securityinfowatch.com/video-surveillance/news/55406017/verkada-verkada-broadens-security-platform-with-fleet-audio-and-ai-capabilities)
- Genetec: [Security Systems News](https://www.securitysystemsnews.com/article/genetec-announces-new-investigation-capabilities-in-security-center-saas), [Cyber Daily](https://www.cyberdaily.au/security/13203-genetec-adds-ai-driven-investigation-tools-to-security-center-saas)
- Milestone: [VLM launch](https://www.milestonesys.com/company/news/press-releases/milestone-launches-vision-language-model/), [AI for security operations](https://www.milestonesys.com/company/news/press-releases/ai-built-for-security-operations/), [SecurityBrief](https://securitybrief.co.uk/story/milestone-unveils-hafnia-traffic-vlm-xprotect-plug-in)
- Brivo / Eagle Eye: [Eeva (Business Wire)](https://www.businesswire.com/news/home/20260317090970/en/Introducing-Eeva-Your-AI-Video-Agent-That-Keeps-an-Eye-on-Anything), [SDM](https://www.sdmmag.com/articles/105209-brivo-introduces-ai-video-agent-eeva-to-keep-an-eye-on-anything), [Smart Video Search](https://www.een.com/product/vms-video-management-system/smart-video-search/)
- Ambient.ai: [press release (Yahoo Finance copy)](https://finance.yahoo.com/technology/ai/articles/ambient-ai-introduces-agentic-physical-130000192.html), [SourceSecurity](https://www.sourcesecurity.com/news/ambient-ai-unveils-agentic-physical-security-co-1642678221-ga.1787824188.html)
- Spot AI: [Video AI Agents](https://www.spot.ai/blog/spot-ai-introduces-first-video-ai-agents-for-the-physical-world-as-it-nears-100-million-in-funding-to-date)
- i-PRO / Hanwha: [i-PRO generative AI at the edge](https://i-pro.com/products_and_solutions/en/surveillance/newsroom/i-pro-introduces-its-first-cameras-generative-ai-edge), [SourceSecurity ISC West 2026](https://www.sourcesecurity.com/news/pro-unveils-genai-edge-cameras-real-co-1584600779-ga.1774256967.html)
- Hikvision: [AcuSeek NVR](https://www.hikvision.com/en/newsroom/latest-news/2025/hikvision-launches-groundbreaking-acuseek-nvr-redefining-video-retrieval-with-large-multimodal-ai-models/)
- NVIDIA: [VSS repository](https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization), [agents and skills blog](https://developer.nvidia.com/blog/transform-video-into-instantly-searchable-actionable-intelligence-with-ai-agents-and-skills/)
- India: [CP Plus × Qualcomm](https://cpplusworld.com/news/238), [The Fast Mode](https://www.thefastmode.com/technology-solutions/46357-cp-plus-qualcomm-launch-next-gen-video-security-platform-with-on-device-ai-real-time-insights), [Staqu 2026](https://www.staqu.com/blog-ai-powered-video-analytics-adoption-2026/), [Videonetics award](https://www.securitylinkindia.com/business/15/videonetics-has-been-honoured-as-ai-company-of-the-year-ai-powered-video-intelligence-2026/), [Delhi Safe City (IFF)](https://internetfreedom.in/delhis-safe-city-project-and-the-expansion-of-ai-enabled-surveillance/), [Railways AI CCTV](https://metrorailtoday.com/news/indian-railways-to-invest-75000-crore-to-procure-75000-ai-based-cctv-cameras), [Railways AI and drones](https://theindianeye.com/2026/05/21/railways-to-use-ai-drones-cctv-to-boost-safety-urges-passenger-to-stay-vigilant/), [manufacturing use cases](https://www.agrexai.com/ai-video-analytics-manufacturing-india-use-cases/)
- Trends: [Brivo 2026 trends](https://www.brivo.com/2026-trends-in-video-surveillance/), [Arcadian alarm monitoring guide](https://www.arcadian.ai/blogs/blogs/alarm-monitoring-for-video-surveillance-the-2026-guide-to-accuracy-compliance-and-ai-driven-operations), [SDM 2026 predictions](https://www.sdmmag.com/articles/104966-2026-predictions-security-experts-talk-ai-proactive-deterrence-video-analytics-and-more), [Intellisee provenance briefing](https://intellisee.com/intelligence/surveillance-footage-authentication-deepfake-evidentiary-c2pa-nist-fre-707-2026-standards-compliance/)
- Models: [small local VLMs 2026](https://tinyweights.dev/posts/best-local-vision-language-models-2026/), [Qwen3-VL overview](https://docs.kanaries.net/articles/qwen3-vl)
- Earlier research in this folder: `vigilone-ai-features-and-research-2026-09-23.md`, `vigilone-first-in-india-ai-features-2026-09-28.md`, `vigilone-ai-strategy-collated-2026-09-28.md`, `00-north-star-v0.1-and-v1.0-plan-2026-09-29.md`.
