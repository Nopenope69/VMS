# VigilOne VMS — Open-Source AI/ML Catalog (23 Sept 2026)

Companion to `vigilone-ai-features-and-research-2026-09-23.md`. Goal: every open model/library/tool we could use to add AI/ML features to VigilOne, with licence checked. **"Verified" = I read the primary repo/model page this session. "Unverified" = from my own background knowledge; confirm on the model card before shipping.** Licence rule from your `THIRD_PARTY_LICENSES.md`: MIT / Apache-2.0 / BSD only inside the product; no AGPL/GPL/non-commercial.

## 0. Traffic-light summary

| Green (verified permissive) | Amber (check weights/data first) | Red (do not ship) |
|---|---|---|
| RF-DETR Nano-Large, RT-DETR, YOLOX, PP-YOLOE/PaddleDetection, RTMPose, Grounding DINO, SAM 2, Florence-2, SmolVLM2, Qwen3-VL, InternVL, MiniCPM-V (code), SigLIP, PaddleOCR, fast-alpr stack, torchreid, Roboflow trackers/supervision, Real-ESRGAN, Silent-Face-Anti-Spoofing, OpenCV Zoo (repo), Hailo Model Zoo, DL Streamer, Viseron, CVAT, Evidently | InsightFace weights (paid licence), MobileCLIP (Apple "amlr" licence, terms unclear), Moondream (BSL 1.1), NVIDIA DeepStream/TAO (free but proprietary), Llama-based VLMs (own licence), all public datasets | Ultralytics YOLO (AGPL), BoxMOT (AGPL), YOLOv9 official + YOLO-World (GPL-3.0), Jina CLIP v2 (CC BY-NC), OpenPose (non-commercial), CodeProject.AI Server (SSPL), OpenALPR (AGPL), SH17 / RWF-2000 / DriveIndia datasets (non-commercial) |

## 1. Feature-by-feature catalog

### 1.1 Object detection (person, vehicle, bike, animal, bag)
- **RF-DETR Nano/Small/Medium/Large** — Apache-2.0 (verified; XL/2XL are proprietary PML). 2.3-6.8 ms on T4 TensorRT. Ships as ONNX via `open-image-models`. First pick.
- **RT-DETR (v1/v2)** — Apache-2.0 (verified). RT-DETR-L 53.1 AP, 108 FPS on T4.
- **YOLOX** — Apache-2.0 (verified via Frigate/Savant/LibreYOLO sources). Frigate's Rockchip path already runs it; OpenCV Zoo ships a YOLOX ONNX. Best pick for NPU boards (Hailo, RKNN, Ambarella model gardens name it).
- **PP-YOLOE / PicoDet (PaddleDetection)** — Apache-2.0 (verified LICENSE). Lightweight 27 MB and 17 MB variants, 10 ms on Jetson AGX.
- **DAMO-YOLO, D-FINE, DEIM** — Apache-2.0 (per LibreYOLO/Savant articles; unverified on repos).
- **LibreYOLO** — MIT reimplementations of many YOLO families (verified via its own article; check each weight file).
- **OpenCV Zoo: NanoDet, YOLOX, MP-PersonDet** — repo Apache-2.0 (verified), but each model has its own licence.
- **Avoid:** Ultralytics YOLOv5/8/11/26/27 (AGPL), official YOLOv9 (GPL-3.0, verified) and YOLOv7 (GPL) — note Frigate downloads YOLOv9 weights for its users, which is fine for them but a licensing problem for a vendor embedding it in a sold appliance.

### 1.2 Tracking
- **Roboflow `trackers`** — Apache-2.0 (verified): SORT, ByteTrack, OC-SORT, BoT-SORT, C-BIoU; detector-agnostic. Preferred implementation.
- **ByteTrack / OC-SORT / BoT-SORT reference code** — MIT (per tracker article).
- **Norfair** (BSD-3, unverified), **supervision** (MIT, verified: zones, line counters, dwell time, heatmaps, speed).
- **Avoid: BoxMOT — AGPL-3.0 (verified)** even though it bundles the same algorithms.

### 1.3 Person/vehicle attributes and ready-made behaviour analytics
- **PaddleDetection PP-Human / PP-Vehicle** — Apache-2.0 (verified). One codebase gives: pedestrian tracking, in/out counting, 26 person attributes (gender, age, clothing, bag, hat; 2 ms/person), five behaviours (fall, fight, smoking, phone use, intrusion), ReID (1.5 ms/person), vehicle colour (10) and type (9), plate recognition incl. green EV plates, illegal parking, wrong-way and lane-pressing detection. Very close to what an Indian ITMS buyer asks for. Caveats: runs on PaddlePaddle; plan ONNX export (Paddle2ONNX) and re-validate accuracy. Its models are trained mainly on Chinese data — fine-tune on Indian footage.

### 1.4 Pose, fall, behaviour
- **RTMPose / MMPose** — Apache-2.0 (verified); 70-90 FPS on CPU per the pose-stack article. Recommended pipeline: person detector → RTMPose → ByteTrack → One-Euro smoothing → rules for fall/lying/loitering posture. RTMLib (lightweight ONNX runner for RTMPose) is, I believe, Apache-2.0 — unverified.
- **MediaPipe Pose** — permissive (verified via article), CPU-friendly, single person biased.
- **ViTPose** — permissive, highest accuracy, GPU only.
- **Avoid: OpenPose** — non-commercial (verified).
- **Violence/fight:** open VLMs are weak (82-86% on the easy binary RWF-2000 task, 27-35% on multi-class UCF-Crime). PP-Human's fight model or a pose-based rule is more practical. RWF-2000 data is research-only (verified), so train on your own footage.

### 1.5 Re-identification (cross-camera "find this person/vehicle")
- **torchreid / OSNet** — MIT (verified); exports to ONNX, OpenVINO, TFLite. Model is tiny.
- **FastReID** — Apache-2.0 (unverified).
- **PP-Human ReID** — see 1.3.
- Intel Open Model Zoo has person/vehicle ReID models — repo Apache-2.0 but **in maintenance mode** and each Intel model has its own licence file (verified). Read before use.
- **Data trap:** the common Re-ID training sets (Market-1501, Duke, MSMT) are research datasets and DukeMTMC was withdrawn; weights trained on them carry unclear commercial status. Treat "pretrained on Market-1501" weights as amber and plan to fine-tune on your own data.

### 1.6 Faces
- **Detect:** OpenCV Zoo **YuNet** (repo Apache-2.0, verified; check the model file licence), MediaPipe face detection (Apache-2.0, unverified). **SCRFD** ships in InsightFace: code MIT but **weights need a commercial licence** (verified).
- **Recognise:** OpenCV Zoo **SFace** (verified present; licence per model), FaceNet-class models (Frigate uses FaceNet small / ArcFace large, both trained on datasets of unclear commercial standing). Best legal path: buy the InsightFace commercial licence, or train ArcFace on data you have rights to.
- **CompreFace** (Exadel, Apache-2.0 per my knowledge, unverified — page fetch returned no licence): a ready REST face service, but depends on the same upstream model licences.
- **Liveness:** Silent-Face-Anti-Spoofing (Apache-2.0, verified) — but an independent test gave ACER 38%; no open-source model passes iBeta Level 1/2. Fine for low-threat access-control use, not for KYC.
- **DPDP:** default 1:N face search OFF per tenant; purge embeddings on schedule.

### 1.7 ANPR / OCR
- **fast-alpr** (MIT) = **open-image-models** plate detector (MIT, verified; six YOLOv9-based plate detectors, mAP50-95 0.61-0.77) + **fast-plate-ocr** (MIT, verified; XS model 0.47 ms/plate, CPU/OpenVINO/DirectML/Qualcomm, train-your-own supported). Note: those plate detectors are YOLOv9-architecture models released by the fast-alpr author under MIT — still confirm the training lineage since official YOLOv9 is GPL-3.0.
- **PaddleOCR (PP-OCRv5)** — Apache-2.0 (verified). 8 MB mobile model; export to ONNX. Video tips: run OCR only inside tracked plate crops every ~10th frame, confidence-weighted character voting (which your aggregator already does), 2x upsample small crops.
- **OpenCV Zoo:** LPD-YuNet plate detector, PPOCR-Det, CRNN recogniser (repo Apache-2.0).
- **Intel** license-plate-recognition-barrier (Open Model Zoo; Chinese-plate trained; own licence).
- **Indian data:** "Indian Licence Plate Dataset in the wild" (16k images, 4-point annotations; licence not stated), Roboflow Universe and HuggingFace Indian plate sets (licences vary). Expect to build your own two-line two-wheeler set.
- **Avoid:** OpenALPR (AGPL).

### 1.8 Open-vocabulary and promptable vision (no labelling needed)
- **Grounding DINO** — Apache-2.0 (verified): detect anything from a text prompt (zero-shot 48.4 AP on COCO). Heavy; use for **auto-labelling** and for on-demand "find a person in a red jacket" refinement, not per-frame on 64 cameras.
- **SAM 2 / 2.1** — Apache-2.0 (verified): video segmentation and tracking with memory; tiny variant 91 FPS on A100. Great for **annotation acceleration** (CVAT integrates SAM) and for redaction masks, not for continuous edge inference.
- **Florence-2** — MIT (verified), 0.77B: captioning, detection, OCR, grounding in one small model — a strong candidate for a **CPU-friendly captioner/tagger** that feeds text search.
- **YOLO-World** — GPL-3.0 (verified; authors invite commercial enquiries). Skip unless you get a licence.

### 1.9 Vision-language models (alert verification, summaries, chat)
- **Qwen3-VL 2B/4B/8B (GGUF for llama.cpp/Ollama)** — Apache-2.0 (verified on 4B page). Video, grounding, 32-language OCR, low-light/blur robust; 4B Q4_K_M is 2.5 GB.
- **SmolVLM2 256M / 500M / 2.2B** — Apache-2.0 (verified), video-capable, designed for edge; use the 256M-500M sizes on modest hardware.
- **InternVL 3.5 (1B-241B)** — MIT (verified).
- **MiniCPM-V 4.6 (1.3B) / MiniCPM-o 4.5 (9B)** — repo Apache-2.0 (verified); read each Hugging Face model card for extra terms.
- **Moondream 3** — BSL 1.1 with a no-third-party-service grant (verified): running it inside an appliance you sell is a grey zone → get their written OK or skip.
- **Llama 3.2 Vision / LLaVA** — Llama community licence (own terms, geographic restrictions on multimodal versions; unverified) — amber.
- **Reality check:** 4-8B open VLMs are unreliable for autonomous anomaly detection (27-35% on UCF-Crime). Use them only to **verify events your detector already raised** and to write the human-readable reason. Runtimes: llama.cpp (MIT), Ollama (MIT), vLLM (Apache-2.0) — background knowledge, unverified.

### 1.10 Semantic ("type what you're looking for") search
- **SigLIP (Apache-2.0, verified) / SigLIP 2 (Base 86M, Large 303M; multilingual, dense features; I believe Apache-2.0 — confirm on the model card).** Embed one crop or thumbnail per tracked object; top choice.
- **OpenCLIP** (MIT code; weights differ per checkpoint — check `PRETRAINED.md`).
- **Jina CLIP v2 — CC BY-NC 4.0 (verified)**: this is what Frigate's docs recommend for its users, but it is **non-commercial for a vendor**; commercial use needs a Jina licence. Do not copy that part of Frigate's recipe.
- **MobileCLIP** — Apple "amlr" licence; terms not confirmed → treat as not commercial-safe until read.
- **Store/search:** pgvector (open source; HNSW and IVFFlat; up to 16,000 dims; verified page but licence file not read — it is the PostgreSQL licence to my knowledge), so no new database needed. Qdrant (Apache-2.0, unverified) if you outgrow it.
- **Language:** SigLIP 2's multilingual text tower helps Hindi/regional-language queries — test it.

### 1.11 Audio analytics
- **YAMNet** — 521 AudioSet classes, MobileNetV1-based, 16 kHz mono (verified); Apache-2.0 code/model to my knowledge (unverified). Check the class map for gunshot/scream/glass-break/siren before promising them. **PANNs, BEATs** — alternatives (licences unverified).
- **Whisper / faster-whisper / whisper.cpp / Silero VAD** — MIT (unverified) for intercom, panic-button, or audio-note transcription. Privacy: audio recording law is stricter than video; keep it opt-in.
- Only worthwhile if your camera streams actually carry audio.

### 1.12 Image enhancement (evidence-safe)
- **Real-ESRGAN** — BSD-3-Clause (verified) for plate/face crops. **Never overwrite masters**; store the enhanced derivative linked to the original hash (your evidence model already supports this). Courts treat generative super-resolution as opinion, not fact — label it and log model version.
- Classical alternatives (CLAHE, Wiener deblur, temporal denoise) are simpler to defend in court.

### 1.13 Fire, smoke, PPE, crowd
- **Fire/smoke:** D-Fire (21k images, 26.5k boxes, YOLO format; licence unclear in the repo, verified) and Roboflow/HuggingFace sets (licences vary). Train an RF-DETR/YOLOX head; expect false positives from lights and steam — pair with temporal voting and thermal cameras where available.
- **PPE/helmet:** SH17 (8,099 images, 17 classes) is **CC BY-NC-SA 4.0 (verified)** despite the page calling it usable for commercial purposes → not safe. Build your own with SAM-assisted labelling.
- **Crowd counting:** for sparse scenes just count detector boxes with `supervision` zones; for dense crowds use density-map models such as P2PNet or DM-Count (licences unverified — check before use).

### 1.14 Camera health and tamper detection (high value, low ML)
- Classical: scene-change ratio, Laplacian variance (focus loss), histogram/brightness collapse (lens covered/spray-painted), edge-density drop, frozen-frame detection via frame hashing, redirect detection via feature matching against a reference (OpenCV, Apache-2.0). Literature survey: [arXiv 2310.07886]. Your scene-change probe already produces most inputs.
- Add day/night, low-light, and "image quality score" alarms. Cheap, reliable, and customers value them more than exotic AI.
- Telemetry anomaly detection (disk SMART, bitrate drift, reconnect storms) with simple statistics or isolation forest.

## 2. Runtimes, serving, pipelines
- **ONNX Runtime** (MIT, unverified) — one runtime for CPU/CUDA/OpenVINO/DirectML/QNN; what fast-alpr and open-image-models already use.
- **OpenVINO** (Apache-2.0) — Intel CPU/iGPU/NPU. **Intel DL Streamer** — MIT (verified), GStreamer plugins `gvadetect/gvaclassify/gvatrack` + OCR + plate recognition, Core Ultra 1-3 / Arc, active (908 commits). Good "no extra hardware" appliance path.
- **Roboflow Inference** — Apache-2.0 core (verified; models keep their own licences): RTSP pipelines, workflows, CLIP/SAM2/Florence-2 blocks, offline mode, Jetson/Pi.
- **Savant** — Apache-2.0 (verified) DeepStream wrapper for NVIDIA GPUs/Jetson; dynamic camera add/remove, Prometheus/OpenTelemetry. **NVIDIA DeepStream and TAO models** are free but under NVIDIA licences (unverified) — read before bundling.
- **Triton Inference Server** (BSD-3 to my knowledge, unverified) for multi-model GPU serving; **OpenVINO Model Server** for Intel.
- **Hailo Model Zoo** — MIT (verified) but the Dataflow Compiler/HailoRT need a Hailo developer account (gated). **RKNN Model Zoo** — public, binary compiler. Compiled `.hef`/`.rknn` are chip- and toolchain-specific.
- **Whole-system references:** Frigate (MIT), Viseron (MIT, verified: object/face/LPR/audio, Coral/CUDA), OpenNVR (AGPL, architecture ideas only — AI Adapter Contract, SHA-256 model fingerprints, correlation IDs), Kerberos Agent (unverified). **Avoid embedding CodeProject.AI Server: SSPL (verified)**; DOODS2 (unverified) is a lighter TensorFlow detector API.

## 3. MLOps and data tooling
- **CVAT** — MIT (verified): video tracks with interpolation, SAM interactor, plug-in detectors, fully self-hosted. **FiftyOne** and **Label Studio** — Apache-2.0 (unverified) for dataset curation, mistake finding, active learning.
- **Evidently** — Apache-2.0 (verified): PSI and 20+ drift tests, but its documented focus is tabular/text; for vision drift feed it embedding statistics or detection-rate/confidence histograms you compute yourself.
- Track per model: SHA-256, licence, training data, version, per-site precision/recall; log all of it in the audit chain (OpenNVR's fingerprinting idea).

## 4. Datasets minefield
| Dataset | Use | Status |
|---|---|---|
| COCO | detection pretrain | Annotations CC BY 4.0, **images carry mixed Flickr licences** (verified) — an academic study found none of COCO/ImageNet/Cityscapes/FFHQ/VGGFace2 explicitly permits commercial model deployment (verified) |
| DriveIndia (67k images, 24 Indian classes incl. auto-rickshaw) | Indian traffic | "academic and non-commercial research" (verified) |
| IDD (10k images, 34 classes) | Indian roads | terms not visible on site; ask IIIT-H |
| Indian Licence Plate Dataset | ANPR | licence not stated |
| SH17 | PPE | CC BY-NC-SA (verified) |
| RWF-2000 | fights | research only, no commercial use (verified) |
| D-Fire | fire/smoke | licence unclear |
| Market-1501 etc. | Re-ID | research datasets; not verified |

**Practical answer:** use open datasets for *research and benchmarking*, and build a proprietary training set from opt-in customer footage (contract + DPDP notice) — that is also your moat.

## 5. Suggested bill of materials by phase
1. **Detect + track:** RF-DETR Small (or YOLOX-S for NPUs) → ONNX Runtime/OpenVINO; Roboflow `trackers` ByteTrack; `supervision` for zones/lines (validate your spatial engine against it).
2. **Camera health:** classical tamper/blur/freeze checks (OpenCV).
3. **ANPR:** open-image-models plate detector + fast-plate-ocr fine-tuned on Indian plates (PaddleOCR as fallback); your aggregator on top.
4. **Attributes/behaviours:** PP-Human/PP-Vehicle modules (fall, fight, wrong-way, illegal parking, colour/type), exported to ONNX and re-benchmarked on Indian footage; RTMPose for a pose-based fall rule.
5. **Search:** SigLIP 2 crop embeddings in pgvector + Florence-2 or SmolVLM2 captions.
6. **Verification/summaries:** Qwen3-VL 4B (or SmolVLM2) via llama.cpp on flagged events only.
7. **Privacy/redaction:** YuNet + plate detector → SAM 2 or box masks → real ffmpeg redaction (fix the fake job first).
8. **Face module (optional, off by default):** licensed InsightFace or self-trained ArcFace + Silent-Face liveness for access control.
9. **Tooling:** CVAT + FiftyOne loop; Evidently on detection statistics; model registry with licence + hash.

## 6. Caveats
- Verified items = I read the repo/model page or licence file this session. Anything marked unverified needs a check.
- Several pages returned partial content (SigLIP 2, CompreFace, MobileCLIP terms, pgvector licence, IDD terms); I flagged those instead of guessing.
- Latency/accuracy numbers come from project pages and third-party articles, not from tests on your hardware or Indian footage.
- Not legal advice; have counsel review AGPL/GPL/BSL/NC decisions and the InsightFace and Moondream licences before you commit.

## Sources
[RF-DETR](https://github.com/roboflow/rf-detr) · [RT-DETR licence](https://playground.roboflow.com/models/baidu/rt-detr) · [PaddleDetection pipeline](https://github.com/PaddlePaddle/PaddleDetection/blob/release/2.9/deploy/pipeline/README_en.md) · [PaddleDetection LICENSE](https://raw.githubusercontent.com/PaddlePaddle/PaddleDetection/release/2.9/LICENSE) · [Roboflow trackers](https://github.com/roboflow/trackers) · [BoxMOT (AGPL)](https://github.com/mikel-brostrom/boxmot) · [supervision](https://github.com/roboflow/supervision) · [Pose stack article](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/openpose-mediapipe-rtmpose-pose-tracking) · [torchreid](https://github.com/KaiyangZhou/deep-person-reid) · [Open Model Zoo](https://github.com/openvinotoolkit/open_model_zoo) · [OpenCV Zoo](https://github.com/opencv/opencv_zoo) · [InsightFace licensing](https://www.insightface.ai/solutions/face-recognition-licensing) · [Silent-Face-Anti-Spoofing licence](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/blob/master/LICENSE) · [Liveness models compared](https://axonlab.ai/best-open-source-face-liveness-detection-models/) · [open-image-models](https://github.com/ankandrew/open-image-models) · [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) · [PaddleOCR for video](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/paddleocr-text-detection-video) · [Grounding DINO](https://github.com/IDEA-Research/GroundingDINO) · [SAM 2](https://github.com/facebookresearch/sam2) · [Florence-2](https://huggingface.co/microsoft/Florence-2-large) · [YOLO-World (GPL-3.0)](https://github.com/AILab-CVC/YOLO-World) · [YOLOv9 (GPL-3.0)](https://github.com/WongKinYiu/yolov9) · [Qwen3-VL 4B GGUF](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF) · [SmolVLM2](https://playground.roboflow.com/models/hugging-face/smolvlm2) · [InternVL](https://github.com/OpenGVLab/InternVL) · [MiniCPM-V](https://github.com/OpenBMB/MiniCPM-V) · [Moondream](https://docs.moondream.ai/) · [SigLIP licence](https://playground.roboflow.com/models/google/siglip) · [SigLIP 2](https://huggingface.co/blog/siglip2) · [Jina CLIP v2 (CC BY-NC)](https://huggingface.co/jinaai/jina-clip-v2) · [MobileCLIP amlr licence](https://huggingface.co/apple/mobileclip2_coca_dfn2b_s13b_context77/blob/main/README.md) · [pgvector](https://github.com/pgvector/pgvector) · [YAMNet](https://www.tensorflow.org/hub/tutorials/yamnet) · [Real-ESRGAN licence](https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE) · [Camera tamper survey](https://arxiv.org/html/2310.07886v1) · [D-Fire](https://github.com/gaia-solutions-on-demand/DFireDataset) · [SH17](https://arxiv.org/html/2407.04590v1) · [RWF-2000](https://github.com/mchengny/RWF2000-Video-Database-for-Violence-Detection) · [DriveIndia](https://arxiv.org/html/2507.19912v4) · [IDD](https://idd.insaan.iiit.ac.in/) · [Dataset licence study](https://arxiv.org/pdf/2111.02374) · [COCO commercial-use issue](https://github.com/cocodataset/cocoapi/issues/551) · [Intel DL Streamer](https://github.com/dlstreamer/dlstreamer) · [Roboflow Inference](https://github.com/roboflow/inference) · [Savant](https://github.com/insight-platform/savant) · [Hailo Model Zoo](https://github.com/hailo-ai/hailo_model_zoo) · [Viseron](https://github.com/roflcoopter/viseron) · [OpenNVR](https://github.com/open-nvr/open-nvr) · [CodeProject.AI (SSPL)](https://github.com/codeproject/CodeProject.AI-Server) · [CVAT](https://github.com/cvat-ai/cvat) · [Evidently](https://github.com/evidentlyai/evidently) · [Vision-LLMs in surveillance](https://arxiv.org/html/2510.23190)
