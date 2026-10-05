# VigilOne: Pose Estimation for Person-Down/Fall and Fence-Climb Detection

Research date: 2026-10-05. Scope: on-prem, CPU-first, `onnxruntime-node` worker; commercial paid product sold in India.

How this was researched:
- LICENSE files were fetched raw from GitHub (`raw.githubusercontent.com`) for every repo listed.
- Model-card licences came from the Hugging Face API and the raw README files.
- Dataset terms came from dataset cards and search-engine extracts. Several vendor and dataset sites (cocodataset.org, hikvision.com, dahuasecurity.com, zenodo.org, ubfc.fr, ai.google.dev, developers.google.com, download.openmmlab.com) were blocked by this sandbox's egress proxy. For those sites, claims come from search-engine extracts of the page and are marked **(search extract)**.
- Anything I could not confirm is marked **UNVERIFIED**.
- CPU latencies marked **[measured]** are my own runs: ONNX Runtime 1.30.0 (Python, the same engine `onnxruntime-node` wraps), CPUExecutionProvider, 4 intra-op threads, a 4-vCPU Intel Xeon @ 2.1 GHz cloud container, fp32, batch 1 unless stated, mean of 30 runs after 5 warm-ups. Treat them as relative numbers: a desktop i7 or Ryzen will be faster.

---

## 0. TL;DR

1. **Primary pose model: the RTMPose family (OpenMMLab, Apache-2.0 code), run top-down on our existing YOLOX person crops.** RTMPose-s gives the best accuracy per CPU millisecond of anything usable:
   - RTMPose-s: 6.2 ms per crop. RTMPose-m: 15.5 ms per crop [measured].
   - Both ship as plain ONNX opset 11 with no custom ops.
   - The pre- and post-processing (affine crop, SimCC argmax) is roughly 100 lines of JS.
   - For crowded railway platforms, add **RTMO** (one-stage, same family): 77 ms per 640×640 frame for RTMO-s [measured]. NMS is already inside the ONNX graph.
2. **The weights are where the licence trap is, not the code.** The ready-made ONNX files everyone uses (rtmlib / OpenMMLab "body7" weights) were trained on 7 datasets:
   - **PoseTrack18** explicitly forbids "training or evaluating commercial surveillance systems" (search extract).
   - **AI Challenger**, **CrowdPose**, **MPII** and **sub-JHMDB** are non-commercial or research-only.
   - **Halpe** has no published licence.
   - Even the "COCO-only" RTMPose checkpoints use a backbone pre-trained on AI Challenger + COCO.
   - **Verdict on the body7 / AIC weights: ⚠️ high-risk for a paid surveillance product.**
   - **Cleanest pretrained options found:** RTMO-s/m/l **COCO-trained** checkpoints (backbone initialised from YOLOX-s COCO, and mmdet YOLOX is trained from scratch) and YOLOX-Pose COCO. That is COCO-only provenance: annotations CC BY 4.0, images under Flickr terms. These come as `.pth` and need a one-time ONNX export.
   - **Recommended long-term path:** fine-tune or re-train RTMPose-s/m (and RTMO-s) ourselves on COCO plus our own consented, commercially licensed CCTV data. Record the provenance.
3. **Fallback:** Lite-HRNet-18/30 (Apache-2.0), trained on COCO only.
   - Qualcomm AI Hub ships a ready Apache-2.0 ONNX at 18.5 ms per crop [measured].
   - Or YOLOX-Pose-s/m (COCO-only, Apache-2.0) as the one-stage fallback.
4. **Rejected:**
   - Ultralytics YOLOv8/11/26-pose: AGPL-3.0; the Enterprise licence is paid.
   - OpenPifPaf: AGPL-3.0.
   - OpenPose and AlphaPose: non-commercial academic licence.
   - YOLO-NAS-Pose: the Deci weights licence forbids commercial and production use.
   - Sapiens (CC BY-NC) and Sapiens2 (its licence bans surveillance and critical-infrastructure use).
   - ED-Pose (IDEA License 1.0, non-commercial research only).
   - CTR-GCN (CC BY-NC).
   - DWPose and RTMW 133-keypoint weights (COCO-WholeBody is non-commercial).
   - MoveNet and BlazePose/MediaPipe: the code and weights are Apache-2.0, but **the model cards say "Any form of surveillance … is explicitly out of scope"**, and both are single-person models.
5. **Fall detection:** use a rule-based state machine on tracked keypoints first: torso angle, height-normalised drop speed, aspect ratio, then post-fall immobility for N seconds. Add zone, schedule and "observed-transition" logic, which is essential on Indian railway platforms where people sleep on the floor. Optionally confirm the event with the llama.cpp VLM on a snapshot. Train a small skeleton classifier (ST-GCN via PYSKL/mmaction2, Apache-2.0 code) only on our own data or CC BY data. Every public pretrained fall or skeleton model found is trained on non-commercial data (NTU RGB+D, UR Fall, Le2i).
6. **Climb detection:** have the operator draw a fence polygon and a "fence-top / height line" per camera. That is the same abstraction Hikvision uses ("Climbing: triggers when a person climbs over the height set", search extract). Use pose cues (wrists above the line, ankles off the ground baseline, hip crossing, change of side) with a state machine. No public, commercially usable fence-climb dataset exists, so plan a staged data collection.

---

## 1. Pose model comparison

Legend: ✅ commercially usable, standard risk (COCO/Flickr caveat only) · ⚠️ usable only after a human or legal decision, or needs retraining · ❌ reject.

"Weights licence" means the licence the publisher states for the checkpoint. OpenMMLab does not publish a separate weights licence; the weights sit under the repo's Apache-2.0. The HF mirror `Tau-J/RTMPose` and `qualcomm/RTMPose-Body2d` both label them apache-2.0. Even so, **a permissive weights licence does not cure restrictions on the training data**. See section 6.

| Model | Repo | Code licence | Weights licence / hosting | Training data (licence) | Commercial verdict | ONNX | Size (params / ONNX) | COCO AP (val) | CPU speed | Last release / activity |
|---|---|---|---|---|---|---|---|---|---|---|
| **RTMPose-t/s/m/l, body7 ("\*")** | github.com/open-mmlab/mmpose (projects/rtmpose), runner github.com/Tau-J/rtmlib | Apache-2.0 (verified, both repos) | Apache-2.0 per repo, no separate weights licence. download.openmmlab.com, mirror HF `Tau-J/RTMPose` (card: apache-2.0) | Body7 = COCO + **AI Challenger** (non-commercial) + **CrowdPose** (academic, non-commercial) + **MPII** ("commercial use is not allowed") + **sub-JHMDB** (research) + **Halpe** (no licence published) + **PoseTrack18** ("forbidden to use … for training or evaluating commercial surveillance systems", search extract) | ⚠️ **High risk.** Fine for internal prototyping. Do not ship without a legal sign-off. | **Yes**, official ONNX (mmdeploy SDK zip). opset 11, no custom ops, outputs `simcc_x [N,17,384]` and `simcc_y [N,17,512]` [measured] | t 3.34M / 13 MB; s 5.47M / 22 MB; m 13.6M / 54 MB; l 27.7M | t 65.9, s 69.7, m 74.9, l 76.7 (256×192); l-384 78.3; x 78.8 | Official i7-11700 ORT: t 3.2 ms, s 4.5 ms, m 11.1 ms, l 18.9 ms. **[measured] 4 vCPU Xeon: t 4.9 ms, s 6.2 ms, m 15.5 ms; batch of 8 crops: s 35 ms, m 79 ms** | mmpose PyPI 1.3.2 (2024-07-12), low activity since then. rtmlib 0.0.16 (2026-08-04), active. Body7 weights dated 2023-05 |
| **RTMPose-t/s/m/l, AIC+COCO** | same | Apache-2.0 | same (`*_simcc-aic-coco_*`), .pth only, export yourself | COCO + **AI Challenger** ("only for non-commercial scientific research", search extract) | ⚠️ (one restricted dataset instead of six) | Export via mmdeploy (opset 11) | as above | t 68.5, s 72.2, m 75.8, l 76.5 | as above | 2023-01 weights |
| **RTMPose-t/s/m/l, "COCO" configs** | same (configs/body_2d_keypoint/rtmpose/coco) | Apache-2.0 | .pth (`*_simcc-coco_pt-aic-coco_*`) | Fine-tuned on COCO, but **backbone initialised from `cspnext-*_udp-aic-coco` (AIC+COCO)**, verified in the config | ⚠️ (residual AIC lineage) | Export via mmdeploy | as above | t 68.2, s 71.6, m 74.6, l 75.8 | as above | 2023-01 |
| **RTMO-s/m/l (body7)** one-stage | mmpose projects/rtmo | Apache-2.0 | ONNX on openmmlab and the HF mirror | Body7 (as above) | ⚠️ High risk (same as RTMPose body7) | **Yes**, official end2end ONNX, opset 11, includes `TopK` + `NonMaxSuppression`, outputs `dets`, `keypoints` [measured] | s 40 MB, m 89 MB ONNX | s 68.6, m 72.6, l 74.8 (640) | Paper: V100 ORT s 8.9 ms, m 12.4 ms, l 19.1 ms. **[measured] 4 vCPU Xeon, 640×640: s 77 ms/frame, m 163 ms/frame** (for all people in the frame) | 2023-12 weights |
| **RTMO-s/m/l (COCO)** | same, configs/body_2d_keypoint/rtmo/coco | Apache-2.0 | .pth on download.openmmlab.com | **COCO only.** Backbone initialised from mmdet `yolox_s_8x8_300e_coco` (verified in the config). mmdet's YOLOX config has no ImageNet init, so it is trained from scratch (config check) | ✅ (**cleanest pretrained option**, COCO/Flickr caveat only) | Export via mmdeploy (same graph as the body7 ONNX, so opset 11 with NMS is expected) | same as body7 | s 67.7, m 70.9, l 72.4 | ≈ RTMO body7 (same architecture) | 2023-12 |
| **RTMW / DWPose (133 kp whole-body)** | mmpose; github.com/IDEA-Research/DWPose | Apache-2.0 (both) | HF `yzd-v/DWPose` (apache-2.0 tag): `dw-ll_ucoco_384.onnx` | **COCO-WholeBody** ("ONLY for research and non-commercial use", verified README) + UBody; RTMW adds Human-Art (non-commercial) and 300W, COFW, etc. | ❌ (and overkill: we do not need hands or face) | Yes | RTMW-m 4.3 GFLOPs; DWPose-l 384 | WholeBody AP 58–67 | — | 2023-11 |
| **ViTPose-S/B (COCO, "simple")** | github.com/ViTAE-Transformer/ViTPose; HF transformers port `usyd-community/vitpose-base-simple` | Apache-2.0 (repo and transformers) | OneDrive (repo); HF card says apache-2.0 | COCO, but the **backbone is MAE ImageNet-1k pretrain, and the MAE repo/weights are CC BY-NC 4.0** (verified facebookresearch/mae LICENSE). ImageNet terms are "non-commercial research and educational purposes" | ⚠️ (NC upstream pretrain) | Yes: `onnx-community/vitpose-base-simple`, `JunkyByte/easy_ViTPose` (no licence on that card) | S ~24M / 97 MB ONNX | S 73.8, B 75.8 | **[measured] ViTPose-S 67.5 ms per crop** (about 11× RTMPose-s) | Repo dated 2023; HF port 2025-01 |
| **ViTPose++ / ViTPose-B multi-dataset** | same; HF `usyd-community/vitpose-plus-*` | Apache-2.0 | HF apache-2.0 | COCO + **AIC + MPII** (+CrowdPose) (+AP-10K, APT-36K, **COCO-WholeBody**) | ❌/⚠️ | Yes (easy_ViTPose) | S–H | ++S 75.8, B 77.1 | slow on CPU | 2025-01 (HF) |
| **HRNet-W32 (SimpleBaseline/HRNet)** | github.com/leoxiaobin/deep-high-resolution-net.pytorch; HF `qualcomm/HRNetPose` | MIT (verified both) | Qualcomm AI Hub ONNX (MIT card) | COCO; ImageNet-pretrained backbone | ✅ (ImageNet-pretrain grey zone, see §6) | Yes (Qualcomm, opset 21, external `.data`) | 28.5M / 109 MB | ~74.4 (W32 256×192, paper; UNVERIFIED here) | **[measured] 38.2 ms per crop** | Repo 2019; Qualcomm build 2026-09 |
| **Lite-HRNet-18/30** | github.com/HRNet/Lite-HRNet; HF `qualcomm/LiteHRNet` | Apache-2.0 (verified) | Google Drive/OneDrive (repo); Qualcomm ONNX (apache-2.0 card) | COCO (paper reports training from scratch: UNVERIFIED) | ✅ (**fallback**) | Yes (Qualcomm, opset 21, outputs keypoints, scores, heatmaps) | 1.1–1.8M / 4.5 MB | 18: 64.8; 30: 67.2 (256×192); 30-384: 70.4 | **[measured] 18.5 ms per crop**: tiny but memory-bound, so slower than RTMPose-s | 2021; Qualcomm build 2026-09 |
| **SimCC** | github.com/leeyegy/SimCC (no LICENSE file found); integrated in mmpose (Apache-2.0) | UNVERIFIED (original); Apache-2.0 via mmpose | mmpose | COCO | ⚠️ for the original repo; use RTMPose (the SimCC head is built in) | via mmpose | — | — | — | 2022 |
| **PP-TinyPose** (+ PicoDet-Pedestrian) | github.com/PaddlePaddle/PaddleDetection configs/keypoint/tiny_pose | Apache-2.0 (verified) | bj.bcebos.com (Baidu), no separate licence | **COCO + AI Challenger** (verified README) | ⚠️ (AIC) | Via Paddle2ONNX (not shipped as ONNX); UNVERIFIED op compatibility | 128×96 and 256×192 | 58.1 / 68.8 | Snapdragon 865: 4.6 / 14.1 ms (official); x86 not published | paddledet 2.6.0 (2023-02); repo has low activity |
| **YOLOX-Pose t/s/m/l** one-stage | mmpose configs/body_2d_keypoint/yoloxpose | Apache-2.0 | .pth openmmlab | COCO only; init from mmdet YOLOX-s COCO (verified config) | ✅ (one-stage fallback) | Export via mmdeploy | — | t 52.6, s 64.1, m 69.5, l 71.2 | Not measured; expect ≥ RTMO-s | 2023 |
| **DEKR / HigherHRNet** (bottom-up) | github.com/HRNet/DEKR, HRNet/HigherHRNet-Human-Pose-Estimation | MIT (verified) | OneDrive / Google Drive | COCO / CrowdPose; ImageNet backbone | ✅ licence-wise, ❌ practically (heavy and slow, multi-scale) | Exportable; UNVERIFIED | 29M+ | ~67–71 | Slow on CPU | 2021 |
| **ED-Pose** | github.com/IDEA-Research/ED-Pose | **IDEA License 1.0: "solely for your non-commercial research purposes"** (verified) | — | COCO/CrowdPose/Human-Art | ❌ | — | — | ~71–75 | — | 2023 |
| **DETRPose-N/S/M/L/X** (2025, new) | github.com/SebastianJanampa/DETRPose | Apache-2.0 (verified) | GitHub releases + HF | COCO (and CrowdPose variants); HGNetv2 backbone (ImageNet pretrain via D-FINE lineage: UNVERIFIED) | ✅/⚠️ (licence OK; young single-author repo; ImageNet pretrain) | Yes: `tools/deployment/export_onnx.py` exists. Deformable attention likely needs `GridSample` (opset ≥16): UNVERIFIED | N 4.1M, S 11.5M, M 20.8M | N 57.2, S 67.0, M 69.4, L 72.5, X 73.3 | V100 TensorRT FP16: S 5.0 ms; CPU not published | Code 2025-06; paper v2 2026-07 |
| **Lightweight OpenPose** | github.com/Daniil-Osokin/lightweight-human-pose-estimation.pytorch | Apache-2.0 (verified) | Repo-linked checkpoint | COCO; MobileNetV1 ImageNet init | ✅ but obsolete | Yes (`scripts/convert_to_onnx.py`) | ~4M | **~40** (18-kp OpenPose layout) | Designed for CPU real time | Repo stale (no recent release) |
| **MoveNet Lightning/Thunder** | Kaggle `google/movenet`, tfjs-models (Apache-2.0) | Apache-2.0 | Model card: "Licensed Under Apache License, Version 2.0" | COCO (≤2-person images) + Google-internal "Active" (YouTube fitness) | ❌ **for us.** Single person, and the card says "**Any form of surveillance or identity recognition is explicitly out of scope**" | Community ONNX (`Xenova/movenet-singlepose-lightning`, input int32 [1,192,192,3]) | Lightning 9.4 MB ONNX | COCO single-person subset mAP ~65–67 (L) / ~77–79 (T) | >50 FPS laptop (card) | 2021 |
| **MediaPipe Pose / BlazePose GHUM (lite/full/heavy)** | github.com/google-ai-edge/mediapipe | Apache-2.0 (verified) | storage.googleapis.com TFLite; model card "Apache License, Version 2.0" | Google-internal smartphone images + GHUM fitting | ❌ **for us.** Card: out of scope = "Multiple people in an image" and "**Any form of surveillance … explicitly out of scope**" | No official ONNX (TFLite only; tf2onnx or PINTO conversions) | 33 landmarks | Not COCO-AP. PCK@0.2: heavy 97.2, lite 92.5 (own benchmark) | MacBook Pro 2017: 25–38 ms | mediapipe PyPI 1.0.1 (2026-08-14) |
| **Ultralytics YOLOv8/11/26-pose** | github.com/ultralytics/ultralytics | **AGPL-3.0** (verified LICENSE; PyPI 8.4.173 on 2026-10-04) | HF `Ultralytics/YOLO11`, `YOLO26`: agpl-3.0 | COCO | ❌ unless we buy the **Ultralytics Enterprise License** ("use … in proprietary … commercial products without AGPL-3.0 obligations"; pricing not public, UNVERIFIED) | Native export | YOLO26n-pose: 57.2 mAP, 40.3 ms CPU ONNX (LearnOpenCV, secondary source) | n–x | — | very active |
| **YOLO-NAS-Pose** | github.com/Deci-AI/super-gradients | Apache-2.0 code | **Deci YOLO-NAS licence: "you may not use the Software for any commercial use, including in connection with any models used in a production environment"** (verified LICENSE.YOLONAS.md) | COCO | ❌ | Yes | — | — | — | super-gradients 3.7.1 (2024-04); dormant |
| **OpenPifPaf** | github.com/openpifpaf/openpifpaf | **AGPLv3** ("contact EPFL-TTO for a commercial license", verified) | — | COCO/CrowdPose | ❌ | Yes | — | ~66–72 | — | 0.13.11 (2023-02) |
| **OpenPose (CMU)** | github.com/CMU-Perceptual-Computing-Lab/openpose | **"Academic or non-profit … non-commercial research use only"** (verified) | — | COCO/MPII | ❌ (commercial licence is paid via CMU) | — | — | — | — | stale |
| **AlphaPose** | github.com/MVIG-SJTU/AlphaPose | **Non-commercial research use only** (verified) | — | COCO/Halpe | ❌ | — | — | — | — | stale |
| **Sapiens (v1) pose 0.3b–2b** | github.com/facebookresearch/sapiens; HF `facebook/sapiens-pose-*` | **CC BY-NC 4.0** (verified) | HF cc-by-nc-4.0 | Meta Humans-300M + annotated 308 kp | ❌ | TorchScript | 0.3–2B params | — | GPU only, realistically | 2024-10 |
| **Sapiens2 pose 0.4b–5b** (2026-04) | github.com/facebookresearch/sapiens2 | **Sapiens2 License**: use "will not involve … (i) for purposes of surveillance … (ix) … the operation of critical infrastructure" (verified) | HF `facebook/sapiens2-pose-1b` | 1B human images | ❌ | — | 0.4–5B | — | GPU | 2026-06 |

Other things I checked:
- `qualcomm/RTMPose-Body2d` (apache-2.0 card, 2026-09) and `litert-community/RTMPose-s-LiteRT` (2026-09) are re-packagings of the same OpenMMLab weights. They inherit the same body7/AIC training-data issue. UNVERIFIED which checkpoint each one uses.
- No credible 2025–2026 "RT-DETR-pose" or "D-FINE-pose" release with permissive weights turned up other than DETRPose. **UNVERIFIED:** completeness of this scan.

### 1.1 ONNX and `onnxruntime-node` notes

- **RTMPose ONNX** (mmdeploy SDK zip): `end2end.onnx`, opset 11, dynamic batch, standard ops only [measured].
  - Input: `[N,3,256,192]` float with mean/std normalisation done outside the graph. Check `pipeline.json` in the zip for the exact mean/std and the BGR/RGB order.
  - Post-processing: per-keypoint `argmax` over `simcc_x` (length 384) and `simcc_y` (length 512). Divide by the split ratio 2.0, apply the inverse affine to the crop, and use the max value as confidence.
  - The zip also contains `deploy.json`, `pipeline.json` and `detail.json`, and ships a `.onnx` inside dated sub-folders.
  - Batching crops gives about a 1.4× throughput gain on CPU [measured: s 8 crops in 35 ms versus 8 × 6.2 ms].
- **RTMO ONNX**: opset 11 and includes `NonMaxSuppression` and `TopK`. Both are supported by the ORT CPU EP. Outputs are `dets [N,K,5]` and `keypoints [N,K,17,3]`. The input is a 640×640 letterbox.
- **Qualcomm AI Hub ONNX** (Lite-HRNet, HRNet): opset 21, weights in an external `.data` file. `onnxruntime-node` must load the model from a file path, not a buffer, so the `.data` file can be resolved.
- **Exporting from `.pth`** (the RTMO-COCO and YOLOX-Pose-COCO checkpoints, or our own fine-tunes): mmdeploy 1.x with mmcv 2.0.x, mmpose 1.3.x and torch ≤ 2.1. That stack is aging, so pin it in a Docker build image. rtmlib's author documents the same mmdeploy path.
  - Known export breakers in this family: mmcv custom ops (none in RTMPose/RTMO), dynamic-shape `Resize` (fine at opset 11), and deformable attention / `grid_sample` for DETR models (needs opset ≥ 16).
- **Keypoint format:** all ✅/⚠️ candidates output **COCO-17** (nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles). Halpe-26 variants add feet, head and neck, which would help "feet off ground" for climbing, but they are body7-trained (⚠️).

---

## 2. Recommendation

### Primary: RTMPose-s top-down (plus RTMPose-m on the GPU tier), with RTMO-s for crowded cameras

Why:
- **Best CPU accuracy per millisecond** of all the commercially plausible options.
  - RTMPose-s is 6 ms per crop on a 4-vCPU Xeon at AP 69.7–72 [measured].
  - ViTPose-S is 67 ms, Lite-HRNet-18 is 18.5 ms and HRNet-W32 is 38 ms.
  - Budget: 8 cores at about 5 fps per camera and 3 people per frame is roughly 0.1 core per camera. It is very feasible to run pose only on tracks inside fence or fall zones, or after a trigger.
- **Plugs straight into our pipeline:** YOLOX boxes go to an affine crop, then the ONNX model, then SimCC decode. It is an opset-11 model with no custom ops, and the ONNX is official.
- **Same family for crowds:** RTMO-s handles dense platforms without per-person cost growth. Its own docs say "RTMO runs faster than RTMPose on images with more than 4 persons", and it has CrowdPose AP 67–73.
- **Code licence clean** (Apache-2.0). rtmlib (Apache-2.0) is an actively maintained reference for the pre/post-processing; its v0.0.16 is from 2026-08.

**Licence-driven shipping plan (a human must approve; see §6):**
1. **Prototype now** with the body7 ONNX from rtmlib, for internal R&D and evaluation only.
2. **Ship v1** on one of these:
   - (a) **RTMO-s/m COCO checkpoints**, exported to ONNX. Lineage is COCO only.
   - (b) A **RTMPose-s/m we fine-tune on COCO plus our own licensed CCTV crops**, starting from the RTMO-COCO backbone or from scratch (a CSPNeXt ImageNet init carries the ImageNet-terms grey zone).
   - Re-training RTMPose-s takes about a day on 8 GPUs per the configs (420 epochs × 8×256 batch; for us ~1–3 days on 1–2 A100s, UNVERIFIED estimate). It also lets us add Indian CCTV conditions: overhead angles, IR night, saris and dhotis, crowds, people lying on platforms.
3. **Keep the body7 weights out of the shipped product** unless legal accepts the risk.

### Fallback

- **Lite-HRNet-30 (COCO, Apache-2.0)** top-down.
  - Ready-made Apache-2.0 ONNX from Qualcomm AI Hub (the Lite-HRNet-18-class build ran at 18.5 ms [measured]).
  - AP 64.8–67.2, which is lower but adequate for coarse body geometry such as torso angle and wrists above a line.
- **YOLOX-Pose-s/m (COCO, Apache-2.0)** as the one-stage fallback.
- If budget allows and AGPL obligations cannot be met, the **Ultralytics Enterprise License** for YOLO26-pose is a paid, legally clean alternative (pricing UNVERIFIED).

### Not recommended even though permissive

- **MoveNet / MediaPipe:** single-person, and their Google model cards explicitly put surveillance out of scope. Shipping them in a VMS contradicts the publisher's stated intended use. Not strictly a licence violation, but a reputational and contractual risk.
- **ViTPose:** about 10× slower on CPU, and its MAE pretrain is CC BY-NC.

---

## 3. Building the detections

### 3.1 Person down / fall / lying still

**Signals per track, smoothed over 0.3–0.5 s with an EMA, keypoints with confidence < 0.3 ignored:**

| Feature | Definition | Typical threshold (tune per site) |
|---|---|---|
| Torso angle θ | Angle between (mid-shoulder → mid-hip) and image vertical | Upright < 30°; down > 60° |
| Height-normalised drop | Δ(y of head or mid-hip) / H_ref within Δt, where H_ref is the track's median standing bbox height over its previous 3–5 s | > 0.4·H_ref within ≤ 1.0 s means "fall transition" |
| BBox aspect | w/h | > 1.0–1.3 (unreliable alone because of perspective) |
| Vertical keypoint spread | (max y − min y of keypoints) / H_ref | < 0.45 means lying |
| Head-vs-hip | Head y ≥ hip y (head at or below hips) | lying or collapsed |
| Immobility | Mean keypoint displacement / H_ref per second | < 0.02 for T_still |
| Ground contact | Bbox bottom inside a "floor" region; optional ground homography | — |

**State machine:** `UPRIGHT → TRANSITION (fast drop + θ rising) → DOWN (θ>60° or spread<0.45 for ≥2 s) → ALERT_FALL (DOWN and no recovery within T_confirm=5–10 s)`.

Add a separate `LYING_STILL` path: DOWN plus immobile for T_still = 30–120 s, with **no** observed transition. This covers medical emergencies and collapses already in progress when the track started. Raise it as a lower-severity "person lying motionless" alert.

**Recovery:** returning to UPRIGHT clears the alert. Optionally keep a "fall-and-recovered" event for audit.

**Railway-specific false-positive control (critical in India):**
- **People sleeping or lying on platforms, concourses and benches at night** are normal. Provide:
  - "lying allowed" zones and schedules;
  - require an **observed TRANSITION** for high-priority alerts, and allow `LYING_STILL` only in "no-lying" zones (platform edge strip, foot-over-bridge stairs, escalators, track bed, factory aisles);
  - suppression of known sleeping spots.
- **Sitting or squatting on the floor** (common: groups waiting, eating, vendors): θ stays < 45° and the head stays above the hips. Require head-at-or-below-hip *or* θ > 60°.
- **Bending, tying shoes, picking up luggage, namaz or prayer postures, porters loading:** short duration, so the immobility and confirm windows suppress them. Prayer postures can last minutes, so use zones and the VLM check.
- **Overhead or top-down cameras:** torso angle in the image is meaningless. Fall back to drop speed plus spread, or per-camera calibration (a "camera tilt" setting). Hikvision and Dahua require mounting-height calibration; Dahua: indoor ≥ 3 m, outdoor 5–10 m (search extract).
- **Track ID switches during a fall** (box shape changes abruptly): link the new track to the lost one by IoU and position before evaluating.
- **Occlusion by benches, luggage or crowds,** and **children or small far-away people** (H < ~60–80 px makes pose unreliable): fall back to bbox-only rules.
- **Mannequins, posters, people in screens:** require a motion history.
- **Optional second stage:** send a 2–4-frame snapshot strip to the llama.cpp VLM sidecar with a fixed yes/no prompt ("Is a person lying on the ground after falling / unconscious?") before paging an operator. Check the VLM's licence separately.

**Skeleton action classifiers (stage 2, optional):**

| Model | Code licence | Pretrained weights | Verdict |
|---|---|---|---|
| ST-GCN (yysijie/st-gcn) | BSD-2-Clause (verified) | Kinetics-skeleton / NTU | Code ✅; weights ❌ (NTU: "commercial usage … in any way or form" prohibited; Kinetics = YouTube) |
| PYSKL (ST-GCN++, PoseC3D, CTR-GCN impls) | Apache-2.0 (verified) | NTU / Kinetics / FineGYM | Code ✅; weights ❌ (data) |
| mmaction2 (ST-GCN, PoseC3D) | Apache-2.0 (verified); last PyPI 1.2.0 (2023-10) | NTU / Kinetics | Code ✅; weights ❌ |
| CTR-GCN (original) | **CC BY-NC 4.0** (verified) | NTU | ❌ |
| PP-Human fall (ST-GCN, PaddleDetection) | Apache-2.0 | Trained on **NTU RGB+D + UR Fall + business data**; reported "Precision 96.43" on their private test set | ❌ weights (data); good design reference: 50-frame window per track, COCO-17 input |
| taufeeque9/HumanFallDetection | MIT | Uses **OpenPifPaf (AGPL)** | ❌ |

Recommendation: rules first. Then train a tiny ST-GCN or 1D-temporal-CNN on keypoint sequences (about 50 frames × 17 × 3). It exports trivially to ONNX; PYSKL uses `einsum`, which needs opset ≥ 12 and is supported by ORT. Train on **our own staged and real data plus CC BY sources** (CAUCAFall, GMDCSA24 MIT, UP-Fall CC BY 4.0 (search extract), Simuletic synthetic CC BY 4.0). Use NC datasets (UR Fall, Le2i, OmniFall, OOPS) **only for internal benchmarking**, and only if legal agrees that internal evaluation is "non-commercial research". That is a grey area; see §6.

Clip classifiers (X3D, VideoMAE and similar) are heavier, need GPU, and their public fall weights are trained on the same NC data. Not recommended for CPU-first.

### 3.2 Fence / perimeter climbing

**How vendors define it (search extracts, primary docs blocked):**
- Hikvision Abnormal Event Detection Server manual: "**Climbing**: triggers an alarm when a person climbs over the height set". "Falling down: triggers when a person in the detection area falls down and does not stand up in the time set." The DeepinViewX marketing says "early identification of movement such as wall climbing".
- Chinese-market Hikvision and Dahua behaviour analytics list 攀高 ("climbing high") and 人员倒地 ("person down") as standard events.
- Uniview NVR824-IX: "up to 16 types of behavior analysis including climbing detection, falling detection".

So the industry abstraction is a **configured height line or "warning plane" on a fence or wall, crossed by a person's body**. We should copy it because operators already understand it.

**Our configuration per camera:**
1. Fence base polyline (ground contact).
2. Fence top polyline (height line).
3. Protected side ("inside").
4. Optional exclusion schedule for maintenance crews.

**Logic per track inside a band around the fence polygon:**
- **Approach:** bbox bottom within D px of the fence base, or overlapping the fence polygon.
- **Climb attempt** (any 2 of these, sustained ≥ 0.5–1 s):
  - both wrists above both shoulders **and** within the fence-top band;
  - ankle(s) lifted above the track's ground baseline (median ankle y over the previous 2 s) by > 0.15·H_ref, so the feet are off the ground;
  - upward hip velocity with low horizontal velocity;
  - knees above hips, or hip above the fence-top line.
- **Climbed over / breach:** hip or centroid crosses the top line, then the track appears on the protected side (side change), or the track is lost at the top and a new track appears inside within N s.
- **Alerts:** "Climb attempt" (early warning) and "Perimeter breached by climbing" (high).
- **Fallbacks:** when pose confidence is low (night IR, fence mesh occluding limbs, person < 80 px), use bbox-only: the bbox top crosses the height line while the bbox bottom leaves the ground baseline. That is what simpler NVRs do.
- **False positives:** people leaning on or holding the fence, waving across it, maintenance staff on ladders, people on stairs or embankments behind the fence (needs correct polygon depth), animals (detector class filter), and climbers on the *outside* who never cross (that may still be a valid "attempt" alert).
- **Prior work:**
  - Yu & Aggarwal, "Detection of Fence Climbing from Monocular Video" (star-skeleton + HMM).
  - An SVM activity-recognition paper.
  - "Detection of Fence Climbing Behavior in Surveillance Videos Using YOLO V4" (Springer 2023, F1 87% on 5,340 images; dataset not public, UNVERIFIED).
  - "Vision-Based Detection of Unsafe Worker Guardrail Climbing" (posture + segmentation fusion).
- **No public, commercially licensed fence-climb dataset was found.** Plan staged recordings at a customer or test perimeter: day, night and IR; chain-link, wall, railing; several camera heights.

---

## 4. Datasets and their licences

### 4.1 Pose training data (these determine weight-provenance risk)

| Dataset | Licence / terms | Commercial training? | Source |
|---|---|---|---|
| COCO 2017 keypoints | Annotations CC BY 4.0; images "must abide by the Flickr Terms of Use"; users "accept full responsibility" | ✅ industry-standard (residual Flickr image-copyright risk) | search extract of cocodataset.org/#termsofuse; COCO-WholeBody README repeats it |
| AI Challenger (HKD) | "only for the purposes of non-commercial scientific researches or academic teaching and will not use the dataset for any commercial purposes" | ❌ | search extract of challenger.ai/terms/data |
| CrowdPose | Academic, non-commercial research (search extract); no LICENSE file in the GitHub repo | ❌/⚠️ | search extract |
| MPII Human Pose | Simplified BSD for annotations, but "Commercial use is not allowed due to the fact that the authors do not have the copyright for the images" | ❌ | HF Voxel51 card (verified) |
| PoseTrack 2017/18 | "only for research purposes and it will be forbidden to use the dataset for training or evaluating commercial surveillance systems" | ❌ (explicitly targets us) | search extract (PoseTrack paper/site) |
| Halpe-FullBody | No dataset licence published (repo README has none); images from HICO-DET | ⚠️ unclear | verified README (no licence) |
| sub-JHMDB (HMDB51 videos) | Research | ❌/⚠️ | UNVERIFIED |
| OCHuman | API code MIT; dataset images UNVERIFIED | ⚠️ (eval only in body8) | verified OCHumanApi LICENSE |
| COCO-WholeBody | "ONLY for research and non-commercial use" | ❌ | verified README |
| Human-Art | Non-commercial authorisation form | ❌ (affects the `*_humanart` YOLOX/RTMPose weights) | verified README |
| ImageNet-1k (backbone pretraining) | "Researcher shall use the Database only for non-commercial research and educational purposes" | ⚠️ industry-wide grey zone for ImageNet-pretrained backbones | search extract of image-net.org/accessagreement |
| MAE ImageNet weights (ViTPose init) | CC BY-NC 4.0 | ❌/⚠️ | verified facebookresearch/mae LICENSE |

### 4.2 Fall / person-down datasets

| Dataset | Content | Licence | Commercial training | Commercial internal eval |
|---|---|---|---|---|
| **CAUCAFall** (Mendeley 10.17632/7w7fccy7ky.4) | 10 subjects, 5 fall + 5 ADL types, uncontrolled home | **CC BY 4.0** (search extract) | ✅ with attribution | ✅ |
| **GMDCSA-24** (github ekramalam/…) | 4 subjects, 81 falls / 79 ADL clips | **MIT** (search extract of the repo LICENSE) | ✅ (subjects' consent scope UNVERIFIED) | ✅ |
| **UP-Fall / HAR-UP** | 17 subjects, multimodal + 2 cameras | **CC BY 4.0** (search extract) | ✅ likely; confirm on the site | ✅ |
| **Simuletic CCTV Fall & Lying-Down** (HF/Kaggle/Roboflow) | Synthetic overhead-CCTV images, bbox + COCO-17 keypoints; free sample (226 files) | **CC BY 4.0** (verified HF card) | ✅ (synthetic, no real people); the full set is commercial from the vendor | ✅ |
| **UR Fall Detection** (Kwolek & Kepski) | 30 falls + 40 ADL, Kinect | **CC BY-NC-SA 4.0**, "contact the authors" for commercial use (search extract) | ❌ | ⚠️ research-only |
| **Le2i / ImViA Fall** | 4 rooms, ~190 videos | **CC BY-NC-SA** (DOI 10.25666/DATAUBFC-2024-04-09) (search extract) | ❌ | ⚠️ |
| **Multiple Cameras Fall (Montréal, MCFD)** | 24 scenarios × 8 cameras | No explicit licence found; research use | ❌/⚠️ UNVERIFIED | ⚠️ |
| **CMDFall** | 7 views, 50 subjects | UNVERIFIED (research) | ❌/⚠️ | ⚠️ |
| **EDF / OCCU** (Zenodo 15494102) | 2-view staged | UNVERIFIED (Zenodo blocked) | ⚠️ | ⚠️ |
| **OOPS!** (Columbia) | 20k YouTube "fail" videos; the OmniFall in-the-wild subset uses 818 | Code MIT; videos are third-party YouTube content | ❌ | ⚠️ |
| **OmniFall** (HF simplexsigil2/omnifall, 2025–26) | Unifies the 8 staged sets + OOPS + 12k Wan2.2 synthetic videos, 16 classes | Annotations **CC BY-NC-SA 4.0** (HF tag says cc-by-nc-4.0); the videos keep their original licences | ❌ | ⚠️; best benchmark if legal allows |
| **WanFall** (HF simplexsigil2/wanfall) | Synthetic (Wan 2.2) falls | CC BY-NC(-SA) 4.0 | ❌ | ⚠️ |
| **ud-smart-city / Unidata "Fall Detection 10,000 videos"** | Staged indoor and outdoor 1080p | Sample CC BY-NC-ND 4.0; full set is commercial (buy) | 💰 buyable | 💰 |
| **NTU RGB+D 60/120** (fall is class A43) | Kinect skeletons | Academic only; "commercial usage … in any way or form" prohibited | ❌ | ❌ |
| Roboflow Universe fall sets (many, e.g. "fall-detection-ca3o8", re-uploads of UR/Le2i/CAUCAFall) | Mixed | Per-project (often CC BY 4.0), but **many are re-uploads of NC datasets**, which does not launder the licence | ⚠️ check each upstream | ⚠️ |

**Climb datasets:** none public for fence or perimeter climbing. Sport-climbing sets (CIMI4D, "The Way Up" CVPRW 2025) and UCF101 "RockClimbingIndoor" are domain-mismatched and research-licensed.

---

## 5. Competitor notes

Most vendor pages were blocked in this sandbox, so these are search extracts and accuracy claims are **UNVERIFIED**.

| Vendor | Fall / person down | Climb | Stated accuracy |
|---|---|---|---|
| **Hikvision** | "Falling down: … person … falls down and does not stand up in the time set"; also "getting up", "sleep on duty". Radar-based fall sensors for care homes ("deep learning algorithm differentiates between sitting and lying") | "Climbing: … person climbs over the height set". DeepinViewX: "early identification of movement such as wall climbing" | DeepinViewX: "up to 90% reduction in false alarms" vs conventional AI cameras (lab) |
| **Dahua (WizMind)** | Fall detection via **stereo (dual-lens 3D) analysis cameras**; needs height and angle calibration | 攀高 (climb-height) detection listed in Chinese-market behaviour analysis (search extract) | none found |
| **Uniview** | NVR824-IX: "falling detection" among 16 behaviours | "climbing detection" | none found |
| **Avigilon (Motorola)** | No dedicated fall analytic found; Unusual Motion Detection | — | — |
| **Milestone XProtect partners** | CVEDIA-RT "Fallen Person Detection"; Vaidio fall detection; IntelliSee falls | (CVEDIA and Vaidio offer intrusion; climb UNVERIFIED) | none found |
| **Videonetics (India)** | "personnel collapse and fall detection" for industrial safety and transportation | UNVERIFIED | none |
| **Staqu JARVIS (India)** | "slip and fall detection"; hospital fall monitoring; deployed with 11 state police forces and 71 UP prisons | UNVERIFIED | none |
| **AllGoVision (India)** | Not found in search (UNVERIFIED; historically lists "man down" and "climbing" in brochures) | UNVERIFIED | — |
| **Vehant (India)** | OKEAN platform: object detection, intrusion, wrong way, crowd; fall not found | Not found | — |
| **Indian Railways VSS** (RailTel, Nirbhaya Fund) | Reports: VSS at 1,874 stations with AI intrusion and loitering analytics and FRS. One 2026-10 news item mentions "fallen-person detection" (organiser.org, blocked; UNVERIFIED) | Perimeter climbing is cited for railway perimeter protection generally | — |

Takeaway: the "height line" (climb) and "down for T seconds" (fall) configuration model is standard. Dahua's use of stereo cameras for fall shows that monocular fall detection is known to be FP-prone. Our differentiators: pose-based rules that work on existing cameras, railway-aware zones and schedules, and VLM verification.

---

## 6. Open risks and decisions for a human

1. **Weights provenance policy (legal decision, highest priority).** The OpenMMLab weights carry Apache-2.0, but their training data includes datasets that forbid commercial use, and PoseTrack specifically forbids commercial surveillance.
   - Decide whether VigilOne accepts "permissively licensed weights trained on NC data" (common industry practice, legally untested in India) or requires COCO-only or own-data lineage. Recommendation: the latter for shipped models.
   - Get Indian counsel's view on whether model weights are derivative works of training data under Indian copyright law and contract terms.
2. **COCO/Flickr and ImageNet residual risk.** Even "clean" options rely on COCO images (Flickr terms) and often on ImageNet pretraining (NC terms). The whole industry accepts this, YOLOX included. Document it in a model provenance register (model cards plus an SBOM-style record).
3. **Re-training budget:** GPU time plus data collection and annotation to produce COCO+own-data RTMPose/RTMO. An **mmdeploy/mmcv toolchain** that is aging (mmpose's last release was 2024-07) needs a pinned Docker build image. Alternatively, port the RTMPose head to a plain PyTorch training repo.
4. **Use of NC fall datasets for internal evaluation.** Is benchmarking a commercial product "non-commercial research"? Usually no. Legal should rule. If no, build an evaluation set from our own and CC BY data only.
5. **Fence-climb data:** there is no public dataset. Budget staged recordings and get actors' consent forms, which are also needed under India's DPDP Act 2023 for any customer footage used in training.
6. **Google model-card "surveillance out of scope" (MoveNet, BlazePose):** decide whether to treat this as binding policy. Recommendation: yes, do not use them.
7. **Ultralytics Enterprise:** decide whether a paid licence is worth it as a fallback; get a quote.
8. **Alert semantics in India:** sleeping on platforms is normal, so product decisions are needed on default zones and schedules, "lying still" severity, and operator workflow. Medical-emergency alerts carry liability: specify that they are assistive, not guaranteed.
9. **Accuracy claims:** no competitor publishes verifiable fall or climb accuracy. Set our own acceptance metrics, for example recall ≥ 90% on staged falls and ≤ 1 false alarm per camera per day on platform footage, measured on our own data.
10. **UNVERIFIED items to re-check with unrestricted internet:**
    - COCO terms page text (direct);
    - CrowdPose, AIC and PoseTrack terms pages (direct);
    - the Le2i, UP-Fall and MCFD licences;
    - Lite-HRNet "from scratch" training;
    - DETRPose ONNX ops;
    - which checkpoints the Qualcomm and LiteRT RTMPose builds use;
    - competitor datasheets.

---

## 7. Sources

### Licences and repos (fetched raw)
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/LICENSE (Apache-2.0)
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/projects/rtmpose/README.md (model zoo, body7 composition, latency, ONNX links)
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/projects/rtmo/README.md
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/configs/body_2d_keypoint/rtmpose/coco/rtmpose_coco.md
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/configs/body_2d_keypoint/rtmpose/coco/rtmpose-m_8xb256-420e_coco-256x192.py (AIC+COCO backbone init)
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/configs/body_2d_keypoint/rtmo/coco/rtmo-s_8xb32-600e_coco-640x640.py (YOLOX-COCO init)
- https://raw.githubusercontent.com/open-mmlab/mmpose/main/configs/body_2d_keypoint/yoloxpose/coco/yoloxpose_coco.md and the yoloxpose_s config
- https://raw.githubusercontent.com/open-mmlab/mmdetection/main/configs/yolox/yolox_s_8xb8-300e_coco.py
- https://raw.githubusercontent.com/Tau-J/rtmlib/main/LICENSE and README.md
- https://huggingface.co/Tau-J/RTMPose (apache-2.0 mirror, ONNX zips used for benchmarks)
- https://raw.githubusercontent.com/IDEA-Research/DWPose/main/LICENSE ; https://huggingface.co/yzd-v/DWPose
- https://raw.githubusercontent.com/ViTAE-Transformer/ViTPose/main/LICENSE and README.md
- https://raw.githubusercontent.com/facebookresearch/mae/main/LICENSE (CC BY-NC 4.0)
- https://huggingface.co/usyd-community/vitpose-base-simple ; https://huggingface.co/usyd-community/vitpose-plus-small ; https://huggingface.co/onnx-community/vitpose-base-simple ; https://huggingface.co/JunkyByte/easy_ViTPose
- https://raw.githubusercontent.com/ultralytics/ultralytics/main/LICENSE (AGPL-3.0); https://pypi.org/pypi/ultralytics/json ; https://huggingface.co/Ultralytics/YOLO26 ; https://www.ultralytics.com/license (search extract) ; https://learnopencv.com/yolo26-pose-estimation-tutorial/ (search extract)
- https://raw.githubusercontent.com/Deci-AI/super-gradients/master/LICENSE.md and LICENSE.YOLONAS.md
- https://raw.githubusercontent.com/openpifpaf/openpifpaf/main/LICENSE
- https://raw.githubusercontent.com/CMU-Perceptual-Computing-Lab/openpose/master/LICENSE
- https://raw.githubusercontent.com/MVIG-SJTU/AlphaPose/master/LICENSE
- https://raw.githubusercontent.com/facebookresearch/sapiens/main/LICENSE ; https://huggingface.co/facebook/sapiens-pose-0.3b
- https://raw.githubusercontent.com/facebookresearch/sapiens2/main/LICENSE.md and README.md ; https://huggingface.co/facebook/sapiens2-pose-1b
- https://raw.githubusercontent.com/IDEA-Research/ED-Pose/master/LICENSE
- https://raw.githubusercontent.com/SebastianJanampa/DETRPose/main/LICENSE and README.md ; https://arxiv.org/abs/2506.13027
- https://raw.githubusercontent.com/HRNet/Lite-HRNet/master/LICENSE and hrnet/README.md ; https://huggingface.co/qualcomm/LiteHRNet
- https://raw.githubusercontent.com/leoxiaobin/deep-high-resolution-net.pytorch/master/LICENSE ; https://huggingface.co/qualcomm/HRNetPose
- https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/litehrnet/releases/v0.63.0/litehrnet-onnx-float.zip and …/hrnet_pose/… (benchmarked)
- https://huggingface.co/qualcomm/RTMPose-Body2d ; https://huggingface.co/qualcomm/MediaPipe-Pose-Estimation
- https://raw.githubusercontent.com/HRNet/DEKR/main/LICENSE ; https://raw.githubusercontent.com/HRNet/HigherHRNet-Human-Pose-Estimation/master/LICENSE
- https://raw.githubusercontent.com/Daniil-Osokin/lightweight-human-pose-estimation.pytorch/master/LICENSE and README.md
- https://raw.githubusercontent.com/PaddlePaddle/PaddleDetection/master/LICENSE ; …/release/2.8/configs/keypoint/tiny_pose/README_en.md ; …/release/2.8/deploy/pipeline/docs/tutorials/pphuman_action_en.md
- https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/LICENSE ; …/docs/solutions/pose.md ; …/docs/solutions/models.md ; https://pypi.org/pypi/mediapipe/json
- https://storage.googleapis.com/mediapipe-assets/Model%20Card%20BlazePose%20GHUM%203D.pdf (fetched; text extracted)
- https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf (fetched; text extracted) ; https://huggingface.co/Xenova/movenet-singlepose-lightning ; https://huggingface.co/STMicroelectronics/movenet
- https://raw.githubusercontent.com/Megvii-BaseDetection/YOLOX/main/LICENSE
- https://raw.githubusercontent.com/open-mmlab/mmaction2/main/LICENSE ; https://raw.githubusercontent.com/kennymckormick/pyskl/main/LICENSE ; https://raw.githubusercontent.com/yysijie/st-gcn/master/LICENSE ; https://raw.githubusercontent.com/Uason-Chen/CTR-GCN/main/LICENSE ; https://raw.githubusercontent.com/PaddlePaddle/PaddleVideo/develop/LICENSE ; https://raw.githubusercontent.com/taufeeque9/HumanFallDetection/master/LICENSE
- https://raw.githubusercontent.com/PINTO0309/PINTO_model_zoo/main/LICENSE ; https://raw.githubusercontent.com/onnx/models/main/LICENSE
- PyPI release dates: https://pypi.org/pypi/{mmpose,rtmlib,ultralytics,mediapipe,super-gradients,openpifpaf,paddledet,mmaction2}/json

### Datasets
- https://raw.githubusercontent.com/jin-s13/COCO-WholeBody/master/README.md (COCO-WholeBody terms + COCO/Flickr statement)
- https://raw.githubusercontent.com/IDEA-Research/HumanArt/main/README.md
- https://raw.githubusercontent.com/liruilong940607/OCHumanApi/master/LICENSE
- https://github.com/Fang-Haoshu/Halpe-FullBody (README, no licence)
- https://github.com/cocodataset/cocoapi/issues/551 ; COCO terms (search extract; cocodataset.org blocked)
- https://huggingface.co/datasets/Voxel51/MPII_Human_Pose_Dataset (MPII terms)
- AI Challenger terms (search extract): https://arxiv.org/abs/1711.06475 ; challenger.ai/terms/data
- CrowdPose terms (search extract): https://hyper.ai/en/datasets/17619
- PoseTrack terms (search extract): https://openaccess.thecvf.com/content_cvpr_2018/papers/Andriluka_PoseTrack_A_Benchmark_CVPR_2018_paper.pdf ; https://pure.mpg.de/rest/items/item_3482791_2/component/file_3482792/content
- ImageNet terms (search extract): https://image-net.org/accessagreement
- NTU RGB+D (search extract): https://rose1.ntu.edu.sg/dataset/actionRecognition/
- https://huggingface.co/datasets/simplexsigil2/omnifall (card, component table, licence) ; https://arxiv.org/abs/2505.19889 ; https://huggingface.co/datasets/simplexsigil2/wanfall
- https://huggingface.co/datasets/Simuletic/CCTV_Incident_Dataset_Fall_Lying_Down_Detection
- https://huggingface.co/datasets/ud-smart-city/fall-detection
- UR Fall (search extract): https://fenix.ur.edu.pl/~mkepski/ds/uf.html
- Le2i (search extract): https://search-data.ubfc.fr/imvia/FR-13002091000019-2024-04-09_Fall-Detection-Dataset.html
- CAUCAFall (search extract): https://data.mendeley.com/datasets/7w7fccy7ky/4 ; https://www.researchgate.net/publication/363636390
- GMDCSA-24 (search extract): https://github.com/ekramalam/GMDCSA24-A-Dataset-for-Human-Fall-Detection-in-Videos
- UP-Fall (search extract): https://sites.google.com/up.edu.mx/har-up/ ; https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6539235/
- MCFD: https://www.iro.umontreal.ca/~labimage/Dataset/ (licence not found)
- OOPS: https://oops.cs.columbia.edu/ ; https://github.com/cvlab-columbia/oops

### Climb prior work
- http://cvrc.ece.utexas.edu/Publications/Detection_of_Fence_Climbing.pdf
- https://link.springer.com/chapter/10.1007/978-981-99-4725-6_51
- https://www.researchgate.net/publication/313585703_Detection_of_fence_climbing_using_activity_recognition_by_Support_Vector_Machine_classifier
- https://ouci.dntb.gov.ua/en/works/4zgXLxJl/ (guardrail climbing)
- https://openaccess.thecvf.com/content/CVPR2025W/CVSPORTS/papers/Maschek_The_Way_Up_A_Dataset_for_Hold_Usage_Detection_in_CVPRW_2025_paper.pdf ; https://arxiv.org/pdf/2303.17948

### Competitors (search extracts; most vendor domains blocked)
- https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000002/S000000014/S000000015/OFR003337/M000055473/User_Manual/UD28914B-A_Hikvision-Abnormal-Event-Detection-Server_User-Manual_V4.1.0_20230308-.pdf
- https://www.hikvision.com/en/newsroom/hiksnap/deepinviewx-cameras-with-a-large-vision-model/
- https://www.hikvision.com/europe/newsroom/blog/protecting-elderly-and-vulnerable-people-in-care-facilities-with-intelligent-radar-powered-fall-detection-technology/
- https://www.anfang.cn/zhishi/520150.html ; https://www.asmag.com.cn/test/201911/70692.html
- https://www.dahuasecurity.com/asset/upload/uploads/soft/20200506/Catalog_WizMind_V1.0_EN_202003-(28P).pdf ; https://www.securityinformed.com/news/dahua-technology-intelligent-cameras-safety-nursing-homes-co-4261-ga.1634030806.html ; https://blog.csdn.net/csdn_tom_168/article/details/148545401
- https://www.asadria.com/en/unv-smart-nvr-help-in-some-intelligent-applications/
- https://www.milestonesys.com/technology-partner-finder/cvedia/cvedia-rt-ai-analytics-plugin/ ; https://www.vaibs.com/en/news/milestone-xprotect-and-vaidio-a-unique-combination/ ; https://intellisee.com/partners/milestone-systems/
- https://www.videonetics.com/blog/modernizing-industrial-safety-harnessing-the-strength-of-ai-powered-data-driven-video-analytics-with-videonetics
- https://www.staqu.com/blog-government-video-analytics-railways-airports/ ; https://www.staqu.com/blog-hospital-video-analytics-patient-safety/
- https://www.vehant.com/
- https://www.railway-technology.com/news/indian-railways-railtel/ ; https://www.constructionworld.in/transport-infrastructure/metro-rail-and-railways-infrastructure/indian-railways-strengthens-telecom-and-ai-safety-systems/89768 ; https://organiser.org/2026/10/02/383935/bharat/indian-railways-decade-of-safety-tech-15-initiatives-from-kavach-4-0-to-ai-drones-and-predictive-track-monitoring/ (blocked; snippet only)

### Benchmark artefacts (local)
- benchmark scripts and downloaded ONNX files were kept in the research session's scratch space, not in the repo
