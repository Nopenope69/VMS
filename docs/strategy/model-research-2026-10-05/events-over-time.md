# VigilOne: detecting events that unfold over time

Collision/accident, fight/violence, crowd surge/running, tailgating, vandalism, general video anomaly detection

Research date: 2026-10-05. Prepared for VigilOne (on-prem VMS, India). Stack assumptions: YOLOX (Apache-2.0), MOT tracks, rule engine, SigLIP 2 (Apache-2.0), SmolVLM2-2.2B via llama.cpp, RTMPose planned. Runtime: Node.js + onnxruntime-node (ONNX) + llama.cpp (GGUF). CPU-first (x86, 4–8 cores), optional NVIDIA GPU.

**How this was checked.** LICENSE files were pulled from `raw.githubusercontent.com`. Model licences came from the Hugging Face API `cardData` and the model-card text. Facts about papers and vendors come from web-search abstracts and snippets, because arxiv.org, kaggle.com, *.github.io project pages and most vendor sites were blocked by the egress proxy in this session. Anything not confirmed from a primary file is marked **UNVERIFIED**. CPU latency numbers marked "est." are my engineering estimates, not measurements. Benchmark them before quoting them to a customer.

Legend: ✅ usable commercially (normal attribution/NOTICE duties apply) · ⚠️ usable only with a caveat or a human/legal decision · ❌ reject (GPL/AGPL, non-commercial, research-only, or no licence).

---

## 0. Executive summary

1. **Most of the value comes from rules on the tracks we already have, with a multi-frame VLM as verifier.** Accident ("stopped vehicle(s) in live lane after abrupt deceleration/contact"), running/panic, crowd density, counter-flow and tailgating can all be built as rules on the existing tracks with no new licence exposure. A multi-frame VLM check on the triggered clip then cuts false alarms. This is the pattern competitors ship, and Intel published the same thing for fights as an MIT-licensed reference (Qwen2-VL-2B prompted yes/no).
2. **The VLM landscape changed in 2025–2026 in our favour.**
   - **Qwen3-VL (2B/4B/8B/30B-A3B)** is Apache-2.0.
   - **Qwen3.5 (0.8B/2B/4B/9B)** is Apache-2.0, natively multimodal with video, and has GGUF+mmproj.
   - **Gemma 4 (E2B/E4B/12B/26B-A4B/31B)** is now **Apache-2.0**, not the Gemma Terms, and is in llama.cpp's official multimodal list.
   - **MiniCPM-V 4 / 4.5** is now Apache-2.0.
   - llama-server now accepts `input_video`, decoding with ffmpeg and using `--video-fps`.
   - Watch out: **Qwen2.5-VL-3B** is under the **Qwen Research License (non-commercial) ❌**, even though the `ggml-org` GGUF repo of it is tagged apache-2.0.
3. **Learned clip classifiers have a code-vs-weights-vs-data problem.**
   - The code is fine: mmaction2, pyskl, pytorchvideo/X3D, SlowFast, MoViNet, UniFormerV2 and InternVideo are all Apache-2.0.
   - Every off-the-shelf checkpoint is trained on Kinetics (CC BY 4.0 annotations over YouTube videos, ⚠️) or NTU RGB+D (commercial use prohibited, ❌).
   - VideoMAE/VideoMAE v2/TimeSformer weights are **CC BY-NC ❌**, and CTR-GCN code is CC BY-NC ❌.
   - Nearly every fight/violence dataset is non-commercial or of unclear copyright: RWF-2000 ❌, UBI-Fights ❌, NTU CCTV-Fights ❌, Movies ❌, Hockey ⚠️, Surveillance-Camera-Fight ⚠️ (MIT repo, but YouTube clips).
   - **Bottom line: a production-grade learned fight or accident model needs our own consented training data.** This is a human/business decision.
4. **Crowd counting has the same issue.** Code is mostly MIT (DM-Count, CLIP-EBC, PET, APGCC), but P2PNet is "academic research only" ❌ and CSRNet-pytorch has no licence ❌. JHU-Crowd++ and NWPU-Crowd are non-commercial, so most released weights carry that data taint ⚠️. ShanghaiTech is BSD-2 per its repo ⚠️. YOLOX person counts plus a homography are enough for sparse-to-moderate scenes. Dense scenes (Kumbh, station concourses) need a density model we train ourselves.
5. **Weakly supervised VAD (RTFM, MGFN, UR-DMU, VadCLIP) is mostly hype for product use.**
   - Benchmark AUCs of 84–88 % on UCF-Crime overstate real-world value. 2025–26 papers show frame-AUC is dominated by easy cross-video pairs and says little about localisation or false-alarm rate.
   - LAVAD as published depends on ImageBind (CC BY-NC-SA ❌) and Llama-2.
   - A better buy is an Avigilon-UMD-style per-cell statistical "unusual motion" model on our tracks and flow (own IP, CPU-cheap), plus VLM verification.
   - When we use a VLM as a scorer, use **token probabilities** (logprobs of "yes"), not the decoded yes/no. A 2026 paper reports +7.7 to +20 points from doing exactly this.

---

## 1. Vehicle collision / road accident

### 1.1 What can be done with rules on our existing tracks (no new model)

Accidents in CCTV view are rare, short (under 1 s of contact) and often far away, but their **aftermath** is long and very visible: vehicles stopped in a live lane, people getting out, traffic queuing behind, sometimes smoke or debris. Ijjina et al. (2019) took the classic track-based approach (detector + centroid tracking, then accident probability from speed/trajectory anomalies after overlap). Vehant, Videonetics and Hikvision AID all ship "stopped vehicle / incident" as the primary trigger. The rules below are ordered by robustness.

| # | Rule (on tracks) | Signal | Notes / thresholds (tune per camera) |
|---|---|---|---|
| A1 | **Stopped vehicle in live carriageway** | vehicle track speed below v_min for ≥ T s (e.g. 20–60 s) inside a "live lane" zone, outside "parking/bus-stop/toll queue" zones | Already supported by loitering logic; reuse it with vehicle classes. Highest-yield highway rule (NHAI ATMS "incident" class). |
| A2 | **Abrupt deceleration** | Δspeed/Δt beyond a per-class limit (e.g. > 0.5 g equivalent, after ground-plane calibration), followed by A1 | Needs a homography (pixel→metres). Without one, use the relative drop (e.g. from > 60 % of the lane median speed to ~0 within ≤ 1 s). |
| A3 | **Contact / trajectory intersection** | two vehicle tracks whose ground-plane footprints (bottom-edge points or BEV boxes) come within d_min while their relative velocity is high, then **both** satisfy A1/A2 | 2-D box overlap alone is a big false-alarm source because perspective makes boxes overlap in normal traffic. Use the bottom-centre in BEV, not the IoU. |
| A4 | **Heading anomaly** | sudden yaw change > θ (e.g. 45°) inside ≤ 1 s, or a vehicle oriented across lanes | Rollover, spin-out, single-vehicle crash into the median. |
| A5 | **Pedestrians emerge around stopped vehicle** | new person tracks spawning within r of an A1 vehicle on a highway | Strong corroboration on expressways where pedestrians are otherwise rare. Hikvision AID lists "pedestrian" as a separate incident. |
| A6 | **Upstream flow collapse** | lane-level mean speed drops and queue length grows behind the A1 location while downstream flow is low | Separates an incident from ordinary congestion (in congestion, downstream is also slow). |
| A7 | **Track disappears / ID-switch storm** | multiple tracks lost at the same spot (occlusion by an overturned vehicle) | Weak; corroboration only. |
| A8 | **Smoke / fire / debris** | not track-based: SigLIP 2 zero-shot prompt on the A1 region, or the VLM | Use as corroboration, not a trigger. |

**Fusion:** fire a *candidate* when (A3 ∧ A2) ∨ (A2 ∧ A1 ≥ T₁) ∨ (A1 ≥ T₂ ∧ (A5 ∨ A6)). Send the candidate to the VLM verifier (§3) with 6–8 frames covering t−3 s … t+10 s. Escalate as "Possible collision" or "Stopped vehicle" depending on the VLM probability.

**India-specific false-alarm sources:**
- dense mixed traffic (two-wheelers and autos squeeze within centimetres, so contact-like proximity is constant);
- lane indiscipline;
- cattle and stray animals stopping traffic;
- vehicles stopping legitimately (bus stops, autos picking up passengers, toll and signal queues, U-turn gaps, roadside dhabas);
- breakdowns, which customers usually *want* flagged anyway;
- night headlight glare and rain causing detector flicker, and therefore fake decelerations;
- ID switches producing "teleports";
- PTZ moves or camera shake (suppress all rules during PTZ motion);
- ego-dashcam-like footage is irrelevant (fixed cameras only).

**Realistic accuracy:** UNVERIFIED for our stack. Literature and vendor claims are not comparable:
- Vehant claims "accidents and stalled vehicles within 5 seconds";
- Videonetics claims incidents detected "in under 90 seconds";
- Hikvision claims "> 60 % fewer false alarms" for its Transformer-based AID (relative, not absolute).

Expect high recall on *stopped-vehicle* incidents and low-to-moderate recall on the *collision moment* at long range or night. Expect false alarms to be dominated by legitimate stops until zones are drawn carefully.

### 1.2 Learned models / repos for accidents

| Model / repo | Code licence | Weights / training data | Verdict | ONNX / GGUF | CPU cost | Reported accuracy |
|---|---|---|---|---|---|---|
| **ACCIDENT benchmark baselines** (heuristic: naive, optical-flow, bbox-dynamics; LLM/VLM baselines with Qwen) — github.com/accidentbench/ACCIDENT | No LICENSE file found in repo (UNVERIFIED) | Dataset on Kaggle `picekl/accident`; licence UNVERIFIED (Kaggle blocked) | ⚠️ use as **evaluation reference only** until the licence is confirmed | n/a | heuristic: trivial | Leaderboards exist (ID / OOD / zero-shot), numbers UNVERIFIED |
| **X3D-XS/S/M** (pytorchvideo) fine-tuned by us on accident/normal clips | Apache-2.0 ✅ | Pretrained on Kinetics-400 (CC BY 4.0 annotations, YouTube videos) | ⚠️ code ✅, Kinetics-pretrain ⚠️ (see §8) | ONNX ✅ (3D conv supported by ORT) | X3D-XS 0.91 GFLOPs/view, X3D-S 2.96, X3D-M 6.72 (verified, pytorchvideo zoo); est. 10–60 ms/clip on 8 cores | K400 top-1: XS 69.1, S 73.3, M 75.9 (zoo). Accident accuracy depends entirely on our data |
| **MoViNet-A0/A1/A2 (base & stream)** — tensorflow/models | Apache-2.0 ✅ | Kinetics-600 checkpoints | ⚠️ (Kinetics) | TF → ONNX via tf2onnx: base models feasible; streaming state buffers are harder (UNVERIFIED) | A0: 2.7 GFLOPs/video; A0-Stream TFLite **16 ms/frame on x86** (README); A1 33 ms; A2 66 ms | K600 top-1: A0 72.3, A1 76.7, A2 78.6 |
| **SlowFast R50** (SlowFast / pytorchvideo) | Apache-2.0 ✅ | Kinetics | ⚠️ | ONNX feasible | 65.7 GFLOPs × views, too heavy for CPU at scale | K400 76.9 |
| HF `Zeeshanshanih/slowfast-accident-detection` | no licence on card | "balanced Accident/Normal video dataset" (source unstated) | ❌ unclear licence | – | heavy | not stated |
| HF single-frame accident detectors (`hilmantm/detr-traffic-accident-detection` Apache-2.0, `Enos-123/traffic-accident-detection-yolo11x` MIT, etc.) | card licences as shown; YOLO11 itself is **AGPL-3.0** (Ultralytics) | Roboflow-type image sets, licence UNVERIFIED | ❌ for YOLO11-based (AGPL); ⚠️ for DETR-based (data unclear) | ONNX ✅ | moderate | Single frames cannot see "an event over time"; they classify crashed-looking cars and miss the dynamics |
| **TAD (Traffic Anomaly Detection) — MoonBlvd/tad-IROS2019** | MIT ✅ | Ego-centric dashcam (DoTA/HEV-I) | ⚠️ wrong viewpoint for fixed CCTV | – | – | – |
| **Dashcam accident-anticipation models** (DAD/CCD-based: DSA, UString, etc.) | various | dashcam | Not applicable: ego-motion viewpoint | – | – | – |
| **VLM-on-clip** (Qwen3-VL-2B/4B, Qwen3.5-2B/4B, Gemma 4 E2B/E4B, SmolVLM2) | see §3 | see §3 | ✅ (licence-clean options exist) | GGUF ✅ | est. 5–40 s per clip on CPU (§3) | ACCIDENT has a zero-shot track; Qwen-based baselines in the repo; scores UNVERIFIED |
| **SigLIP 2 temporal head (own)**: per-frame SigLIP 2 embeddings (already computed) → tiny 1-D temporal conv / GRU trained by us | own code | own data + SigLIP 2 (Apache-2.0) | ✅ (if our data is clean) | ONNX ✅ | negligible on top of existing embeddings | must be measured |

**Recommendation for the accident model track:** do not ship a learned clip classifier in v1. Use rules A1–A6 with the VLM verifier. Collect customer-consented incident clips (with the A1 trigger as data engine). Then fine-tune X3D-S or a SigLIP 2 temporal head on our own data in v2.

### 1.3 Accident datasets

| Dataset | Content | Licence (as found) | Commercial verdict |
|---|---|---|---|
| **ACCIDENT** (Picek et al., CVPRW 2026, arXiv 2604.09819) | 2,027 real CCTV clips + 2,211 CARLA synthetic; temporal + spatial + 5 collision types; ID/OOD/zero-shot splits | Kaggle `picekl/accident`; licence UNVERIFIED; real clips internet-sourced from various regions | ⚠️ evaluation only until verified; the **CARLA synthetic generator** is the most commercially promising part (CARLA itself is MIT, UNVERIFIED for assets) |
| **TAD** (Xu et al., "TAD: A Large-Scale Benchmark for Traffic Accidents Detection from Video Surveillance", arXiv 2209.12386, IEEE Access) | CCTV accident videos crawled from the web | UNVERIFIED (repo licence not found) | ⚠️/❌ (internet-crawled; ACCIDENT authors note "frequent duplicates, editing overlays") |
| **CADP** (Shah et al. 2018) | 1,416 CCTV accident clips from YouTube | No LICENSE in GitHub repo `ankitshah009/CADP` (404) | ❌ unclear |
| **DoTA** (Yao et al.) | 4,677 dashcam anomaly clips, YouTube | Repo MIT; README says authors obtained permission from channel owners; 6 videos removed by YouTube | ⚠️ dashcam viewpoint; MIT covers annotations/code, not necessarily the video copyright |
| **CCD – Car Crash Dataset** (Bao et al. 2020) | 1,500 YouTube crash + 3,000 BDD100K normal dashcam clips | Repo MIT | ⚠️ dashcam; YouTube copyright; BDD100K has its own licence (UNVERIFIED) |
| **DAD** (Chan et al. 2016) | 620 dashcam clips (Taiwan) | UNVERIFIED (project page blocked) | ❌ until verified |
| **TUM Traffic Accid3nD** (arXiv 2503.12095) | Roadside multi-sensor, real + simulated crashes | UNVERIFIED (TUM Traffic sets have used CC BY-NC-ND before, UNVERIFIED for this one) | ⚠️/❌ likely NC |
| **CrashSight** (arXiv 2604.08457), **MITS** (2509.09730) | Infrastructure-view crash VQA / traffic surveillance multimodal | UNVERIFIED | ⚠️ |
| Surveillance-video accident transformer paper (arXiv 2512.11350) | 1,000 balanced clips curated from YouTube, IEEE DataPort, AI City | mixed sources | ❌ for training |

---

## 2. Fight / violence / assault

### 2.1 Rules on tracks + pose (planned RTMPose)

Fights are interactions between ≥ 2 people with high, erratic limb motion and close proximity, often followed by a person on the ground and by bystanders converging or scattering. A rule-plus-pose pipeline gets a good candidate generator:

| # | Signal | From |
|---|---|---|
| F1 | ≥ 2 person tracks within d (≈ 1 m BEV) for ≥ 1–2 s | tracks |
| F2 | High **track jitter** / rapid direction reversals of the pair (box centroid acceleration variance) | tracks |
| F3 | **Wrist/ankle speed & acceleration** above per-camera baseline, arms raised above shoulder, strikes directed toward the other person's head/torso box | RTMPose (Apache-2.0 code; RTMPose-m 75.8 COCO AP, ~11 ms ORT CPU on i7-11700 per README) |
| F4 | **Fall**: torso angle → horizontal, bbox aspect ratio flip, person stationary on ground | pose + tracks |
| F5 | **Crowd convergence** (bystanders accelerating toward a point) or **scatter** (radial outward) | tracks |
| F6 | Audio (shouting) if the camera has a mic | out of scope / optional |

A hand-crafted score over F1–F5, or a **tiny skeleton classifier we train ourselves** (ST-GCN-style; ST-GCN code is BSD-2 ✅; do not use NTU-pretrained weights), feeds the VLM verifier. Published skeleton-based results on RWF-2000 are around 90–93 % accuracy (e.g. RTVD-Net 93.28 %, a 60k-parameter model at 90.25 %). These are in-domain balanced-dataset numbers on trimmed clips, not field false-alarm rates.

**False-alarm sources:** sports and play (campus grounds, kids), hugging/greeting, dancing (weddings, festivals), crowded queues pushing, railway platforms when a train arrives (sudden rush), police lathi-charge scenes, staged training, and occlusion in dense crowds (pose fails).

### 2.2 Fight/violence models

| Model | Repo | Code licence | Weights / data | Verdict | ONNX / GGUF | CPU cost | Accuracy |
|---|---|---|---|---|---|---|---|
| **ST-GCN** | yysijie/st-gcn | BSD-2 ✅ | released weights NTU/Kinetics-skeleton | code ✅, **NTU weights ❌** (NTU terms prohibit commercial use), Kinetics-skeleton ⚠️ | ONNX feasible | tiny (< 1 GFLOP per clip, est.) | – |
| **CTR-GCN** | Uason-Chen/CTR-GCN | **CC BY-NC 4.0 ❌** | NTU | ❌ | – | – | – |
| **PoseC3D / pyskl** | kennymckormick/pyskl; mmaction2 `configs/skeleton/posec3d` | Apache-2.0 ✅ | NTU-60/120 ❌, FineGYM, K400-keypoint ⚠️, UCF101/HMDB ⚠️ | code ✅; train our own | ONNX feasible (3D conv) | 14.6–20.6 GFLOPs per clip (mmaction2 README), ~2–3 M params | NTU60-xsub 93.6–94.0 % |
| **mmaction2** (TSN, TSM, X3D, SlowFast, UniFormerV2 configs) | open-mmlab/mmaction2 | Apache-2.0 ✅ | most checkpoints Kinetics ⚠️ | framework ✅ | ONNX via mmdeploy ✅ | varies | – |
| **X3D** (pytorchvideo) | facebookresearch/pytorchvideo | Apache-2.0 ✅ | Kinetics-400 ⚠️ | ⚠️ fine-tune on own data | ONNX ✅ | XS 0.91 / S 2.96 GFLOPs per view | K400 69.1 / 73.3 |
| **MoViNet** | tensorflow/models | Apache-2.0 ✅ | Kinetics-600 ⚠️ | ⚠️ | tf2onnx / TFLite | A0-stream 16 ms/frame x86 | K600 72.3 (A0) |
| **SlowFast** | facebookresearch/SlowFast | Apache-2.0 ✅ | Kinetics/AVA ⚠️ | ⚠️, heavy | ONNX feasible | 65.7 GFLOPs × 30 views (R50 8x8) | K400 76.9 |
| **VideoMAE** | MCG-NJU/VideoMAE; HF MCG-NJU/videomae-* | **CC BY-NC 4.0 ❌** (repo LICENSE and HF cards) | – | ❌ | – | – | – |
| **VideoMAE V2** | OpenGVLab/VideoMAEv2 | code MIT ✅ | **HF weights cc-by-nc-4.0 ❌** (VideoMAEv2-Base/Huge cards) | ❌ (weights) | – | – | – |
| HF fine-tunes of VideoMAE for violence (`cliffer1/...`, `KingTechnician/...-xd-violence-binary` cc-by-nc-4.0; `HappyGook/videomae-violence-detector` tagged MIT) | – | – | derivative of CC BY-NC VideoMAE weights | ❌ (an MIT tag on a fine-tune cannot remove the NC term of the base weights) | – | – | – |
| **TimeSformer** (HF facebook/timesformer-base-finetuned-k400) | – | **cc-by-nc-4.0 ❌** | – | ❌ | – | – | – |
| **UniFormerV2** | OpenGVLab/UniFormerV2 | Apache-2.0 ✅ | CLIP-init + K400/K710 ⚠️; weight licence UNVERIFIED | ⚠️ | ONNX feasible, ViT-B heavy | ViT-B ~100s GFLOPs (UNVERIFIED) | – |
| **InternVideo2** | OpenGVLab/InternVideo; HF InternVideo2-Stage2_1B (apache-2.0, gated "auto") | Apache-2.0 | huge multi-source pretraining incl. YouTube-derived sets | ⚠️ (1B params, GPU only) | – | GPU only | – |
| **V-JEPA 2** (facebook/vjepa2-vitl-fpc64-256) | – | MIT ✅ (card) | large video mix incl. internet video (UNVERIFIED) | ⚠️ data; strong frozen backbone for a linear probe | ONNX feasible; ViT-L | heavy for CPU (est. seconds/clip) | – |
| **X-CLIP** (microsoft/xclip-base-patch32) | – | MIT ✅ (card) | Kinetics-400 ⚠️ | ⚠️; zero-shot text-prompted video classification | ONNX feasible | ViT-B/32 × 8 frames, est. 0.3–1 s CPU | – |
| `jaranohaal/vit-base-violence-detection` (single frame ViT) | – | Apache-2.0 (card) | Real Life Violence Situations (Kaggle; licence UNVERIFIED, YouTube-sourced) | ⚠️ | ONNX community port exists | cheap | "98.80 % test accuracy": dataset bias, not field accuracy |
| **Intel/fight-and-violence-detection** | HF card | MIT (card) | Qwen2-VL-2B-Instruct (Apache-2.0) prompted yes/no, OpenVINO INT4/INT8 | ✅ (pattern reference; we would use our own VLM) | OpenVINO (not ORT/GGUF) | CPU/iGPU/NPU | no metrics on card |

**Verdict:** for violence, the only clean ingredients are (a) Apache/BSD **code** (pyskl/mmaction2/ST-GCN/pytorchvideo), (b) RTMPose, (c) Apache VLMs, and (d) **our own data**. Kinetics-pretrained X3D/MoViNet are a ⚠️ legal call (§8).

### 2.3 Fight/violence datasets

| Dataset | Content | Licence (as found) | Commercial |
|---|---|---|---|
| **RWF-2000** | 2,000 surveillance clips (YouTube), 5 s each | README: "Without the approval of the SMIIP Lab… not allowed for commercial purpose", no redistribution/modification | ❌ |
| **UBI-Fights** | 1,000 videos (216 fights), frame-level labels | CC BY-NC-SA 4.0 (search result; companion repo DegardinBruno/human-self-learning-anomaly LICENSE is CC BY-NC-SA 4.0, verified) | ❌ |
| **Hockey Fight** (Bermejo/Nievas 2011) | 1,000 NHL broadcast clips | No explicit licence; footage is NHL broadcast (copyrighted); Kaggle re-uploads tagged CC0 are not authoritative | ⚠️/❌ |
| **Movies Fight** (Bermejo 2011) | 200 clips from action movies | copyrighted films | ❌ |
| **Surveillance Camera Fight** (Aktı et al. 2019) | 300 × 2 s clips (150 fight from YouTube) | Repo MIT | ⚠️ MIT covers the repo; YouTube clip copyright not cleared |
| **Real Life Violence Situations** (Kaggle, Soliman et al.) | 2,000 YouTube clips | UNVERIFIED (Kaggle blocked) | ⚠️ |
| **XD-Violence** (Wu et al. 2020) | 4,754 videos, 217 h, from movies + YouTube, audio-visual | HF mirror `jherng/xd-violence` states MIT; original site blocked, so UNVERIFIED | ⚠️ (films/YouTube copyright regardless) |
| **UCF-Crime** (Sultani et al. 2018) | 1,900 untrimmed surveillance videos, 13 anomaly classes, 128 h (YouTube/LiveLeak) | UNVERIFIED (crcv.ucf.edu blocked); generally distributed for research | ⚠️/❌ |
| **NTU CCTV-Fights** (ROSE Lab) | 1,000 fight videos (CCTV + mobile) | ROSE Lab release agreement (research); UNVERIFIED for this set, but NTU RGB+D terms explicitly ban commercial use | ❌ |
| **NTU RGB+D 60/120** (skeleton pretraining) | 3D skeletons, 120 actions incl. punching/kicking/pushing | "commercial usage … in any way or form … is considered illegal" without ROSE permission | ❌ |
| **HIVAU-70k** (Holmes-VAU) | 70k multi-granular text annotations on UCF-Crime + XD-Violence | repo MIT; underlying videos as above | ⚠️ |

---

## 3. Video VLMs as multi-frame verifiers

**Pattern:** a rule or model trigger produces a clip. We sample 4–8 frames (or pass a short mp4 to llama-server `input_video`), crop to the region of interest plus context, and ask a constrained question ("Did two or more vehicles collide in these frames? Answer yes or no"). We then **read the logprob of "yes"** rather than the decoded token. Arbitrary thresholds on decoded answers lose ranking: Song & Lee 2026 report +7.66 to +19.95 points from probability-weighted scoring.

### 3.1 Licence and runtime table

| Model | Sizes | Weights licence (HF card) | Commercial | GGUF / llama.cpp | Video / multi-image | Notes |
|---|---|---|---|---|---|---|
| **Qwen3-VL** | 2B, 4B, 8B, 30B-A3B, 32B (Instruct) | **apache-2.0** (all checked sizes) | ✅ | `ggml-org/Qwen3-VL-2B-Instruct-GGUF` (Q8_0 + mmproj), `Qwen/Qwen3-VL-8B-Instruct-GGUF`, `ggml-org/Qwen3-VL-30B-A3B-Instruct-Q8_0-GGUF` | Native video; llama.cpp merges consecutive frames for qwen-vl (`mtmd_bitmap_set_mergeable`) | **Best default for clip verification.** Chinese-origin, see §8 risk. |
| **Qwen3.5** (unified VL, Feb 2026) | 0.8B, 2B, 4B, 9B, 27B, 35B-A3B | **apache-2.0** | ✅ | `unsloth/Qwen3.5-2B-GGUF`, `-4B-GGUF` include mmproj; `ggml-org/Qwen3.5-0.8B-GGUF` (text files only listed) | Card shows `video_url` input, default fps=2 | Card claims it beats Qwen3-VL on visual benchmarks. Newer llama.cpp support; a Qwen3.6 vision bug (#29970) shows the qwen35 vision path is still maturing. |
| Qwen2.5-VL | 3B | **Qwen RESEARCH LICENSE** ("Non-Commercial… research or evaluation purposes only"; commercial needs a licence) | ❌ | `ggml-org/Qwen2.5-VL-3B-Instruct-GGUF` **mis-tagged apache-2.0**; the licence follows the weights | yes | Do not ship. |
| Qwen2.5-VL | 7B, 32B | apache-2.0 | ✅ | ggml-org GGUFs | yes | Superseded by Qwen3-VL. |
| Qwen2.5-VL | 72B | Qwen licence (> 100 M MAU clause) | ⚠️ (fine for us in practice, but GPU-only) | yes | yes | Too big. |
| **Gemma 4** (Mar 2026) | E2B, E4B, 12B, 26B-A4B, 31B | **apache-2.0** (card: "License: Apache 2.0", link ai.google.dev/gemma/docs/gemma_4_license) | ✅ | `ggml-org/gemma-4-E2B-it-GGUF` / E4B / 26B-A4B / 31B in llama.cpp's official list (with mmproj) | Card: "Text, Image… Video, and Audio" | Strong non-Chinese option for government tenders. |
| Gemma 3 | 4B, 12B, 27B | **Gemma Terms of Use** (custom; commercial allowed but with a Prohibited Use Policy and flow-down obligations), gated | ⚠️, now unnecessary given Gemma 4 | ggml-org GGUFs | multi-image | Prefer Gemma 4. |
| **SmolVLM2** | 256M-Video, 500M-Video, 2.2B | apache-2.0 | ✅ | ggml-org GGUFs for all three (official list) | Video-trained | Already in use; weakest reasoning of the group, but the 500M can be a cheap first stage. |
| **InternVL3** | 1B, 2B, 8B, 14B | YAML says `apache-2.0` with `license_name: qwen`; body says "MIT… uses Qwen2.5 (Apache-2.0)" | ✅ for 1B/2B/8B (Qwen2.5 0.5B/1.5B/7B bases are Apache), ⚠️ inconsistent metadata | ggml-org GGUFs 1B/2B/8B/14B | multi-image | – |
| **InternVL3.5** | 1B, 2B, 4B, 8B… | apache-2.0 (body: "uses Qwen3… apache-2.0") | ✅ | GGUF UNVERIFIED (not in the llama.cpp official list) | multi-image/video | – |
| **MiniCPM-V 4 / 4.5**, MiniCPM-o 2.6 | ~4B / 8B | **apache-2.0** ("weights and code are open-sourced under Apache-2.0"; registration questionnaire is optional) | ✅ | llama.cpp guides for 4.0/4.5 (legacy conversion) and 4.6 | 4.5: "6 frames → 64 tokens" 3D-resampler, high-FPS video | Very token-efficient video, attractive for CPU. MiniCPM-V-2_6 is gated with the older licence ⚠️. |
| **LLaVA-OneVision** (lmms-lab, Qwen2 base) | 0.5B, 7B | apache-2.0 | ✅ (training data includes GPT-4V-generated content: low risk, note it) | GGUF UNVERIFIED | multi-image/video | Superseded. |
| **Florence-2** | base, large | MIT | ✅ | ONNX community ports exist (UNVERIFIED); not llama.cpp | single image only | Useful for captions/grounding, not temporal reasoning. |
| **Moondream2** | 2B | apache-2.0 | ✅ | `ggml-org/moondream2-20250414-GGUF` | single image | – |
| Moondream 3 preview | 9B MoE (2B active) | **BSL 1.1** + Additional Use Grant; forbids offering it "to third parties on a hosted or **embedded** basis in order to compete with M87 Labs's paid version(s)" | ❌ (or needs a commercial agreement) | – | – | – |
| LFM2-VL (Liquid) | 450M, 1.6B | LFM Open License v1.0: commercial use only below US$10 M annual revenue | ⚠️ | – | – | – |
| NVIDIA Cosmos-Reason1-7B | 7B (Qwen2.5-VL-7B base) | NVIDIA Open Model License | ⚠️ (UNVERIFIED terms detail) | – | video, physical reasoning | GPU only. |

### 3.2 CPU latency (est.) and how to keep it affordable

- The paper benchmarking compact VLMs for clip-level surveillance anomaly detection (J. Imaging 2025 / arXiv 2603.13306) reports **Qwen2.5-VL-3B at 5.09 s → 2.83 s per clip** after LoRA. Hardware is UNVERIFIED, likely GPU. The same paper finds LoRA adaptation makes compact VLMs match weakly supervised VAD baselines and reduces prompt sensitivity.
- Estimate for llama.cpp on 8-core AVX2/AVX-512 at Q4/Q8:
  - 2B-class VLM: ~1–4 s per 448 px frame for vision encoding, plus prompt prefill. **About 6–25 s for a 6-frame clip.**
  - 4B-class: roughly 2× that.
  - MiniCPM-V 4.5's 3D-resampler (6 frames → 64 tokens) and Qwen's temporal merge reduce LLM prefill but not ViT encode cost.
  - UNVERIFIED: benchmark on target hardware.
- Budget: run the VLM **only on candidates**. Use a per-camera cooldown and a global queue (e.g. ≤ 1 concurrent VLM job on 4-core boxes). With a GPU, Qwen3-VL-4B / Gemma-4-E4B at 6–8 frames is sub-second to a few seconds.
- Use **ROI crops + 1 context frame** and low resolution (`--image-max-tokens`) to bound cost.
- Score with logprobs (llama-server `n_probs` / `logprobs`). Calibrate per event type on our validation clips.

### 3.3 Recommendation

- **Default verifier:** Qwen3-VL-2B (CPU) / Qwen3-VL-4B or 8B (GPU).
- **Non-Chinese alternative:** Gemma 4 E2B (CPU) / E4B (GPU).
- **Benchmark next:** Qwen3.5-2B/4B once llama.cpp's qwen35 vision path stabilises.
- **Keep:** SmolVLM2 as the cheap single-snapshot stage.
- **Reject:** Qwen2.5-VL-3B, Moondream 3, VideoMAE-family fine-tunes.

---

## 4. Crowd: counting, density, surge/stampede risk, running/panic

### 4.1 Rules on our tracks (no new model)

| Event | Rule | Notes |
|---|---|---|
| **Overcrowding** | person count in zone (YOLOX) ÷ zone area (m², from homography) > D₁ for ≥ T s | Reliable to roughly 2–3 persons/m² when heads are visible. Beyond that, detection recall collapses and a density model is needed. Drishti (Kumbh 2025 deployment paper, arXiv 2606.05185) reports density MAE 3.2 persons/m² and a surge of 8.3 persons/m² within 90 s. |
| **Density rising fast** | d(count)/dt over 30–120 s windows above threshold | Better early warning than absolute counts. |
| **Running** | fraction of tracks in zone with speed > k × site baseline (per time-of-day) and ≥ N people | Hikvision, Dahua and Staqu all ship "running"; a single runner is noisy (kids, catching trains). Require multiple people. |
| **Panic / scatter** | ≥ N tracks accelerate simultaneously with divergent (radially outward) headings from a common point | Strong signal for fights, gunfire, falls or other incidents. |
| **Counter-flow / wrong way in crowd** | existing wrong-way rule applied per person in corridor zones | AllGoVision markets "counter flow". |
| **Bottleneck / crush risk** | high density **and** low mean speed **and** high speed variance ("stop-and-go waves") at gates, FOBs, stairs | Crowd-science "turbulence" signature. Needs a density model in dense scenes. |
| **Sudden gathering** | count in zone rises from ~0 to > N within a short window | Dahua/Hikvision "gathering", Videonetics "illegal crowd gathering". |

For dense scenes where tracks break down, add **dense optical flow** (Farnebäck, OpenCV, Apache-2.0) magnitude/divergence per grid cell. It is CPU-cheap and licence-free. Recent stampede papers combine it with CNN-LSTM, but the rule version is sufficient for v1.

### 4.2 Counting/density models

| Model | Code licence | Weights / data | Verdict | ONNX | CPU cost | Accuracy (as reported) |
|---|---|---|---|---|---|---|
| **CSRNet** (leeyeehoo/CSRNet-pytorch) | **no LICENSE file** | ShanghaiTech | ❌ (no licence) | – | VGG-16 backbone, heavy | SHA MAE ~68 (paper, UNVERIFIED) |
| **DM-Count** (cvlab-stonybrook) | MIT ✅ | released weights on UCF-QNRF / NWPU (NC) / SHA | ⚠️ retrain on clean data | ONNX ✅ (VGG-19) | heavy-ish (est. 0.3–1 s per 1080p frame on CPU) | – |
| **P2PNet** (TencentYoutuResearch) | **"Use … shall only be for the purpose of academic research"** | – | ❌ | – | – | – |
| **CLIP-EBC** (Yiming-M) | MIT ✅ | CLIP backbone (MIT) + SHA/SHB/QNRF/NWPU | ⚠️ (data) | ONNX feasible | ResNet/ViT-B, moderate | – |
| **PET** (cxliu0/PET) | MIT ✅ (template placeholder "[year] [fullname]", so slightly sloppy) | SHA | ⚠️ | ONNX feasible (transformer decoder) | moderate | – |
| **APGCC** (AaronCIH/APGCC) | MIT ✅ | SHA-best checkpoint only | ⚠️ | feasible | moderate | SHA MAE 48.7 (per Awiros comparison) |
| **Awiros/crowd-counting-and-localization** (HF, 2026; Indian vendor) | MIT (card) | PET fine-tuned on "curated multi-source dataset with partial annotations"; evaluated on SHA/SHB/JHU/QNRF | ⚠️ training-data provenance UNVERIFIED | – | moderate | SHB MAE 13.8, QNRF MAE 105.8, JHU MAE 74.8 |
| `irail-crowd-counting-yolov8n` (HF) | cc-by-sa-4.0 card; **YOLOv8 = AGPL-3.0** | – | ❌ | – | – | – |
| **YOLOX person count** (existing) | Apache-2.0 ✅ | COCO | ✅ | ✅ | already paid for | good up to moderate density |

**Datasets:** ShanghaiTech (BSD-2-Clause per `desenzhou/ShanghaiTechDataset`; Part A is internet images, so ⚠️), JHU-Crowd++ (academic/non-commercial ❌), NWPU-Crowd (non-commercial, no redistribution ❌), UCF-QNRF (research, UNVERIFIED ⚠️/❌).

**Recommendation:**
- **v1:** YOLOX counts + homography + rules + optical flow.
- **v2:** train a light point/density model with PET or DM-Count **code** (MIT) on ShanghaiTech Part B (street CCTV, BSD-2) plus our own annotated Indian scenes (railway concourses, temples, melas). Head-point annotation is cheap relative to video labelling.

---

## 5. Video anomaly detection (VAD): practical value vs hype

| Method | Code | Weights / data | Verdict | Notes |
|---|---|---|---|---|
| **RTFM** (tianyu0207/RTFM) | no LICENSE found | I3D features (Kinetics) on UCF-Crime/XD/ShanghaiTech | ❌ (no licence) | UCF-Crime AUC 84.3 |
| **MGFN** (carolchenyx/MGFN) | no LICENSE found | same | ❌ | AUC ~86.7–87.0 |
| UR-DMU | UNVERIFIED | same | – | AUC ~87.0 |
| **VadCLIP** (nwpu-zxr/VadCLIP) | Apache-2.0 ✅ | CLIP features + UCF/XD labels | ⚠️ (data) | UCF AUC 88.0, XD AP 84.6 |
| **Holmes-VAD / Holmes-VAU** (pipixin321) | MIT ✅ | multimodal LLM fine-tuned on VAD-Instruct50k / HIVAU-70k (from UCF-Crime + XD-Violence); base LLM licence UNVERIFIED | ⚠️ | explainable; GPU |
| **LAVAD** (lucazanella/lavad, CVPR 2024) | LICENSE not found (404) | training-free: BLIP-2 captions + Llama-2 + **ImageBind (CC BY-NC-SA 4.0 ❌)** | ❌ as published; the *idea* (caption → LLM temporal scoring) is free to reimplement with Apache parts | – |
| **VERA** (arXiv 2412.01095) | UNVERIFIED | training-free verbalised learning of guiding questions | idea reusable | reported ~6 AUC points over LAVAD on UCF-Crime |
| Compact-VLM LoRA (arXiv 2603.13306) | – | Qwen2.5-VL-3B/7B LoRA | idea ✅ (use Qwen3-VL/Gemma 4) | matches weakly supervised baselines |

**Reality check:**
- (a) Frame-AUC on UCF-Crime is inflated by easy cross-video pairs. Within-video anomalous–normal pairs are only 0.07–0.39 % of pairs (arXiv 2608.11985 / 2608.21854). High AUC does not mean usable alarms or onset localisation (arXiv 2604.09327).
- (b) "Anomaly" is site-specific: running is normal on a sports ground.
- (c) The training data is YouTube/LiveLeak footage of non-commercial or unclear status.

**What to build instead (own IP, cheap):** an **Avigilon-UMD-style "Unusual activity" layer**. Avigilon UMD learns per-cell motion-direction and speed histograms and flags low-probability motion (US patents 10,878,227 / 11,580,783), with a ~2-week learning period. Ours would be the same idea on our **tracks**: per cell × class × hour-of-week histograms of speed, heading, occupancy and dwell. Flag low-likelihood observations, rank them and show them in a "review unusual events" timeline, with optional VLM explanation. Sell it as **search/triage**, not as an alarm.

---

## 6. Tailgating and vandalism

**Tailgating (enterprise, campus, data-centre):** pure rules on what we have.
- Door zone + tripwire direction + person count per **access-grant event**. Integrate ACS events (OSDP/Wiegand via the access-control system, or a door-open input). Alert when more than one person crosses within the grant window, or two tracks cross within Δt < 1.5–2 s.
- An overhead or steep-angle camera is strongly preferred (occlusion merges people into one box).
- Pose helps split merged blobs.
- Competitors (AllGoVision) list tailgating as a standard analytic.
- Expected accuracy is high with a good camera angle and poor with a horizontal view.

**Vandalism:** the hardest item; no credible open dataset or model.
- Practical approach: protected-asset ROI (ticket machine, CCTV pole, bus shelter, train coach), person dwell + contact (hand keypoints inside the asset ROI) + high limb acceleration (pose), plus a **scene-change check on the asset ROI** (SigLIP 2 embedding distance or SSIM before/after, gated by lighting changes), then VLM verification.
- Position it as "suspicious interaction with asset", not "vandalism detected".
- Graffiti and spray-painting is detectable via before/after ROI change.

---

## 7. Competitors (claims as published; accuracy rarely disclosed)

| Vendor | Accident / traffic incident | Fight / violence | Crowd | Stated accuracy / notes |
|---|---|---|---|---|
| **Hikvision** | AID cameras (e.g. iDS-TCS900-FI): stopped vehicle, wrong-way, congestion, pedestrian, fallen object, smoke, fire, animal intrusion; "Guanlan" Transformer models | DeepinMind NVR "violent motion"; running, falling, gathering | people density, gathering | "> 60 % fewer false alarms" (AID), "up to 90 %/99 % false-alarm reduction" (DeepinMind/DeepinViewX): relative claims only |
| **Dahua** | ITS incident portfolio (accident-specific claim UNVERIFIED) | WizMind "violence detection", fall detection (stereo analysis) | crowd density, heat maps | none found |
| **Avigilon (Motorola)** | – | – | UAD (object-aware unusual activity), UMD (unsupervised motion) | UMD ~2-week learning; no accuracy figures |
| **Genetec** | via partners | via partners (e.g. Irisity IRIS+ integration) | via partners | – |
| **Milestone partners** | – | **Oddity.ai** violence detection for XProtect; Vaidio plugin; Vivotek VCA | Vaidio crowd | none disclosed |
| **Videonetics** (India) | ITMS: "14 incidents and 8 violation types"; incidents detected "in under 90 seconds" | fighting, rioting, illegal gathering | crowd formation | timing claim only |
| **AllGoVision** (India) | Intelligent traffic surveillance | "abnormal behaviour" (fight-specific claim UNVERIFIED) | crowd count, crowding alert, flow, **counter-flow**; Kumbh Mela case study | none found |
| **Staqu** (India, JARVIS) | – | violence detection in 70 UP prisons (700 cameras); claims training on "over a million videos" of violence | crowd: zone counts, running/stationary/fighting/fallen; RCB stadium (2026) and Ram temple deployments | no accuracy published |
| **Vehant** (India) | TMCS/VIDES: accidents and stalled vehicles "within 5 seconds", NHAI-compliant ATMS | – | – | timing claim only |
| **Cogniphi** (India, AIVI) | – | "Body Skeleton and Action Recognition", anomaly detection | – | product specifics not found (UNVERIFIED) |
| **BriefCam** (Canon) | – | behaviours incl. alerts (fight specifics UNVERIFIED) | crowd alerts | "market-leading accuracy", no numbers |

**Takeaway:** nobody publishes field precision/recall. Indian tenders (NHAI ATMS, smart city ICCC) specify *event lists* and *detection time*, not accuracy, though some ask for demo/PoC acceptance. Shipping the event list with a clear review UI and tunable thresholds is table stakes; VLM verification is our differentiator for false alarms.

---

## 8. Licence cross-cutting issues (human/legal decisions)

1. **Kinetics-pretrained weights** (X3D, MoViNet, SlowFast, X-CLIP, UniFormerV2). The Kinetics annotations are CC BY 4.0, but the videos are YouTube content whose copyright belongs to uploaders. Shipping weights trained on them is common industry practice (TF Hub/pytorchvideo publish them under Apache-2.0), but it is a **legal risk decision**.
   - Option A: accept, with counsel sign-off.
   - Option B: avoid Kinetics and fine-tune from ImageNet/SigLIP 2 image backbones (SigLIP 2 is Apache-2.0, but its own pretraining data is web-scale, same class of question).
2. **NTU RGB+D**: explicit commercial ban. Never use NTU-pretrained skeleton weights (most pyskl/mmaction2 skeleton checkpoints).
3. **"MIT repo of YouTube clips"** (Surveillance-Camera-Fight, CCD, DoTA, XD-Violence mirror): MIT cannot license third-party footage. Treat as evaluation-only unless counsel approves.
4. **GGUF re-uploads inherit the upstream licence**, not the uploader's tag. Example: `ggml-org/Qwen2.5-VL-3B-Instruct-GGUF` is tagged apache-2.0, but the weights are Qwen Research (non-commercial).
5. **AGPL traps**: any Ultralytics YOLOv8/11-based fight, accident or crowd model on HF is ❌.
6. **Own data collection** (the real moat). Decide whether to:
   - stage consented fight/vandalism scenarios with actors at customer-like sites;
   - harvest customer incident clips with contractual consent. India's DPDP Act 2023 applies to identifiable persons, so we need anonymisation, retention limits and a purpose clause (UNVERIFIED legal detail);
   - generate synthetic crashes with CARLA (as the ACCIDENT paper does).
7. **Model origin in government tenders**: Qwen (Alibaba) is Chinese-origin. Indian procurement restrictions under GFR Rule 144(xi) target *bidders* from land-border countries, not open weights. Whether customers object to Chinese-origin model weights is UNVERIFIED and customer-specific. Keep **Gemma 4 (Apache-2.0)** or SmolVLM2 as a drop-in alternative.
8. **Accuracy claims**: do not quote research AUC/accuracy in tenders. Measure on our own labelled site footage with an event-level protocol: per-event recall, false alarms per camera-day, time-to-alert.

---

## 9. Recommended approach per event, ranked by (value to Indian customers) × (feasibility on our stack)

| Rank | Event | Value (India) | Feasibility | v1 (rules on tracks) | Needs new model? | v2 |
|---|---|---|---|---|---|---|
| 1 | **Crowd overcrowding / density rise / gathering / running / counter-flow** | Very high (railways, metro, temples, melas, stadiums, smart-city ICCC) | High | YOLOX counts + homography density, running fraction, scatter, counter-flow, optical-flow turbulence | No (v1) | Own density model (PET/DM-Count code, SHB + own data) for > 3 persons/m² |
| 2 | **Stopped vehicle / accident (highway, city junction)** | Very high (NHAI ATMS tenders, smart-city traffic) | High (stopped) / Medium (collision moment) | Rules A1–A6, zones for legit stops, then VLM verify (Qwen3-VL-2B or Gemma 4 E2B, logprob scoring) | No (VLM exists) | X3D-S or SigLIP 2 temporal head fine-tuned on own clips |
| 3 | **Tailgating** | Medium-high (enterprise, data centres, campuses, factories) | High | Door tripwire + ACS grant correlation + Δt between crossings | No (pose optional) | – |
| 4 | **Fight / violence / assault** | High (railways, prisons, campuses, bus stands) | Medium | Proximity + jitter + pose limb kinematics + fall + bystander convergence, then VLM verify | Pose (RTMPose, planned) | Own skeleton classifier (ST-GCN/PoseC3D code, own data) and/or X3D-S fine-tune; ⚠️ data |
| 5 | **Unusual activity (general VAD)** | Medium (forensic triage) | High | Per-cell × hour-of-week statistics on tracks/flow (UMD-style) | No | VLM captions for search ("explain") |
| 6 | **Fall / person down** (by-product of F4) | Medium-high (railways, factories, elderly) | High once pose exists | pose aspect + stationary | Pose | – |
| 7 | **Vandalism** | Low-medium | Low | Asset ROI contact + limb accel + ROI change, then VLM verify | Pose | Needs own data; no open option |
| 8 | Weakly supervised VAD models (RTFM/MGFN/VadCLIP) | Low | Low (licences, domain shift) | – | – | Do not pursue |

**Architecture:** tracks → rule candidates (cheap, always on) → optional light learned scorer (pose classifier, later X3D) → **VLM verifier on clip** (queue-limited; logprob score; per-event calibrated threshold) → alert with clip and VLM rationale → operator feedback (true/false) stored as labelled data. That feedback loop solves the dataset licence problem over time, subject to customer consent.

---

## 10. Sources

**Licence files / model cards (fetched):**
- tensorflow/models LICENSE (Apache-2.0); MoViNet README: https://github.com/tensorflow/models/blob/master/official/projects/movinet/README.md
- https://github.com/facebookresearch/pytorchvideo (LICENSE Apache-2.0; model zoo: docs/source/model_zoo.md)
- https://github.com/facebookresearch/SlowFast (Apache-2.0)
- https://github.com/open-mmlab/mmaction2 (Apache-2.0); PoseC3D README: configs/skeleton/posec3d/README.md
- https://github.com/kennymckormick/pyskl (Apache-2.0)
- https://github.com/MCG-NJU/VideoMAE (CC BY-NC 4.0); https://huggingface.co/MCG-NJU/videomae-base (cc-by-nc-4.0)
- https://github.com/OpenGVLab/VideoMAEv2 (MIT code); https://huggingface.co/OpenGVLab/VideoMAEv2-Base (cc-by-nc-4.0)
- https://github.com/OpenGVLab/UniFormerV2 (Apache-2.0); https://github.com/OpenGVLab/InternVideo (Apache-2.0); https://huggingface.co/OpenGVLab/InternVideo2-Stage2_1B-224p-f4
- https://github.com/yysijie/st-gcn (BSD-2); https://github.com/Uason-Chen/CTR-GCN (CC BY-NC 4.0)
- https://huggingface.co/facebook/timesformer-base-finetuned-k400 (cc-by-nc-4.0); https://huggingface.co/microsoft/xclip-base-patch32 (MIT); https://huggingface.co/facebook/vjepa2-vitl-fpc64-256 (MIT)
- https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct (Qwen Research License, LICENSE file); https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct; https://huggingface.co/Qwen/Qwen2.5-VL-72B-Instruct
- https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct, -4B, -8B, -30B-A3B, -32B (apache-2.0); https://github.com/QwenLM/Qwen3-VL (Apache-2.0)
- https://huggingface.co/Qwen/Qwen3.5-2B, https://huggingface.co/Qwen/Qwen3.5-4B (apache-2.0, video input)
- https://huggingface.co/google/gemma-4-E2B-it, https://huggingface.co/google/gemma-4-E4B-it (apache-2.0); https://ai.google.dev/gemma/docs/gemma_4_license; https://huggingface.co/google/gemma-3-4b-it (gemma)
- https://huggingface.co/HuggingFaceTB/SmolVLM2-2.2B-Instruct, -500M-Video-Instruct, -256M-Video-Instruct (apache-2.0)
- https://huggingface.co/OpenGVLab/InternVL3-2B; https://huggingface.co/OpenGVLab/InternVL3_5-2B; https://github.com/OpenGVLab/InternVL (MIT)
- https://huggingface.co/openbmb/MiniCPM-V-4_5, https://huggingface.co/openbmb/MiniCPM-V-4 (Apache-2.0); https://github.com/OpenBMB/MiniCPM-V
- https://huggingface.co/lmms-lab/llava-onevision-qwen2-7b-ov (apache-2.0); https://github.com/LLaVA-VL/LLaVA-NeXT (Apache-2.0)
- https://huggingface.co/microsoft/Florence-2-large (MIT); https://huggingface.co/vikhyatk/moondream2 (apache-2.0); https://huggingface.co/moondream/moondream3-preview (BSL 1.1, LICENSE.md)
- https://huggingface.co/LiquidAI/LFM2-VL-1.6B (LFM Open License v1.0, $10M threshold); https://huggingface.co/nvidia/Cosmos-Reason1-7B
- GGUF: https://huggingface.co/ggml-org/Qwen2.5-VL-3B-Instruct-GGUF, https://huggingface.co/ggml-org/Qwen3-VL-2B-Instruct-GGUF, https://huggingface.co/ggml-org/gemma-4-E2B-it-GGUF, https://huggingface.co/unsloth/Qwen3.5-2B-GGUF, https://huggingface.co/ggml-org/SmolVLM2-2.2B-Instruct-GGUF
- llama.cpp: https://github.com/ggml-org/llama.cpp (MIT); docs/multimodal.md; tools/mtmd/README.md; tools/mtmd/mtmd.h; tools/server/README.md (`input_video`, `--video-fps`); issue https://github.com/ggml-org/llama.cpp/issues/29970
- https://huggingface.co/Intel/fight-and-violence-detection (MIT, Qwen2-VL-2B)
- https://huggingface.co/jaranohaal/vit-base-violence-detection; https://huggingface.co/Zeeshanshanih/slowfast-accident-detection; HF search pages for violence/accident/crowd models
- Crowd: https://github.com/cvlab-stonybrook/DM-Count (MIT); https://github.com/TencentYoutuResearch/CrowdCounting-P2PNet (academic-only); https://github.com/Yiming-M/CLIP-EBC (MIT); https://github.com/cxliu0/PET (MIT); https://github.com/AaronCIH/APGCC (MIT); https://github.com/leeyeehoo/CSRNet-pytorch (no licence); https://huggingface.co/Awiros/crowd-counting-and-localization; https://github.com/desenzhou/ShanghaiTechDataset (BSD-2); https://github.com/gjy3035/NWPU-Crowd-Sample-Code
- VAD: https://github.com/nwpu-zxr/VadCLIP (Apache-2.0); https://github.com/pipixin321/HolmesVAD (MIT); https://github.com/pipixin321/HolmesVAU (MIT); https://github.com/lucazanella/lavad; https://github.com/facebookresearch/ImageBind (CC BY-NC-SA 4.0); https://github.com/salesforce/LAVIS (BSD-3); https://github.com/tianyu0207/RTFM; https://github.com/carolchenyx/MGFN
- RTMPose: https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose

**Datasets:**
- https://github.com/mchengny/RWF2000-Video-Database-for-Violence-Detection (licence section)
- https://github.com/seymanurakti/fight-detection-surv-dataset (MIT)
- http://socia-lab.di.ubi.pt/EventDetection/ (UBI-Fights; blocked, CC BY-NC-SA per search); https://github.com/DegardinBruno/human-self-learning-anomaly
- https://huggingface.co/datasets/jherng/xd-violence ; https://roc-ng.github.io/XD-Violence/ (blocked)
- https://www.crcv.ucf.edu/projects/real-world/ (UCF-Crime; blocked)
- https://academictorrents.com/details/38d9ed996a5a75a039b84cf8a137be794e7cee89 (Hockey)
- https://www.kaggle.com/datasets/mohamedmustafa/real-life-violence-situations-dataset (blocked)
- https://rose1.ntu.edu.sg/dataset/actionRecognition/ ; https://rose1.ntu.edu.sg/dataset/cctvFights/
- https://github.com/MoonBlvd/Detection-of-Traffic-Anomaly (DoTA, MIT) ; https://github.com/MoonBlvd/tad-IROS2019 (MIT)
- https://github.com/Cogito2012/CarCrashDataset (MIT)
- https://github.com/ankitshah009/CADP (no licence)
- https://github.com/accidentbench/ACCIDENT ; https://accidentbench.github.io ; https://www.kaggle.com/datasets/picekl/accident ; https://arxiv.org/abs/2604.09819 ; https://openaccess.thecvf.com/content/CVPR2026W/AUTOPILOT/papers/Picek_ACCIDENT_A_Benchmark_Dataset_for_Vehicle_Accident_Detection_from_Traffic_CVPRW_2026_paper.pdf
- https://arxiv.org/pdf/2209.12386 (TAD) ; https://arxiv.org/pdf/2503.12095 (TUM Accid3nD) ; https://arxiv.org/pdf/2604.08457 (CrashSight) ; https://arxiv.org/pdf/2509.09730 (MITS) ; https://arxiv.org/abs/2512.11350
- https://aliensunmin.github.io/project/dashcam/ (DAD; blocked)
- Kinetics: https://github.com/cvdfoundation/kinetics-dataset ; https://github.com/MCG-NJU/VideoMAE/issues/107

**Papers (via search abstracts; arxiv.org blocked for direct fetch):**
- Ijjina et al., CV-based Accident Detection in Traffic Surveillance: https://arxiv.org/abs/1911.10037
- LAVAD: https://arxiv.org/abs/2404.01014 ; VadCLIP: https://arxiv.org/abs/2308.11681 ; VERA: https://arxiv.org/pdf/2412.01095 ; Holmes-VAU: https://arxiv.org/abs/2412.06171
- Compact VLMs for clip-level surveillance VAD: https://arxiv.org/html/2603.13306v1 ; https://www.mdpi.com/2313-433X/11/11/400
- A VLM Answer Is Not an Anomaly Score: https://arxiv.org/abs/2608.21244
- VAD metrics critiques: https://arxiv.org/pdf/2505.19022 ; https://arxiv.org/pdf/2608.11985 ; https://arxiv.org/html/2608.21854 ; https://arxiv.org/html/2604.09327v1
- WS-VAD comparisons: https://pmc.ncbi.nlm.nih.gov/articles/PMC11530626/
- Skeleton violence: https://dl.acm.org/doi/fullHtml/10.1145/3638837.3638878 ; https://github.com/atmguille/Violence-Detection-With-Human-Skeletons ; https://arxiv.org/pdf/2308.13866
- Crowd/stampede: https://arxiv.org/html/2606.05185v1 (Drishti, Kumbh) ; https://pmc.ncbi.nlm.nih.gov/articles/PMC13201541/ ; https://arxiv.org/pdf/2510.18187 (VelocityNet)

**Competitors:**
- Hikvision AID: https://www.hikvision.com/en/products/ITS-Products/traffic-cameras/incident-detection-cameras/ ; https://assets.hikvision.com/prd/public/all/doc/m000117106/iDS-TCS900-FI_Datasheet_20241021.pdf ; DeepinMind: https://www.securityinformed.com/security-videos/hikvision-demonstrates-deepinmind-behavioural-analysis.html ; https://www.hikvision.com/en/products/IP-Products/Network-Cameras/DeepinView-Series/
- Dahua WizMind: https://www.dahuasecurity.com/about-dahua/news-events/news/solutions-and-scenarios/dahua-wizmind-utilizes-leading-ai-technology-to-empower-vertical-markets ; https://www.businesswire.com/news/home/20210510005414/en/
- Avigilon UMD: https://www.securitymagazine.com/articles/88756-unusual-motion-detection-umd-technology ; https://www.emciwireless.com/surveillance/avigilon/unusual-motion-detection/ ; USPTO 10878227, 11580783
- Milestone/Oddity.ai: https://www.milestonesys.com/technology-partner-finder/oddity.ai/oddity.ai-violence-detection-for-milestone/ ; Irisity: https://irisity.com/products/integrations/ ; Vivotek: https://commercialintegrator.com/security/surveillance/vivotek-ai-video-analytics-genetec-milestone
- Videonetics: https://www.videonetics.com/traffic-management-system ; https://www.videonetics.com/public/media/datasheet/new/ITMS.pdf ; https://www.videonetics.com/ai-enable-video/detail
- AllGoVision: https://www.allgovision.com/allgovision-features.php ; https://www.allgovision.com/case-study-kumbh-mela.php
- Staqu: https://inc42.com/buzz/gurugram-startup-staqu-develops-ai-surveillance-system-for-uttar-pradesh-prisons/ ; https://www.businesstoday.in/technology/story/how-staqus-jarvis-is-securing-rcbs-home-ground-for-crowd-control-523087-2026-03-30 ; https://www.business-standard.com/companies/start-ups/staqu-tech-to-provide-ai-led-surveillance-for-ram-temple-inauguration-124011500619_1.html
- Vehant: https://www.vehant.com/solutions/tmcs/traffic-management-control-system/ ; https://www.vehant.com/solutions/vides/video-incident-detection-enforcement-system/
- Cogniphi: https://www.crunchbase.com/organization/cogniphi-technologies ; https://www.linkedin.com/company/cogniphi
- BriefCam: https://www.briefcam.com/wp-content/uploads/2025/06/BriefCam-FederalCapabilitiesStatement-2023-1.pdf
- Kumbh AI: https://www.deccanchronicle.com/nation/ai-powered-surveillance-enhances-maha-kumbh-safety-after-deadly-stampede-1862759
