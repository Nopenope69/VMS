# VigilOne: open-model research beyond the current stack

Research date: 2026-10-05. Scope: on-prem, CPU-first (x86, 4–8 cores), optional NVIDIA GPU; runtimes onnxruntime-node (ONNX) and llama.cpp (GGUF). VigilOne is a paid commercial product, so GPL/AGPL, non-commercial, research-only and unclear licences are rejected.

**How licences were checked.** LICENSE files were pulled directly from `raw.githubusercontent.com`. Hugging Face licence fields come from `huggingface.co/api/models/<id>` (`cardData.license`) and the model-card README. github.com HTML, arxiv.org, ai.google.dev, zenodo.org, moondream.ai and idd.insaan.iiit.ac.in were blocked by the egress proxy. Facts that rest only on web-search snippets or on memory are marked **UNVERIFIED**.

**CPU numbers marked "measured"** come from onnxruntime 1.30 (Python) on this sandbox: a 4-core Intel Xeon @ 2.1 GHz, `intra_op_num_threads=4`, batch 1, random input, median of 15 runs after 3 warm-ups, FP32. These are rough, comparative numbers only. A customer's 8-core desktop CPU will be faster.

Verdict key: ✅ commercial use OK · ⚠️ usable with a caveat or human decision · ❌ do not ship.

---

## 0. Headline findings (the surprises)

1. **DEIMv2 changed licence in 2026 and is now non-commercial.** Its LICENSE.md reads "Copyright (c) 2026 … licensed … solely for Non-Commercial Purposes … Commercial Use … requires a separate commercial license". The same lab's **EdgeCrafter** (ECDet) uses the same non-commercial licence. DEIM v1 is still Apache-2.0. ❌ DEIMv2/EdgeCrafter.
2. **Gemma 4 (released 2026-04) is Apache-2.0**, not under the Gemma Terms. The HF card says `license: apache-2.0`, "License: Apache 2.0". It comes in E2B, E4B, 12B, 26B-A4B and 31B, and ggml-org publishes GGUFs, so llama.cpp supports it. This makes it a strong VLM/LLM candidate. Gemma 3 and 3n are still under the Gemma Terms (gated "manual").
3. **Qwen3.5 (2026-02) small models (0.8B/2B/4B/9B) are Apache-2.0 and natively multimodal** (`Qwen3_5ForConditionalGeneration`, pipeline `image-text-to-text`, 201 languages). One model could replace both SmolVLM2-2.2B and Qwen3-4B. GGUFs exist (ggml-org/Qwen3.5-0.8B-GGUF, unsloth/Qwen3.5-2B/4B-GGUF).
4. **PP-OCRv6 (2026-06, Apache-2.0, official ONNX)** is a drop-in upgrade for the PP-OCRv4 detector. Measured: PP-OCRv6_tiny_det **18.4 ms** vs PP-OCRv4 det **39.5 ms** at 640². The vendor reports detection Hmean 80.6 (tiny), 84.1 (small) and 86.2 (medium), against 75.2 for PP-OCRv5_mobile.
5. **UVH-26 (IISc AIM, Bengaluru Safe-City CCTV)**: 26,646 images, 1.8M boxes, 14 Indian vehicle classes. The dataset is **CC BY 4.0** and the models are labelled **Apache-2.0**. The RT-DETRv2-S and DAMO-YOLO-T weights are commercially clean. The YOLOv11 weights in the same repo are Ultralytics-trained, so treat them as AGPL ❌.
6. **RF-DETR is much slower on CPU than its T4 numbers suggest.** Measured: RF-DETR-N (384²) **95 ms**, D-FINE-N (640²) **48 ms**, D-FINE-N (416²) **28 ms**, YOLOX-tiny (416²) **18 ms**, YOLOX-nano **7 ms**. On CPU, **D-FINE-N/S is the better upgrade**. Keep RF-DETR for the GPU tier. RF-DETR XL/2XL are under "PML 1.0" (not Apache) ❌.
7. **Llama 3.2 Acceptable Use Policy** forbids use related to "Operation of critical infrastructure, transportation technologies" (item 11) and "espionage". That is a direct problem for railway and smart-city tenders ❌ (or ⚠️ with legal sign-off). Prefer Apache models.
8. **Most ReID and attribute weights inherit research-only data.** Market-1501, MSMT17 and LUPerson are research-only, and DukeMTMC was withdrawn. PA-100K is a notable exception (CC BY 4.0 on the official repo).
9. **MobileCLIP / MobileCLIP2 weights are research-only** ("Apple Machine Learning Research Model … Research Purposes … does not include … use in any commercial product") ❌. **Meta PE-Core is Apache-2.0** ✅.
10. **Moondream 3/3.1** uses the "Moondream Model License" (BSL-style; paid products that compete or embed the weights are excluded, per search, UNVERIFIED in detail). Moondream 2 is Apache. LFM2/2.5 (Liquid) is free only below US$10M annual revenue ⚠️. Krutrim models need a separate commercial licence ❌. Sarvam-Translate is GPL-3.0 ❌.

---

## 1. Object detectors (vs current YOLOX nano/tiny/s)

Baseline (YOLOX README): YOLOX-s 40.5 AP, 9.0M params, 26.8 GFLOPs (640). YOLOX-tiny 32.8 / nano 25.8 AP (README values for tiny and nano are from memory, UNVERIFIED; the s/m/l/x rows were fetched).

| Model | Repo | Code licence | Weights licence | Training data | Verdict | ONNX | Size | COCO AP (val) | CPU cost (measured, 4c) | Last release |
|---|---|---|---|---|---|---|---|---|---|---|
| **D-FINE-N / S / M** | Peterande/D-FINE | Apache-2.0 | Apache-2.0 | COCO (+Obj365 variants) | ✅ COCO images are under Flickr licences (as with YOLOX). Obj365 variants: Objects365 terms (research) ⚠️ | ✅ onnx-community/dfine_*_coco-ONNX | N 3.8M, S 10.2M | N 42.7–42.8, S 50.6, M 55.0 (RF-DETR SAB table) | N: **28 ms @416**, 35 ms @512, 48 ms @640; S: 101 ms @640. INT8 dynamic quant was *slower* (171 ms), so use FP32/FP16 or static QDQ | 2024-11 (N); repo active |
| **RF-DETR N/S/M (L)** | roboflow/rf-detr | Apache-2.0 | Apache-2.0 for N–L; **XL/2XL under PML 1.0 ❌** | COCO; DINOv2 backbone (Apache) | ✅ (N–L only) | ✅ onnx-community/rfdetr_*-ONNX | N 30.5M (384²), S 32.1M (512²), M 33.7M | N 48.4, S 53.0, M 54.7, L 56.5 | N: **95 ms**; S: 158 ms; N int8 73 ms. GPU T4: 2.3 / 3.5 / 4.4 ms | rfdetr 1.11.2 on PyPI, 2026-10-04 |
| RT-DETRv2-S (r18) | lyuwenyu/RT-DETR | Apache-2.0 | Apache-2.0 | COCO / O365 | ✅ | ✅ onnx-community/rtdetr_v2_r18vd-ONNX | 20M | 48.1 | 155 ms @640 | 2024-11 |
| RT-DETRv4-S/M | RT-DETRs/RT-DETRv4 | Apache-2.0 | Apache-2.0 (labelled) | COCO; **distilled from a DINOv3 ViT-B teacher** | ⚠️ DINOv3 License forbids "military … espionage" end uses and requires derivatives to stay under its terms; whether distilled weights count as derivatives is a legal question | export needed | S ≈ D-FINE-S | S 49.8, M 53.7 | ≈ D-FINE-S (UNVERIFIED) | 2025-11 |
| LW-DETR T/S | Atten4Vis/LW-DETR | Apache-2.0 | Apache-2.0 | COCO (+O365 pretrain) | ✅ | export | T 12.1M | T 42.9, S 48.0 | not measured | 2024 |
| DEIM (v1) D-FINE-N/S | Intellindust-AI-Lab/DEIM | Apache-2.0 | Apache-2.0 | COCO | ✅ (v1 only) | export (D-FINE graph) | N 4M | N 43.0, S 49.0 | ≈ D-FINE-N | 2025 |
| **DEIMv2** (Atto…X) | Intellindust-AI-Lab/DEIMv2 | **DEIMv2 License 2026, non-commercial** | same | COCO; DINOv3 backbones | ❌ | – | Pico 1.5M … | Pico 38.5, N 43.0, S 50.9 | – | relicensed 2026 |
| **EdgeCrafter (ECDet)** | Intellindust-AI-Lab/EdgeCrafter | **EdgeCrafter License, non-commercial** | same | COCO | ❌ | – | S 10M | S 51.7 | – | 2026-03 |
| PP-YOLOE+ / PP-YOLOE-s | PaddlePaddle/PaddleDetection | Apache-2.0 | Apache-2.0 | COCO / O365 | ✅ | via paddle2onnx | s ≈ 7.9M | s 43.7 (UNVERIFIED) | not measured | maintenance |
| DAMO-YOLO-T/S | tinyvision/DAMO-YOLO | Apache-2.0 | Apache-2.0 | COCO | ✅ | ✅ (repo exports) | T 8.5M | T 42.0, S 46.0 (UNVERIFIED) | not measured | 2023 |
| YOLOv9 (WongKinYiu) | WongKinYiu/yolov9 | **GPL-3.0** | GPL | COCO | ❌ | | | | | |
| YOLO (MIT re-impl. v7/v9) | MultimediaTechLab/YOLO | MIT | MIT (their own training, UNVERIFIED) | COCO | ⚠️ immature; check weight provenance | ✅ | | | | |
| YOLOv10 | THU-MIG/yolov10 | **AGPL-3.0** | AGPL | COCO | ❌ | | | | | |
| YOLOv12 | sunsmarterjie/yolov12 | **AGPL-3.0** | AGPL | COCO | ❌ | | | | | |
| YOLO11 / YOLO26 | Ultralytics | **AGPL-3.0** (per RF-DETR table) | AGPL | COCO | ❌ | | | YOLO26-N 40.3, S 47.7 | | |
| Gold-YOLO | huawei-noah/Efficient-Computing | no LICENSE file found at repo root | – | COCO | ❌ unclear (UNVERIFIED; may be GPL like YOLOv6) | | | | | |

**Recommendation.** For the CPU tier, use **D-FINE-N at 416–512 (≈28–35 ms, 42.8 AP)** to replace YOLOX-tiny (≈18 ms, ~33 AP). It gives about +10 AP for roughly 1.6–2× the cost, is NMS-free, and is Apache. D-FINE-S (50.6 AP, ~100 ms) suits keyframe or "verify" passes. Keep RF-DETR-S/M for the NVIDIA tier. Keep YOLOX-nano for very-low-end boxes and motion-gated pre-filtering. For Indian traffic, fine-tune on **UVH-26** (§3).

---

## 2. Trackers and re-identification

### 2a. Multi-object trackers (single camera)

| Tracker | Repo | Licence | Verdict | Notes |
|---|---|---|---|---|
| **ByteTrack** | ifzhang/ByteTrack (also FoundationVision/ByteTrack) | MIT | ✅ | No model: pure Kalman + Hungarian. Easy to port to TypeScript |
| **OC-SORT** | noahcao/OC_SORT | MIT | ✅ | Better occlusion recovery. In roboflow/trackers: HOTA 61.9 vs ByteTrack 60.1 vs SORT 58.4 |
| BoT-SORT | NirAharon/BoT-SORT | MIT | ✅ | Adds camera-motion compensation (useful for PTZ) and optional ReID |
| Deep OC-SORT | GerardMaggiolino/Deep-OC-SORT | MIT | ✅ code; ReID weights ⚠️ (see 2b) | |
| roboflow/trackers | roboflow/trackers | Apache-2.0 | ✅ | Clean Python reference for SORT, ByteTrack and OC-SORT |
| StrongSORT | dyhBUPT/StrongSORT | **GPL-3.0** | ❌ | |
| **BoxMOT** | mikel-brostrom/boxmot | **AGPL-3.0** | ❌ | Do not vendor. Re-implement from the MIT originals |

### 2b. Person ReID (cross-camera)

| Model | Repo | Code | Weights / data | Verdict | ONNX | Size / metric | CPU |
|---|---|---|---|---|---|---|---|
| OSNet (torchreid) | KaiyangZhou/deep-person-reid | MIT | Model-zoo weights trained on Market-1501 / DukeMTMC / MSMT17 | ⚠️ code OK, **pretrained weights inherit research-only data** | ✅ (export) | OSNet-x0.25 0.2M … x1.0 2.2M | ~1–3 ms per crop (UNVERIFIED) |
| OpenVINO OMZ person-reidentification-retail-0277 / 0288 | openvinotoolkit/open_model_zoo | Apache-2.0 (repo); Intel ML principles clause: must not "cause or contribute to a violation of an internationally recognized human right" | Training data **not disclosed** (evaluated on Market-1501) | ⚠️ best available "vendor-licensed" option. Ask Intel/legal about data provenance. OMZ is in **maintenance mode** | IR → ONNX convertible | 0277: 2.1M params, 2.0 GFLOPs, Market R1 96.2 / mAP 87.7; 0288: 0.18M, 0.17 GFLOPs, R1 86.1 | very cheap |
| PP-Human MTMCT ReID | PaddleDetection | Apache-2.0 | "trained on open-source datasets" (unspecified) | ⚠️ data unclear | paddle2onnx | 128-d | cheap |
| CLIP-ReID | Syliz517/CLIP-ReID | MIT | OpenAI CLIP backbone (MIT) + Market/MSMT/Duke fine-tune | ⚠️ data | export | ViT-B/16 | heavy for CPU |
| SOLIDER / SOLIDER-REID | tinyvision/SOLIDER (Apache), SOLIDER-REID (MIT) | ✅ code | Pretrained on **LUPerson: "can only be used for research, commercial usage is forbidden"** | ❌ weights | | Swin-T/S/B | heavy |
| TransReID | damo-cv/TransReID | MIT | Market/MSMT/Duke | ⚠️ data | | ViT-B | heavy |
| FastReID | JDAI-CV/fast-reid | Apache-2.0 | Model zoo on Market/Duke/MSMT/VeRi | ⚠️ data; good training framework | ✅ export tools | | |

**Dataset terms.**
- **Market-1501**: "research only … should NOT be distributed or used for commercial purposes" (search result; official site not fetched; UNVERIFIED wording).
- **MSMT17**: release agreement, "used for the purpose of scientific researches only", no redistribution (pkuvmc.com agreement PDF, via search).
- **DukeMTMC**: withdrawn by Duke in 2019 after privacy criticism. From memory; **UNVERIFIED in this session** because the search was rate-limited. Never use Duke-trained weights.
- **LUPerson**: research only (README fetched).

**Practical route.** Ship ReID only as an *opt-in, appearance-based "similar person" search* using:
(a) our own SigLIP 2 / PE-Core crop embeddings, which are generic and already licensed, plus attribute filters; or
(b) an OSNet trained by us on customer-consented or synthetic data (for example, a synthetic person set we generate ourselves).

Treat OMZ 0277 as a ⚠️ interim option pending legal review. Under the DPDP Act, appearance-based tracking of identifiable people is processing of personal data. It needs purpose limitation, a retention policy and a notice. It is not biometric 1:N face recognition, but legal should still classify it.

### 2c. Vehicle ReID

| Model | Licence | Data | Verdict |
|---|---|---|---|
| OMZ vehicle-reid-0001 (OSNet) | Apache-2.0 via sovrasov/deep-person-reid fork | **VeRi-776**: no licence published (TIB LDM lists none); the creators' terms are research-oriented (UNVERIFIED) | ⚠️/❌ unclear data licence |
| PP-Vehicle attribute (colour 10 / type 9) | Apache-2.0 | trained on VeRi | ⚠️ same issue |
| Better route | – | Fine-tune on UVH-26 crops (CC BY 4.0) plus our own data; use plate + colour/type + SigLIP embedding for cross-camera matching | ✅ |

---

## 3. Attributes (person, vehicle, Indian vehicle types)

| Model / dataset | Licence | Verdict | Notes |
|---|---|---|---|
| **PA-100K** (dataset) | **CC BY 4.0**, stated on the official xh-liu/HydraPlus-Net README | ✅ | 100k surveillance crops, 26 attributes. Train our own PPLCNet/MobileNet attribute head: our weights, our licence |
| PETA, RAPv2 (datasets) | research-only agreements (UNVERIFIED, sites not fetched) | ❌ for training shipped weights | |
| PP-Human attribute models (PP-LCNet x1.0, mA 94.5, 0.54 ms/person on GPU) | Apache-2.0 code/weights | ⚠️ trained on "PA100k, RAPv2, PETA and some business data", so it inherits RAP/PETA terms | Best accuracy/latency, but retrain on PA-100K only for a clean licence |
| OMZ person-attributes-recognition-crossroad-0238 (7 attrs: male, bag, hat, long sleeves, long pants, long hair, coat) | Apache-2.0 | ⚠️ undisclosed data | 1.0 GFLOPs |
| OMZ vehicle-attributes-recognition-barrier-0042 (7 colours, 4 types) | Apache-2.0 | ⚠️ undisclosed data | 0.46 GFLOPs, colour accuracy 82.7% |
| PP-Vehicle attribute (10 colours, 9 types) | Apache-2.0 | ⚠️ VeRi data | |
| Stanford Cars | non-commercial research (search; conflicting CC0 claims from re-uploaders) | ❌ | |
| CompCars | "non-commercial research purposes only" | ❌ | |
| VMMRdb | not checked (UNVERIFIED) | ⚠️ | Make/model on Indian roads is a poor fit anyway |
| **UVH-26** (IISc AIM) | dataset **CC BY 4.0**; models Apache-2.0 | ✅ (RT-DETRv2 / DAMO-YOLO weights); ❌ YOLOv11 weights (Ultralytics AGPL) | Classes: Hatchback, Sedan, SUV, MUV, Bus, Truck, Three-wheeler, Two-wheeler, LCV, Mini-bus, Tempo-traveller, Bicycle, Van, Others. **No separate e-rickshaw or tractor class.** RT-DETRv2-S weights are 322 MB (.pth) |
| IDD (IIIT-H India Driving Dataset) | Site blocked; described as "open … for research". DriveIndia (same ecosystem) is CC BY-NC-ND | ⚠️/❌ treat as research-only until written permission | Has autorickshaw class; dash-cam viewpoint |
| JATAYU v1.0 (Indian UAV, includes auto-rickshaw, e-rickshaw, tractor-trolley, cycle-rickshaw) | no LICENSE file | ❌ unclear | Drone viewpoint |
| DataCluster Labs Indian Vehicle / Number Plates | sample CC BY-NC-ND; full set **commercial licence for sale** | ⚠️ buy if needed | Classes include autorickshaw, tempo, tractor |
| Roboflow Universe "rickshaw / e-rickshaw" sets (CC BY 4.0) | per-uploader | ⚠️ provenance of scraped images is unknown | small |

**Recommendation.**
1. Fine-tune D-FINE-N/S (or RF-DETR on GPU) on **UVH-26 + COCO person** to get an Indian-traffic detector.
2. Add e-rickshaw and tractor through our own labelled customer data (with consent in contracts) or a purchased dataset.
3. Train a person-attribute head on **PA-100K only**.
4. Get vehicle colour and type from UVH-26 classes plus a small colour classifier trained on our own data.

---

## 4. PPE / safety (helmet, vest, mask, gloves)

| Dataset / model | Licence | Verdict | Notes |
|---|---|---|---|
| **SH17** (17 classes: helmet, vest, gloves, glasses, mask, face-guard, earmuffs, shoes, medical/safety suit…) | **CC BY-NC-SA 4.0**; "educational, research … only" | ❌ | The best class coverage, but unusable |
| SHWD (Safety Helmet Wearing Dataset) | repo MIT, but positives "got from google or baidu" (scraped) plus SCUT-HEAD | ⚠️ image copyright unclear | 7,581 images, helmet/head |
| Hard Hat Workers (Northeastern Univ. China, via Roboflow) | listed as Public Domain / CC0 on Roboflow (search; UNVERIFIED at source) | ⚠️ (provenance) | 7,035 images, helmet/head/person |
| Pictor-PPE | CC BY 4.0 on Roboflow (search); code MIT | ⚠️ | small |
| CHV (colour helmet + vest) | no LICENSE file in repo; Roboflow copy says CC BY 4.0 | ⚠️ | 1,330 images |
| PP-Human / PaddleDetection helmet models | Apache-2.0 code; data unclear | ⚠️ | |
| **Open-vocabulary route** | OWLv2 / Grounding DINO / Florence-2 (Apache/MIT) as a *labeller* | ✅ | Auto-label customer site footage, human-review it, train a D-FINE-N PPE head. This gives clean, site-specific weights |

**Recommendation.** Do not ship models trained on SH17. Bootstrap from Hard Hat Workers + Pictor-PPE + CHV (⚠️, document the provenance). Grow a proprietary PPE set from pilot sites with contractual consent, labelled with OWLv2/Florence-2 plus a human reviewer. PPE needs a person detector first and an ROI classifier (helmet / no-helmet / vest) on the crop. That is cheap on CPU.

---

## 5. Open-vocabulary detection and segmentation

| Model | Repo / HF | Code | Weights | Data | Verdict | ONNX | Size | CPU cost | VMS use |
|---|---|---|---|---|---|---|---|---|---|
| **OWLv2** base-p16 ensemble | google-research/scenic; google/owlv2-base-patch16-ensemble | Apache-2.0 | Apache-2.0 | WebLI pseudo-labels + O365/VG (Google internal) | ✅ | ✅ onnx-community/owlv2-base-patch16-ensemble-ONNX | ~155M, 960² input | heavy (~1–3 s CPU, UNVERIFIED) | offline "search anything", auto-labelling, PPE bootstrap |
| **Grounding DINO tiny** | IDEA-Research/GroundingDINO | Apache-2.0 | Apache-2.0 | O365, GoldG, Cap4M… (mixed licences) | ⚠️ data mix; weights Apache | ✅ grounding-dino-tiny-ONNX | 172M | heavy | same as above |
| **MM-Grounding-DINO tiny** | open-mmlab/mmdetection; openmmlab-community/mm_grounding_dino_tiny_o365v1_goldg_v3det | Apache-2.0 | Apache-2.0 | O365v1, GoldG, V3Det | ⚠️ data | HF transformers → export | 173M | heavy | |
| **OmDet-Turbo** (swin-tiny) | om-ai-lab/OmDet; omlab/omdet-turbo-swin-tiny-hf | Apache-2.0 | Apache-2.0 | O365/GoldG etc. (UNVERIFIED) | ✅/⚠️ | export (HF) | ~170M | faster than G-DINO ("real-time" on GPU) | GPU-tier live open-vocab |
| LLMDet | iSEE-Laboratory/LLMDet | Apache-2.0 | Apache-2.0 | GroundingCap-1M | ⚠️ data | export | tiny/base | heavy | |
| OV-DINO | wanghao9610/OV-DINO | Apache-2.0 | Apache-2.0 | O365/GoldG/CC1M | ⚠️ | | | heavy | |
| **Florence-2 base/large** | microsoft/Florence-2-* | MIT | MIT | FLD-5B (Microsoft) | ✅ | ✅ onnx-community/Florence-2-base(-ft) | 0.23B / 0.77B | ~1 s/img CPU (UNVERIFIED) | captions, OD, phrase grounding, OCR. Good offline enrichment for search |
| YOLOE | THU-MIG/yoloe | **AGPL-3.0** | AGPL | | ❌ | | | | |
| YOLO-World | AILab-CVC/YOLO-World | **GPL-3.0** | GPL | | ❌ | | | | |
| **SAM 2.1** (tiny/small) | facebookresearch/sam2 | Apache-2.0 | Apache-2.0 | SA-1B + SA-V | ✅ | ✅ onnx-community/sam2.1-hiera-tiny-ONNX | tiny 39M | encoder ~0.5–1 s CPU (UNVERIFIED) | click-to-mask privacy masking, evidence redaction of non-face objects |
| **SAM 3 / SAM 3.1** (text-prompted "segment anything with concepts", video tracking; 3.1 released 2026-03-27) | facebookresearch/sam3; facebook/sam3, sam3.1 (gated) | **SAM License (2025-11-19)** | same | SA-Co | ⚠️ commercial allowed, but forbids "military or warfare … espionage" end uses and requires the licence to pass downstream. ~850M params | onnx-community/sam3-tracker-ONNX (partial) | ~850M | GPU only | GPU-tier "find all red helmets" and precise masks. Needs a decision on police/defence tenders |
| EfficientSAM | yformer/EfficientSAM | Apache-2.0 | Apache-2.0 | SA-1B | ✅ | export | ViT-T 10M | ~100–200 ms (UNVERIFIED) | lightweight click masks |
| MobileSAM | ChaoningZhang/MobileSAM | Apache-2.0 | Apache-2.0 | SA-1B (distilled) | ✅ | ✅ | 9.7M encoder | ~50–100 ms (UNVERIFIED) | |
| EfficientViT-SAM | mit-han-lab/efficientvit | Apache-2.0 | Apache-2.0 (UNVERIFIED for weights) | SA-1B | ✅/⚠️ | ✅ | | fast | |
| SAM-HQ | SysCV/sam-hq | Apache-2.0 | Apache-2.0 | HQSeg-44K | ✅ | | ViT-B+ | heavy | |
| FastSAM | CASIA-IVA-Lab/FastSAM | **AGPL-3.0** | | | ❌ | | | | |
| RAM / RAM++ (tagging) | xinyu1205/recognize-anything | Apache-2.0 | Apache-2.0 (UNVERIFIED) | CC3M/12M, COCO, VG, SBU | ⚠️ | | | | tags for search |

Note on SA-1B: Meta distributes the dataset under a research licence (UNVERIFIED in this session). The SAM 2 weights themselves are Apache-2.0.

**Recommendation.** For "search anything", keep SigLIP 2 for frame retrieval. Add **OWLv2 (or Florence-2) as an offline re-ranker or box localiser** on the top-K retrieved frames, run on demand rather than per frame. For privacy masking, add **SAM 2.1-tiny or EfficientSAM** with click prompts in the review UI, then propagate the mask with the tracker.

---

## 6. VLMs for local verification and summaries (GGUF / llama.cpp)

| Model | Licence (verified from HF card) | Verdict | GGUF / llama.cpp | Size | Notes |
|---|---|---|---|---|---|
| **Qwen3.5-0.8B / 2B / 4B / 9B** (2026-02) | Apache-2.0 | ✅ | ggml-org/Qwen3.5-0.8B-GGUF; unsloth 2B/4B GGUF; ONNX (onnx-community) | 0.8–9B | Unified vision-language, 201 languages, 262k context. **Top candidate to replace SmolVLM2-2.2B and Qwen3-4B with one model** |
| **Gemma 4 E2B / E4B / 12B** (2026-03/05) | **Apache-2.0** | ✅ | ggml-org/gemma-4-E2B/E4B/12B-it-GGUF; QAT q4_0 GGUF from Google | E2B ≈ 2B effective, E4B ≈ 4B effective | Image + audio input on E2B/E4B/12B, 140+ languages. Strong second candidate |
| Qwen3-VL-2B / 4B / 8B (2025-10) | Apache-2.0 | ✅ | Qwen/Qwen3-VL-*-GGUF (official), ggml-org 2B | | Superseded by Qwen3.5 per Qwen's own card |
| Qwen2.5-VL-3B | **qwen-research** licence | ❌ | | | |
| Qwen2.5-VL-7B | Apache-2.0 | ✅ | yes | 7B | Older |
| **MiniCPM-V 4.6** (2026-05, SigLIP2-400M + Qwen3.5-0.8B) | Apache-2.0 (weights and code) | ✅ | ggml-org/MiniCPM-V-4.6-GGUF | ~1.3B | Vendor claims Qwen3.5-2B-level VLM scores and ~1.5× Qwen3.5-0.8B throughput. **Best CPU-speed candidate** |
| MiniCPM-V 4 / 4.5 | now Apache-2.0 (card updated 2026-08) | ✅ | yes | 4B / 8B | Earlier releases had a custom licence; check the version you pin |
| InternVL3.5-1B/2B/4B | Apache-2.0 (card); InternVL3-2B card cites the Qwen licence | ✅ / ⚠️ check the per-size LLM base | llama.cpp support UNVERIFIED (no ggml-org GGUF found) | | |
| SmolVLM2-2.2B (current) | Apache-2.0 | ✅ | ggml-org | 2.2B | Current; weaker than Qwen3.5-2B (UNVERIFIED head-to-head) |
| Moondream 2 (2025-04-14) | Apache-2.0 | ✅ | ggml-org/moondream2-20250414-GGUF | 1.9B | Good detect/point/caption API |
| Moondream 3 preview / 3.1 (9B-A2B) | Moondream Model License 1.0 / BSL-style (search: excludes paid products that compete or embed the weights) | ❌ | | | |
| Phi-4-multimodal | MIT | ✅ licence; ⚠️ llama.cpp vision support UNVERIFIED | | 5.6B | |
| Florence-2 | MIT | ✅ | ONNX, not GGUF | 0.23/0.77B | Captioning/OD, no chat |
| LLaVA-OneVision-0.5B | Apache-2.0 | ✅ | | | Dated |
| LFM2-VL / LFM2.5-VL-3B (Liquid) | LFM Open License 1.0: commercial use only below **US$10M annual revenue** | ⚠️ (we, or a large integrator customer, may cross the threshold) | GGUF yes | | |
| Granite-Vision-3.3-2B | Apache-2.0 | ✅ | UNVERIFIED | 2B | Document-focused |
| Ministral-3-3B/8B (2512) | Apache-2.0 | ✅ | ggml-org GGUF (vision-capable per pipeline tag) | 3B/8B | |
| Krutrim Chitrarth (Indic VLM) | Krutrim Community License: commercial only by separate agreement | ❌ | | | |
| Apple FastVLM | apple-amlr (research) | ❌ | | | |

**CPU speed (estimate, UNVERIFIED).** On 4–8 cores at Q4_K_M, a 2B text decoder runs at roughly 15–30 tokens/s. Prompt processing of one 384–512 px image (≈256–1,000 visual tokens) takes about 2–8 s for 2–4B models. That is fine for a yes/no "second opinion" on a few alarms per minute, but not per frame. Benchmark Qwen3.5-2B, MiniCPM-V-4.6 and Gemma-4-E2B with `llama-mtmd-cli` on the target box before deciding.

---

## 7. Small text LLMs (incident summaries, alarm triage, Indian languages)

| Model | Licence | Verdict | GGUF | Indic ability | Notes |
|---|---|---|---|---|---|
| **Qwen3.5-2B / 4B / 9B** | Apache-2.0 | ✅ | yes | 201 languages incl. Hindi and major Indic (vendor claim) | Replaces Qwen3-4B (current, Apache) |
| Qwen3-1.7B/4B (current) | Apache-2.0 | ✅ | yes | moderate | |
| **Gemma 4 E2B/E4B/12B** | Apache-2.0 | ✅ | yes | 140+ languages | |
| **Sarvam-30B** (MoE, 2.4B active, 2026-03) | Apache-2.0 | ✅ | sarvamai/sarvam-30b-gguf (Q4_K_M in 6 shards) | "SOTA across 22 Indian languages for its size" (vendor) | Needs ~18–20 GB RAM at Q4 (estimate), but runs at small-model speed on CPU because of MoE. **Best Indic option** |
| Sarvam-M (24B, Mistral-Small base) | Apache-2.0 | ✅ | GGUF | Indic | Too heavy for CPU |
| Sarvam-1 (2B) | **Sarvam non-commercial licence** | ❌ | | | |
| Sarvam-Translate | **GPL-3.0** (Gemma-3-4B finetune) | ❌ | | | |
| **IndicTrans2** (en↔22 Indic; 1B and distilled 200M) | **MIT** weights; data CC0 / CC BY 4.0 | ✅ (HF gating is click-through "auto") | ONNX/CT2 (no GGUF) | 22 scheduled languages | Translate English summaries into regional languages deterministically |
| Krutrim-2 | Krutrim Community License: commercial use needs a separate agreement | ❌ | | | |
| Granite 4.2 3B/8B (2026-08) | Apache-2.0 | ✅ | ibm-granite GGUF | limited Indic | Good tool-calling, enterprise-friendly provenance |
| Ministral-3 3B/8B | Apache-2.0 | ✅ | ggml-org GGUF | moderate | |
| Mistral Small 3.2 (24B) | Apache-2.0 | ✅ | GGUF | moderate | GPU tier |
| SmolLM3-3B | Apache-2.0 | ✅ | GGUF / ONNX | EN/FR/ES/DE/IT/PT only | |
| MiniCPM5-1B/2B (2026-05/09) | Apache-2.0 | ✅ | official GGUF | UNVERIFIED | |
| Phi-4-mini | MIT | ✅ | GGUF | weak Indic | |
| Llama 3.2 1B/3B | Llama 3.2 Community License + AUP | ❌ for railways/smart city (AUP item 11 "critical infrastructure, transportation technologies"; item 8 "espionage"); ⚠️ elsewhere. Also needs "Built with Llama" attribution | GGUF | | |
| LFM2.5-1.2B/2.6B | LFM 1.0 (US$10M revenue cap) | ⚠️ | GGUF | | |

---

## 8. Image quality, camera health and enhancement

| Item | Licence | Verdict | Notes |
|---|---|---|---|
| Classical tamper / defocus / blur / low-light / scene-change checks (OpenCV: Laplacian variance, histogram/entropy, edge density, SSIM vs reference frame, embedding drift using the SigLIP 2 vectors we already compute) | ours | ✅ **recommended** | No open, commercially licensed tamper-detection model of note was found. Classical methods plus embedding drift are robust and explainable |
| ARNIQA (no-reference IQA) | Apache-2.0 | ✅ code; ⚠️ weights trained on KADID/TID/KonIQ (research datasets, UNVERIFIED) | Score per camera for health dashboards |
| MUSIQ (google-research) | Apache-2.0 | ⚠️ trained on KonIQ/SPAQ/PaQ-2-PiQ (UNVERIFIED terms) | |
| pyiqa / IQA-PyTorch (CLIP-IQA, TOPIQ, …) | **PolyForm Noncommercial 1.0.0** | ❌ | |
| Q-Align | S-Lab License 1.0 (non-commercial, UNVERIFIED wording) | ❌ | |
| Zero-DCE / Zero-DCE++ | "non-commercial use only", CC BY-NC 4.0 | ❌ | |
| SCI (self-calibrated illumination) | no LICENSE file | ❌ unclear | |
| EnlightenGAN | BSD-style (Yifan Jiang & Zhangyang Wang) | ✅ code; ⚠️ unpaired training data | |
| Retinexformer | MIT | ✅ code; ⚠️ LOL data (research, UNVERIFIED) | |
| NAFNet (deblur/denoise) | MIT | ✅ code; ⚠️ GoPro/SIDD data | |
| SCUNet (denoise) | Apache-2.0 | ✅ | |
| Real-ESRGAN | BSD-3-Clause | ✅ code; ⚠️ weights trained on DF2K (DIV2K + Flickr2K) + OST. DIV2K is academic-use (UNVERIFIED) | Evidence caveat below |
| SwinIR | Apache-2.0 | ✅ code; ⚠️ same data | |
| DehazeFormer | MIT | ✅ code; ⚠️ RESIDE data | |

**Evidence-integrity caveat.** Super-resolution and generative enhancement *hallucinate* detail. Number plates and faces may be invented. Never overwrite the original. Always present enhanced output as a labelled derivative with the model, version and parameters recorded and hashed alongside the original. Courts in India generally need the original electronic record with a Section 63 Bharatiya Sakshya Adhiniyam (formerly 65B Evidence Act) certificate. Keep enhancement a viewer-side, non-destructive tool.

---

## 9. Audio events

| Model | Code | Weights | Data | Verdict | ONNX | Size |
|---|---|---|---|---|---|---|
| **YAMNet** | tensorflow/models (Apache-2.0, covers /research) | Apache-2.0 | AudioSet (YouTube) | ⚠️ (data) | TF → ONNX via tf2onnx | 3.7M, 521 classes |
| PANNs CNN14 / MobileNetV2 | qiuqiangkong/audioset_tagging_cnn (no LICENSE file) | Zenodo CC BY 4.0 (search) | AudioSet | ⚠️ | ✅ (community ONNX) | 80M / 4M |
| EfficientAT (mn04–mn40) | MIT | MIT (UNVERIFIED for weights) | AudioSet | ⚠️ | ✅ | 0.9M–68M. Best accuracy per FLOP on CPU |
| AST | BSD-3 (HF MIT/ast-finetuned-audioset) | BSD-3 | AudioSet + ImageNet | ⚠️ | export | 87M, heavy |
| BEATs | microsoft/unilm (MIT) | MIT (UNVERIFIED for checkpoints) | AudioSet | ⚠️ | export | 90M |
| CED-tiny / Dasheng | CED repo **GPL-3.0** ❌; HF mispeech/ced-tiny weights Apache-2.0; Dasheng Apache-2.0 | | AudioSet | ⚠️ use the HF weights, not the GPL training code | ✅ | CED-tiny 5.5M |
| LAION-CLAP | repo CC0; HF weights Apache-2.0 | | LAION-Audio-630K incl. Freesound (mixed CC incl. NC) + AudioSet | ⚠️ | export | zero-shot "glass breaking", "scream" |
| MS-CLAP | MIT code; HF weights MS-PL | | mixed | ⚠️ | | |
| Meta PE-AV small | Apache-2.0 | | UNVERIFIED | ✅/⚠️ | | |

**AudioSet.** Labels are CC BY 4.0 and the ontology is CC BY-SA 4.0. The audio lives on YouTube and is subject to the YouTube ToS and uploaders' copyright. Shipping models trained on it is industry-standard practice (Google's own YAMNet is Apache), but it is a residual risk. Note it as ⚠️ in tender compliance sheets.

**Indian law.** Recording audio in workplaces and public spaces raises extra privacy and wiretap-style concerns. Run *on-device event classification only* (no speech recognition, no audio retention by default) and disclose it in signage.

**Recommendation.** Use YAMNet or EfficientAT-mn10 (ONNX, under 5 ms per 1 s window on CPU, estimate) for glass-break, scream, siren, gunshot-like and horn events, with CLAP for custom zero-shot labels.

---

## 10. Counting, heatmaps, queues and ANPR

### Counting / density
| Model | Licence | Verdict | Note |
|---|---|---|---|
| Detector + tracker line/zone counting (D-FINE + ByteTrack/OC-SORT) | ✅ | ✅ **recommended** for queues and footfall up to moderate density | |
| DM-Count | MIT code | ⚠️ weights on ShanghaiTech/UCF-QNRF/NWPU (research datasets) | Dense crowds (stations, melas) |
| CLIP-EBC | MIT | ⚠️ same data + CLIP | |
| APGCC | MIT | ⚠️ same | |
| P2PNet (Tencent) | **"only for the purpose of academic research"** | ❌ | |
| CSRNet-pytorch | no LICENSE | ❌ | |
| LearningToCountEverything (FamNet), LOCA (class-agnostic) | MIT | ⚠️ FSC-147 data | Count arbitrary objects (sacks, cartons) from exemplars |

For dense crowd counting at railway concourses, train DM-Count or CLIP-EBC on our own annotated footage, or accept ⚠️ dataset risk with a human decision.

### ANPR (current: PP-OCRv4 det + fast-plate-ocr CCT)
| Item | Licence | Verdict | Evidence |
|---|---|---|---|
| **PP-OCRv6 tiny/small/medium det** (2026-06) | Apache-2.0, official ONNX | ✅ **upgrade** | Measured: v6 tiny 18.4 ms, v6 small 41.8 ms, v4 39.5 ms (640², 4 cores). Hmean: v6 tiny 80.6, small 84.1, medium 86.2 vs v5 mobile 75.2 |
| PP-OCRv6 rec (tiny 1.1M / small / medium; ~48–50 languages incl. Latin) | Apache-2.0, ONNX | ✅ | Fallback recogniser for non-standard plates and signage. Devanagari/Tamil/Telugu recognisers exist in the PP-OCRv5 line (deva/ta/te_PP-OCRv5_mobile_rec ONNX) |
| PaddleOCR-VL-1.6 (GGUF) | Apache-2.0 | ✅ | Heavy; document OCR, not plates |
| fast-plate-ocr CCT v2 global (current) | MIT code | ⚠️ **training-data provenance of the "global" weights not documented (UNVERIFIED)**. Fine-tune on Indian plates | 0.47–0.68 ms/plate |
| fast-alpr / open-image-models (YOLOv9-t plate detector) | MIT | ⚠️ which YOLOv9 implementation was used to train it (GPL WongKinYiu vs MIT MultimediaTechLab) is UNVERIFIED | Do not adopt without checking |
| PARSeq | Apache-2.0 | ✅ code; weights trained on synthetic MJ/ST + real benchmarks (mixed) | Strong STR; ONNX export |
| TrOCR | MIT (unilm); HF card has no licence field | ⚠️ | Heavy for plates |
| Indian plate datasets | Kaggle "Indian Number Plates" (DataCluster): HF sample **CC BY-NC-ND**, full set sold commercially; "Indian Licence Plate Dataset in the wild" (16k images, arXiv 2111.06054): licence UNVERIFIED; Roboflow CC BY sets are small | ❌/⚠️ | **Build our own from pilot sites** (two-row plates, HSRP, Bharat-series "BH", commercial yellow, EV green). Bootstrap labels with PP-OCRv6 + human review |
| CCPD (Chinese plates, used by PP-Vehicle) | research (UNVERIFIED) | ⚠️ | irrelevant script |

---

## 11. Embedding upgrades (image/text search)

| Model | Licence | Data | Verdict | ONNX | Size | Notes |
|---|---|---|---|---|---|---|
| **SigLIP 2 large-p16-256/384, so400m-p14-384, giant** | Apache-2.0 | WebLI (Google internal) | ✅ | ✅ onnx-community (base/large/so400m/giant) | L ~0.88B total; so400m ~1.1B | Same family as current: easiest upgrade. so400m at 384 for the GPU tier |
| SigLIP 2 base NaFlex | Apache-2.0 | WebLI | ✅ | via timm/HF | 0.37B | Native aspect ratio, better for wide CCTV frames |
| **Meta PE-Core T16 / S16 / B16 / L14** | Apache-2.0 (repo and HF cards) | MetaCLIP-style curated web data (Meta) | ✅ | B16 and L14 in onnx-community | B: 0.09B vision; L: 0.32B vision | PE-Core-B16: IN-1k 78.4, COCO T2I 50.9; L14-336: 83.5 / 57.1. Note PLM (PerceptionLM) is FAIR Research License ❌, and MetaCLIP repo is CC BY-NC 4.0 ❌ (use PE weights, not MetaCLIP) |
| Google TIPS v1 (s14 / b14 / l14 / so400m, 2026-08) | Apache-2.0 | UNVERIFIED | ✅ | not yet | | Image-text with strong dense features; worth a benchmark |
| Qwen3-VL-Embedding-2B (2026-01) | Apache-2.0 | | ✅ | GGUF/ONNX UNVERIFIED | 2B | GPU-tier multimodal retrieval and reranking |
| Microsoft Mage-ViT (2026-07) | MIT | UNVERIFIED | ✅ | | | Unbenchmarked |
| EVA-CLIP | MIT (QuanSun/EVA-CLIP); EVA-CLIP-8B Apache-2.0 | LAION-2B + COYO-700M | ⚠️ LAION data concerns | | | |
| OpenCLIP LAION models | MIT code/weights | LAION-2B (CSAM-contamination scandal 2023, re-released as Re-LAION; copyright) | ⚠️ | | | Avoid as the default |
| DataComp / DFN CLIP (apple/DFN2B-*) | apple-amlr / sample-code licence | | ❌/⚠️ | | | |
| **MobileCLIP / MobileCLIP2** | code MIT, but **weights "Apple Machine Learning Research Model … exclusively for Research Purposes"** | DataCompDR / DFN | ❌ | | | Despite the attractive speed |
| jina-clip-v2 | CC BY-NC 4.0 | | ❌ | | | |
| Meta MoEViE (2026-08) | CC BY-NC 4.0 | | ❌ | | | |
| NVIDIA C-RADIOv3 | NVIDIA Open Model License | | ⚠️ (permissive commercial, but custom terms) | | | GPU |

---

## Top-10 shortlist (value to an Indian on-prem VMS × feasibility)

| # | Pick | Why | Effort |
|---|---|---|---|
| 1 | **PP-OCRv6 tiny/small det (+ rec as fallback)** replacing PP-OCRv4 det | Apache, official ONNX, measured 2× faster (tiny) with higher Hmean. Drop-in | S |
| 2 | **Qwen3.5-2B/4B (GGUF)** as a single VLM + LLM, replacing SmolVLM2 and Qwen3-4B | Apache, multimodal, 201 languages incl. Hindi; one model to maintain | M |
| 3 | **D-FINE-N (416–512) / D-FINE-S** as the CPU detector, RF-DETR-S/M on GPU | +10 AP over YOLOX-tiny at ~28–35 ms CPU; Apache; ONNX ready | M |
| 4 | **UVH-26 fine-tune** (CC BY 4.0) for Indian vehicle classes (three-wheeler, tempo-traveller, LCV…) | Only clean, large Indian CCTV dataset found; start from the Apache RT-DETRv2-S / DAMO-YOLO-T checkpoints | M |
| 5 | **OC-SORT / ByteTrack (MIT)** re-implemented in TypeScript, plus BoT-SORT camera-motion compensation for PTZ | No AGPL dependency (avoid BoxMOT) | S–M |
| 6 | **MiniCPM-V 4.6 or Gemma 4 E2B** as the fast VLM verifier (benchmark against #2) | Apache; ~1.3B / ~2B effective; ggml-org GGUF | S |
| 7 | **PA-100K-trained person-attribute head** (our own PPLCNet/MobileNet) | CC BY 4.0 data; enables "red shirt + backpack" search without face recognition | M |
| 8 | **SAM 2.1-tiny / EfficientSAM** click-to-mask privacy redaction (ONNX) | Apache; DPDP-aligned privacy masking of people, screens and documents | M |
| 9 | **YAMNet / EfficientAT audio events** (ONNX) | Tiny, CPU-cheap; glass-break, scream, siren alarms | S |
| 10 | **Sarvam-30B (MoE, Apache) or IndicTrans2-200M (MIT)** for regional-language incident summaries | Strong Indic coverage. IndicTrans2 is CPU-cheap; Sarvam-30B needs ~20 GB RAM | M |

Honourable mentions: PE-Core-B16 / SigLIP 2-large as an embedding upgrade (benchmark on our CCTV retrieval set first); OWLv2/Florence-2 as an offline auto-labeller and "search anything" re-ranker; OMZ person-reid-0277 (⚠️ pending legal).

---

## Do-not-use list

| Item | Reason |
|---|---|
| DEIMv2, EdgeCrafter | 2026 non-commercial licences |
| YOLOv10, YOLOv12, YOLO11, YOLO26, YOLOE, FastSAM, BoxMOT | AGPL-3.0 |
| YOLOv9 (WongKinYiu), YOLO-World, StrongSORT, CED training code | GPL-3.0 |
| UVH-26 YOLOv11 weights | Ultralytics-trained, AGPL despite the Apache label |
| RF-DETR XL / 2XL (rfdetr_plus) | PML 1.0, not Apache |
| Gold-YOLO | no licence file found (unclear) |
| SOLIDER weights / LUPerson | "research only, commercial usage is forbidden" |
| Any Duke/Market/MSMT-trained ReID weights (torchreid zoo, FastReID zoo, CLIP-ReID, TransReID) | Research-only data; DukeMTMC withdrawn |
| SH17 PPE dataset | CC BY-NC-SA 4.0 |
| Stanford Cars, CompCars | Non-commercial |
| MobileCLIP / MobileCLIP2, FastVLM, DFN CLIP | Apple research-only weights |
| jina-clip-v2, MoEViE, MetaCLIP repo, PLM | CC BY-NC / FAIR research |
| Qwen2.5-VL-3B | qwen-research licence |
| Moondream 3 / 3.1 | Moondream Model License (BSL-style) |
| Sarvam-1 | non-commercial |
| Sarvam-Translate | GPL-3.0 |
| Krutrim-2 / Chitrarth | commercial use only by separate agreement |
| Llama 3.x for railway / smart-city / transport | AUP item 11 (critical infrastructure, transportation) + espionage clause |
| Zero-DCE / Zero-DCE++, SCI, P2PNet, CSRNet-pytorch | NC / research-only / no licence |
| pyiqa (IQA-PyTorch), Q-Align | PolyForm Noncommercial / S-Lab |
| Gemma 3 / 3n | Not banned, but superseded by Apache Gemma 4; avoid the Gemma Terms + Prohibited Use Policy |

---

## Risks and human decisions

1. **Meta "espionage / military" clauses** (DINOv3 License, SAM License for SAM 3/3.1, Llama AUP). VigilOne sells to police, railways (RPF) and smart-city bodies. Legal must decide whether "security surveillance" could be read as espionage, and whether we accept DINOv3-distilled weights (RT-DETRv4) and SAM 3 on the GPU tier. Apache alternatives exist for every category, so the low-risk default is to avoid them.
2. **Training-data provenance for "Apache" weights.** COCO (Flickr images under various CC licences), Objects365, AudioSet (YouTube), DIV2K, LAION. This is industry-standard but not zero-risk. Record it in a model-provenance register (model, version, SHA-256, code licence, weights licence, data) and ship NOTICE files.
3. **ReID and attributes under the DPDP Act 2023.** Cross-camera person following and attribute search process personal data. Gender/age attributes are sensitive inferences: consider *not* shipping gender/age, or gating them per tenant. Default to off, purpose-bound, with retention limits, audit logs and signage/notice. Keep the explicit "no 1:N face recognition" position; YuNet stays redaction-only.
4. **OpenVINO OMZ** is in maintenance mode, its training data is undisclosed, and it carries the Intel human-rights clause. Legal must accept or reject these as interim models.
5. **Revenue-capped licences** (Liquid LFM, US$10M) and **"free unless you compete" licences** (Moondream 3). Avoid them so a future acquisition or large OEM deal does not trigger a relicence.
6. **Evidence integrity.** Enhancement and super-resolution must be non-destructive and labelled (see §8). VLM "second opinion" outputs must be logged as advisory and never auto-close or auto-escalate without a human for high-stakes alarms.
7. **Indian datasets.** Licences for IDD, JATAYU and the Indian plate sets are unclear or commercial. Budget for **our own annotated Indian dataset** (plates, e-rickshaw, tractor, PPE), with customer-consent clauses in contracts.
8. **CPU reality check.** Transformer detectors (RF-DETR, RT-DETRv2) are 5–10× slower than YOLOX-nano on CPU. Dynamic INT8 was slower than FP32 for D-FINE. Plan static QDQ quantisation or OpenVINO EP experiments, and keep YOLOX-nano as a motion-gated pre-filter.
9. **Licences can change** (DEIMv2 did in 2026; MiniCPM-V moved to Apache). Pin exact revisions/commits and archive the LICENSE text with each model artefact.

---

## Measured CPU benchmark (raw)

Environment: 4-core Intel Xeon @ 2.1 GHz (sandbox), onnxruntime 1.30, FP32, intra-op 4 threads, batch 1, median of 15 runs.

| Model | Input | Median ms |
|---|---|---|
| YOLOX-nano (current) | 416 | 7.1 |
| YOLOX-tiny (current) | 416 | 18.0 |
| D-FINE-N | 416 / 512 / 640 | 28.3 / 35.5 / 48.0 |
| D-FINE-N int8 (dynamic) | 640 | 170.9 |
| D-FINE-S | 640 | 101.4 |
| RF-DETR-N | 384 | 95.3 (int8: 73.2) |
| RF-DETR-S | 512 | 158.2 |
| RT-DETRv2-S (r18) | 640 | 155.4 |
| PP-OCRv4 det (current) | 640 | 39.5 |
| PP-OCRv6 tiny det | 640 | 18.4 |
| PP-OCRv6 small det | 640 | 41.8 |

---

## Sources

Licences and READMEs (raw.githubusercontent.com unless stated):
- RF-DETR: https://github.com/roboflow/rf-detr (LICENSE, README "License" section: Apache vs PML 1.0, benchmark tables); PyPI https://pypi.org/project/rfdetr/ (1.11.2, 2026-10-04)
- D-FINE: https://github.com/Peterande/D-FINE (Apache-2.0)
- DEIM: https://github.com/Intellindust-AI-Lab/DEIM (Apache-2.0)
- DEIMv2: https://github.com/Intellindust-AI-Lab/DEIMv2/blob/main/LICENSE.md (non-commercial, 2026)
- EdgeCrafter: https://github.com/Intellindust-AI-Lab/EdgeCrafter/blob/main/LICENSE.md
- RT-DETR / v2: https://github.com/lyuwenyu/RT-DETR; RT-DETRv3: https://github.com/clxia12/RT-DETRv3; RT-DETRv4: https://github.com/RT-DETRs/RT-DETRv4
- DINOv3 License: https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md
- LW-DETR: https://github.com/Atten4Vis/LW-DETR
- YOLOv10 (AGPL): https://github.com/THU-MIG/yolov10; YOLOv12 (AGPL): https://github.com/sunsmarterjie/yolov12; YOLOv9 (GPL): https://github.com/WongKinYiu/yolov9; MIT YOLO: https://github.com/MultimediaTechLab/YOLO
- PaddleDetection: https://github.com/PaddlePaddle/PaddleDetection (PP-Human/PP-Vehicle docs under deploy/pipeline/docs/tutorials/)
- DAMO-YOLO: https://github.com/tinyvision/DAMO-YOLO; YOLOX: https://github.com/Megvii-BaseDetection/YOLOX
- ByteTrack https://github.com/ifzhang/ByteTrack; OC-SORT https://github.com/noahcao/OC_SORT; BoT-SORT https://github.com/NirAharon/BoT-SORT; Deep-OC-SORT https://github.com/GerardMaggiolino/Deep-OC-SORT; StrongSORT https://github.com/dyhBUPT/StrongSORT; BoxMOT https://github.com/mikel-brostrom/boxmot; roboflow/trackers https://github.com/roboflow/trackers
- torchreid https://github.com/KaiyangZhou/deep-person-reid; CLIP-ReID https://github.com/Syliz517/CLIP-ReID; SOLIDER https://github.com/tinyvision/SOLIDER; SOLIDER-REID https://github.com/tinyvision/SOLIDER-REID; LUPerson https://github.com/DengpanFu/LUPerson; TransReID https://github.com/damo-cv/TransReID; FastReID https://github.com/JDAI-CV/fast-reid
- OpenVINO OMZ: https://github.com/openvinotoolkit/open_model_zoo (README maintenance note; models/intel/person-reidentification-retail-0277, -0288, person-attributes-recognition-crossroad-0238, vehicle-attributes-recognition-barrier-0042; models/public/vehicle-reid-0001)
- MSMT17 agreement: https://www.pkuvmc.com/agreement/RELEASE_AGREEMENT-MSMT17.pdf (via search)
- Market-1501 terms (via search): https://www.kaggle.com/datasets/pengcw1/market-1501
- VeRi-776 (no licence listed): https://service.tib.eu/ldmservice/dataset/veri-776
- PA-100K CC BY 4.0: https://github.com/xh-liu/HydraPlus-Net
- SH17: https://github.com/ahmadmughees/SH17dataset (README licence section)
- SHWD: https://github.com/njvisionpower/Safety-Helmet-Wearing-Dataset
- Hard Hat Workers: https://public.roboflow.com/object-detection/hard-hat-workers (via search)
- CHV: https://github.com/ZijianWang-ZW/PPE_detection; Pictor-PPE: https://github.com/ruoxinx/PPE-Detection-Pose
- UVH-26: https://huggingface.co/iisc-aim/UVH-26 ; https://huggingface.co/datasets/iisc-aim/UVH-26 ; https://www.iisc.ac.in/events/aim-iisc-announces-public-release-of-uvh-26-dataset-and-vision-models-for-indian-urban-traffic/ ; arXiv 2511.02563
- IDD: https://blogs.iiit.ac.in/idd-dataset/ ; DriveIndia arXiv 2507.19912 (via search)
- JATAYU: https://github.com/Abhijnan-Maji/JATAYUv1.0-vehicle-detection-UAV-Dataset ; DataCluster: https://github.com/datacluster-labs/Indian-Vehicle-Image-Dataset ; https://huggingface.co/datasets/Dataclusterlabspvtltd/indian-number-plates-dataset
- CompCars: https://mmlab.ie.cuhk.edu.hk/datasets/comp_cars/ (via search); Stanford Cars (via search)
- Grounding DINO https://github.com/IDEA-Research/GroundingDINO; MMDetection https://github.com/open-mmlab/mmdetection; YOLOE https://github.com/THU-MIG/yoloe; YOLO-World https://github.com/AILab-CVC/YOLO-World; OmDet https://github.com/om-ai-lab/OmDet; LLMDet https://github.com/iSEE-Laboratory/LLMDet; OV-DINO https://github.com/wanghao9610/OV-DINO; RAM https://github.com/xinyu1205/recognize-anything; Scenic/OWLv2 https://github.com/google-research/scenic
- SAM 2 https://github.com/facebookresearch/sam2; SAM 3 (SAM License, SAM 3.1 2026-03-27) https://github.com/facebookresearch/sam3; EfficientSAM https://github.com/yformer/EfficientSAM; SAM-HQ https://github.com/SysCV/sam-hq; MobileSAM https://github.com/ChaoningZhang/MobileSAM; FastSAM https://github.com/CASIA-IVA-Lab/FastSAM; EfficientViT https://github.com/mit-han-lab/efficientvit
- HF model cards (licence via HF API): Qwen/Qwen3.5-{0.8B,2B,4B,9B}, Qwen/Qwen3-VL-{2B,4B,8B}-Instruct, Qwen/Qwen2.5-VL-3B-Instruct (qwen-research), Qwen/Qwen3-VL-Embedding-2B, google/gemma-4-{E2B,E4B,12B}-it, google/gemma-3-4b-it, google/gemma-3n-E4B-it, OpenGVLab/InternVL3_5-{1B,2B,4B}, openbmb/MiniCPM-V-4, -4_5, -4.6, openbmb/MiniCPM5-2B, HuggingFaceTB/SmolVLM2-2.2B-Instruct, SmolLM3-3B, vikhyatk/moondream2, moondream/moondream3-preview, moondream/moondream3.1-9B-A2B, microsoft/Phi-4-multimodal-instruct, Phi-4-mini-instruct, Florence-2-base/large, Mage-VL, Mage-ViT, LiquidAI/LFM2.5-VL-3B (LICENSE: US$10M threshold), ibm-granite/granite-4.2-{3b,8b}, granite-vision-3.3-2b, mistralai/Ministral-3-{3B,8B}-Instruct-2512, Mistral-Small-3.2-24B, meta-llama/Llama-3.2-3B-Instruct, sarvamai/sarvam-1, sarvam-m, sarvam-30b, sarvam-30b-gguf, sarvam-translate, ai4bharat/indictrans2-en-indic-1B / -dist-200M, krutrim-ai-labs/Krutrim-2-instruct (LICENSE.md), Chitrarth, apple/FastVLM-0.5B-fp16
- ggml-org GGUF listings: https://huggingface.co/ggml-org
- Gemma 4 Apache-2.0: https://opensource.googleblog.com/2026/03/gemma-4-expanding-the-gemmaverse-with-apache-20.html ; https://the-decoder.com/googles-gemma-4-is-now-available-with-apache-2-0-licensing-for-the-first-time/ (via search) and the HF card
- Moondream licence (via search): https://huggingface.co/moondream/moondream3-preview/blob/main/LICENSE.md ; https://moondream.ai/licenses/model/1.0 (blocked)
- Llama 3.2 licence and AUP: https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE , .../USE_POLICY.md
- IndicTrans2 licence table: https://github.com/AI4Bharat/IndicTrans2
- Embeddings: google/siglip2-* (HF), apple/MobileCLIP2-* (HF), https://github.com/apple/ml-mobileclip/blob/main/LICENSE_MODELS, facebook/PE-Core-{T16,S16,B16} (HF), https://github.com/facebookresearch/perception_models (README badges), MetaCLIP https://github.com/facebookresearch/MetaCLIP (CC BY-NC), google/tipsv1-* (HF), https://github.com/google-deepmind/tips, facebook/MoEViE-B16-224 (CC BY-NC), jinaai/jina-clip-v2, nvidia/C-RADIOv3-B, QuanSun/EVA-CLIP, BAAI/EVA-CLIP-8B, https://github.com/mlfoundations/open_clip, https://github.com/baaivision/EVA
- Audio: https://github.com/tensorflow/models (LICENSE; research/audioset/yamnet), https://github.com/qiuqiangkong/audioset_tagging_cnn, PANNs Zenodo https://zenodo.org/records/3987831 (via search), https://github.com/fschmid56/EfficientAT, https://github.com/YuanGongND/ast, https://github.com/microsoft/unilm (BEATs), https://github.com/RicherMans/CED (GPL), https://huggingface.co/mispeech/ced-tiny, https://github.com/XiaoMi/dasheng, https://github.com/LAION-AI/CLAP, https://huggingface.co/laion/clap-htsat-unfused, https://github.com/microsoft/CLAP, https://huggingface.co/facebook/pe-av-small; AudioSet terms: https://huggingface.co/datasets/agkphysics/AudioSet (via search)
- Image quality: https://github.com/Li-Chongyi/Zero-DCE , https://github.com/Li-Chongyi/Zero-DCE_extension , https://github.com/vis-opt-group/SCI , https://github.com/xinntao/Real-ESRGAN (+ docs/Training.md), https://github.com/JingyunLiang/SwinIR , https://github.com/IDKiro/DehazeFormer , https://github.com/caiyuanhao1998/Retinexformer , https://github.com/megvii-research/NAFNet , https://github.com/chaofengc/IQA-PyTorch (PolyForm NC), https://github.com/Q-Future/Q-Align , https://github.com/miccunifi/ARNIQA , https://github.com/cszn/SCUNet , https://github.com/VITA-Group/EnlightenGAN
- Counting: https://github.com/TencentYoutuResearch/CrowdCounting-P2PNet , https://github.com/cvlab-stonybrook/DM-Count , https://github.com/Yiming-M/CLIP-EBC , https://github.com/AaronCIH/APGCC , https://github.com/leeyeehoo/CSRNet-pytorch , https://github.com/cvlab-stonybrook/LearningToCountEverything , https://github.com/djukicn/loca
- OCR/ANPR: https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec , PP-OCRv6_tiny_det , PP-OCRv6_small_det(_onnx) , https://github.com/PaddlePaddle/PaddleOCR (release notes) , PaddlePaddle/PaddleOCR-VL-1.6 , https://github.com/baudm/parseq , https://github.com/ankandrew/fast-plate-ocr , https://github.com/ankandrew/fast-alpr , https://github.com/ankandrew/open-image-models
- ONNX exports: https://huggingface.co/onnx-community (dfine_*, rfdetr_*, rtdetr_v2_*, owlv2-*, grounding-dino-tiny-ONNX, sam2.1-hiera-*-ONNX, siglip2-*-ONNX, PE-Core-*-ONNX, Florence-2-*, Qwen3.5-*-ONNX, gemma-4-*-ONNX)

**UNVERIFIED summary.** DukeMTMC withdrawal details, Stanford Cars/VMMRdb/RAP/PETA/IDD official terms, DIV2K/KonIQ/LOL terms, LLM/VLM CPU speeds, SAM/OWLv2/Florence CPU latencies, PP-YOLOE/DAMO-YOLO AP figures, Moondream licence full text, fast-plate-ocr training data, and llama.cpp vision support for InternVL3.5 / Phi-4-mm / Granite-Vision.
