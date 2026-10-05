# VigilOne: Fire & Smoke and Weapon Detection Research Report

Research date: 2026-10-05. Prepared for VigilOne (on-prem VMS, India; Node.js worker on onnxruntime-node; CPU-first with optional NVIDIA GPU).

## 0. How this was verified (read first)

Network egress in the research sandbox was restricted. **arxiv.org, zenodo.org, kaggle.com, universe.roboflow.com, scidb.cn, mivia.unisa.it, ftc.gov and objects365.org could not be fetched directly**. What *could* be read directly: any public GitHub repo (shallow git clone of LICENSE/README) and Hugging Face (API + raw model/dataset cards). Everything else comes from web-search result summaries of the primary pages.

Evidence tags used throughout:

- **[SRC]**: I read the primary file myself (the LICENSE, README or HF card in the repo).
- **[SEARCH]**: taken from a web-search summary of the primary or secondary page. The page itself was not opened, so re-check before a legal sign-off.
- **UNVERIFIED**: not confirmed, or sources conflict.

Verdict key: ✅ usable in a paid closed-source product, with attribution where required. ⚠️ usable only after a human or legal decision, or with conditions. ❌ do not use (GPL/AGPL, NC, research-only, no licence, or a third party's footage).

---

## 1. Executive summary

1. **Fire/smoke can be built from clean data.** **D-Fire (CC0 [SRC], 21.5k images, about 9.8k negatives)** plus **Pyro-SDIS (Apache-2.0 [SRC], 12.4k wildfire-smoke images from Pyronear's own cameras, including 1,634 real false-positive negatives)** are commercially clean. FASDD_CV (95k, CC BY 4.0 [SEARCH]) is large, but part of it was web-crawled, so its provenance is weaker. Fine-tune our own detector (YOLOX, which we already ship, or RF-DETR-S/M, or D-FINE-S/M with COCO-only weights). Add a temporal verifier: persistence, area/flicker variation and a motion mask. Single-frame detectors are not shippable on their own. In the ONFIRE 2023 contest, methods trained on the standard public data could not combine Recall >95% with Precision above roughly 50% [SEARCH]. A 2026 cross-dataset study measured mAP drops of **38–65 points** when the same weights were moved from one public dataset to another [SEARCH].
2. **There is no clean, commercially licensed, large real-CCTV weapon dataset.** The best-known CCTV gun set (US Real-time Gun Detection / Mock Attack + Unity synthetic, Univ. Sevilla) is **CC BY-NC 4.0 [SRC]**; its authors invite contact for commercial use. YouTube-GDD has no data licence and consists of YouTube frames [SRC] → ❌. OD-WeaponDetection (Granada) is CC BY 4.0 according to License.md but CC BY-SA 4.0 according to its README [SRC]. That conflict, plus its web-sourced images, makes it ⚠️. Weapons therefore need **staged data that we collect ourselves**: replica guns and Indian edged/blunt tools, filmed on customer cameras at real mounting heights. Small CC BY synthetic samples (Simuletic) and licensable synthetic data can supplement it. Ship weapons only as **"human-verified advisory"**.
3. **Detector bases:** RF-DETR N/S/M/L (Apache-2.0 [SRC]; XL/2XL are PML 1.0, not Apache), D-FINE (Apache-2.0 [SRC]), DEIM v1 (Apache-2.0 [SRC]) and RT-DETR/RT-DETRv2 in the lyuwenyu repo (Apache-2.0 [SRC]) are all usable and export to ONNX. **DEIMv2 has changed to a non-commercial "DEIMv2 License" (2026) [SRC] → ❌.** Third-party HF mirrors still tag it Apache-2.0 and are wrong. **D-FINE's README now warns that its Objects365-pretrained checkpoints "should not be assumed to be commercially cleared" [SRC].** RF-DETR's base checkpoints were also pretrained on Objects365 [SEARCH], and Objects365 images are under Flickr terms with an "academic purpose" statement [SEARCH]. This is a legal decision we need to make (see §8).
4. **Open-vocabulary quick path:** OWLv2 / OWL-ViT (Apache, ONNX available), Grounding DINO tiny (Apache, ONNX available), Florence-2 (MIT, ONNX available) and SigLIP 2 (Apache) are licence-OK. YOLO-World is **GPL-3.0 [SRC]** and YOLOE is **AGPL-3.0 [SRC]** → ❌. Grounding DINO 1.5/1.6 and DINO-X are **API-only** [SEARCH], so they don't fit on-prem. I found **no published zero-shot accuracy for fire or weapon prompts**. Use these models only as a **second-stage verifier on candidate crops** (the FIRE-TASTIC pattern), not as a per-frame primary detector on CPU.
5. **Nearly every pretrained fire or weapon model on Roboflow, HF and GitHub is Ultralytics-trained, which makes it AGPL-3.0** (e.g. `rabahdev/fire-smoke-yolov8n`, `mfranzon/fire-smoke-yolov8`, `xiazh0219/yolo26m-UAV-fire-smoke-detection` are tagged agpl-3.0 [SRC]). Some are mis-tagged MIT or Apache even though they are Ultralytics checkpoints. One example is **Pyronear's `yolo11s_rapid-raccoon` card, which says Apache-2.0 but shows `from ultralytics import YOLO`** [SRC]. Under Ultralytics' position, custom-trained weights are AGPL [SEARCH] → ❌ / ⚠️.
6. **Regulatory (India):** a camera analytic must **not** be sold as a fire detector or as a replacement for IS 2189 / NBC 2016 Part 4 detection. India adopted **IS/ISO 7240-29 (Video Fire Detectors)**. Certification consultants say BIS (ISI-mark) certification is mandatory for VFDs under the **Fire Detection and Alarm Systems (Quality Control) Order, 2025** [SEARCH; UNVERIFIED against the Gazette]. Position the feature as a *supplementary visual alert*. In the US, NFPA 72 requires VISD to be *listed* (UL 268B) [SEARCH].
7. **Competitor reality check:** every serious gun-detection vendor puts **humans in the loop** (ZeroEyes, Omnilert, Eagle Eye's "triple-layer verification"). Public failures include the following:
   - The FTC acted against Evolv in Nov 2024: a 7-inch knife was missed, and raising sensitivity produced about 50% false alarms [SEARCH].
   - Omnilert missed the Antioch HS shooter's gun in Jan 2025 and has been sued [SEARCH].
   - Omnilert flagged a Doritos bag as a gun in Oct 2025, and the student was handcuffed even though the alert had been cancelled within 2 minutes [SEARCH].

---

## 2. Fire & smoke

### 2.1 Pretrained models / repos

| Model / repo | Code licence | Weights licence | Framework | Training data | Verdict | ONNX | Reported accuracy |
|---|---|---|---|---|---|---|---|
| pedbrgs/Fire-Detection (D-Fire authors): YOLOv5 + temporal AVT/TPT | MIT [SRC] | YOLOv5 checkpoints (Ultralytics YOLOv5 = GPL-3.0 then AGPL-3.0) | YOLOv5 | D-Fire | ⚠️/❌ for the weights (Ultralytics-derived). ✅ to **re-implement the AVT/TPT temporal ideas** | Possible but irrelevant | D-Fire mAP@0.5 79.1 ± 0.36 (AP smoke 85.9, AP fire 72.3). Temporal stage reduces FPR "with no significant impact" on TPR [SEARCH] |
| Pyronear `pyronear/yolo11s_rapid-raccoon_v8.1.0` (used by pyro-engine) | pyro-engine Apache-2.0 [SRC] | HF card says apache-2.0, but the card's usage example is `from ultralytics import YOLO` and the architecture is yolo11s [SRC] | Ultralytics YOLO11 | pyro-dataset (wildfire smoke) | ❌ as-is (Ultralytics AGPL claim on trained weights; contradicts the tag). Contact Pyronear / Ultralytics if wanted | Yes (onnx_cpu.tar.gz in repo [SRC]) | Not on card |
| pyronear/pyro-vision | Apache-2.0 [SRC] | Older classification models (UNVERIFIED per checkpoint) | PyTorch | Pyronear data | ⚠️ check each checkpoint | Yes (ONNX mentioned in repo description) | n/a |
| HF `rabahdev/fire-smoke-yolov8n`, `mfranzon/fire-smoke-yolov8`, `xiazh0219/yolo26m-UAV-fire-smoke-detection`, `SavithaVijayarangan/wildfire-edge-sentinel-detector` | n/a | **agpl-3.0** tags [SRC] | Ultralytics | various Roboflow/Kaggle sets | ❌ | — | — |
| HF `elvinguseinov/wildfire-detection-yolo11-yolo26-nano` | — | tagged MIT, library ultralytics [SRC] | Ultralytics | — | ❌ (mis-tagged Ultralytics derivative) | — | — |
| PaddleDetection PP-YOLOE fire/smoke | Apache-2.0 [SRC] | **No official fire/smoke checkpoint found** in the current repo tree (only a "smoking" (cigarette) model under pphuman) [SRC] | Paddle | — | n/a. PP-YOLOE itself is Apache and could be a base, but it adds a Paddle→ONNX toolchain | Paddle2ONNX | — |
| ICIAP ONFIRE 2023 winner (AI-FIREBUSTERS/ICIAP_ONFIRE) | UNVERIFIED | UNVERIFIED | — | ONFIRE training set (MIVIA, KMU, D-Fire…) | UNVERIFIED | — | Contest results paper exists [SEARCH] |
| AI For Mankind "Super Duper" wildfire smoke models | — | — | — | HPWREN-annotated smoke | ❌ (annotations CC BY-NC-SA [SRC]) | — | Detected real fires 3–13 min after ignition in examples [SRC] |
| Hikvision/Dahua camera-native fire/smoke (thermal and visible) | proprietary | — | on-camera | — | Integrate their events via ONVIF/SDK rather than replicate | — | Vendor claims only |

**Takeaway:** there is no pretrained fire/smoke model we can ship as-is. Train our own on clean data. The engineering value in the existing repos is in the **temporal-verification methods** (AVT, TPT, background-subtraction gating as in Gragnaniello et al.'s FLAME, 2024), which are ideas we can re-implement.

### 2.2 Classifier vs detector vs temporal

- **Frame classifier (fire / smoke / none):** cheap, but gives no location, so it can't do zone masks. It is fragile with small early fires.
- **Detector (boxes):** needed for zones, for small ignition points and for VMS overlays. D-Fire and FASDD are box-annotated.
- **Temporal stage (essential):** this is where most false alarms get removed.
  - Persistence: N of M frames inside a T-second window (TPT).
  - Box area / centroid variation: flames flicker and smoke grows and drifts (AVT).
  - Motion gating: reject stationary fire-coloured objects using background subtraction (FLAME 2024).
  - Optionally, a second-stage crop classifier or VLM ("FIRE-TASTIC": a detector proposes, a zero-shot VLM rejects look-alikes [SEARCH]).
- Evidence:
  - ONFIRE 2023 used a private test set with moving fire-like negatives. Methods trained on the standard public sets could not reach Recall >95% together with Precision above about 50% [SEARCH].
  - Gragnaniello et al. note that the contest winner had roughly 20% FPR [SEARCH].
  - An **ONFIRE 2025 (fire and smoke)** edition also exists [SEARCH].

### 2.3 Fire & smoke datasets

| Dataset | Size / content | Licence | Image provenance | Verdict |
|---|---|---|---|---|
| **D-Fire** (Gaia / UFMG) | 21,527 images: 1,164 fire-only, 5,867 smoke-only, 4,658 both, 9,838 none. 14,692 fire boxes and 11,865 smoke boxes. YOLO format. Plus some surveillance videos | **CC0 1.0** [SRC]. The LICENSE says the images are "a collection of images in the public domain which we do not have copyrights over" | Mixed; partly web / public domain per authors | ✅ (best clean core set). Note the authors' own disclaimer about copyright. Kaggle mirror: sayedgamal99/smoke-fire-detection-yolo |
| **FASDD** (FASDD_CV / UAV / RS) | 122,634 samples (70,581 positive, 52,073 negative). FASDD_CV is 95,314 images | **CC BY 4.0** on Science Data Bank (doi 10.57760/sciencedb.j00104.00103) [SEARCH] | Existing open datasets, social media, CG paintings and **web-crawler images** [SEARCH] | ⚠️ licence OK, provenance risk on crawled and social-media images. Use for training if Legal accepts; prefer it for evaluation |
| **Pyro-SDIS** (Pyronear) | 12,378 images (10,744 with smoke, 12,137 instances, **1,634 real system false positives**). Outdoor wildfire | **Apache-2.0** [SRC] | Pyronear's own cameras with French SDIS fire services [SRC] | ✅ (clean provenance; outdoor and wildfire only) |
| PyroNear-2024 / -2025 (arXiv 2402.05349) | ~50k images, 150k annotations, 400 fires; images and video sequences | Pyro-SDIS part Apache [SEARCH]; the web-scraped part UNVERIFIED | Partly **web-scraped public camera videos** [SEARCH] | ⚠️ |
| **DFS** (Wu et al. 2022) | 9,462 images; fire, smoke, plus an **"other" class for fire-like objects**; VOC | **No licence** in the repo [SRC] | "Collected from real scenes" (unspecified) | ❌ (no licence). Ask the authors; the "other" class idea is useful |
| **FIRESENSE** (FP7) | Videos: flame 11 positive / 16 negative; smoke 13 positive / 9 negative | **CC BY 4.0** on Zenodo 836749 [SEARCH] | Project-recorded | ✅ for video evaluation (small) |
| **MIVIA / Foggia fire & smoke videos** | Fire: 31 videos (14 fire, 17 non-fire, by most counts). Smoke set: ~149 videos (UNVERIFIED counts) | Terms not retrievable; site blocked → UNVERIFIED | Lab and web videos | ⚠️ evaluation only after written permission |
| ONFIRE 2023 training set | 322 videos assembled from public sets (MIVIA, KMU, D-Fire…) [SEARCH] | Inherits sources; UNVERIFIED | Mixed | ⚠️ evaluation only |
| **BoWFire** (USP, 2015) | 226 images (119 fire / 107 non-fire incl. sunsets, red objects) | No licence found [SEARCH] | Web emergency images | ❌ for training. Good as a tiny hard-negative evaluation set with permission |
| **FLAME** (NAU, UAV) | 39k+ aerial frames, 2k masks, thermal | **"Academic and non-commercial usage"**; repo LICENSE GPL-2.0 [SRC] | Own drone footage of prescribed burns | ❌ |
| FLAME 3 (2024) | Radiometric thermal UAV | UNVERIFIED | Own | UNVERIFIED (UAV, low relevance) |
| **Smoke100k** (Yuan Ze Univ.) | 100k synthetic smoke composites (Blender) on LabelMe/NYU backgrounds | **Non-commercial research only** [SEARCH] | Backgrounds from LabelMe/NYU | ❌ |
| **SKLFS / USTC** smoke sets | 36,104 smoke images; SKLFS-WildFire ~300k training frames | Terms on smoke.ustc.edu.cn; UNVERIFIED | Synthetic + real | ⚠️ UNVERIFIED; assume research-only until confirmed |
| **AI For Mankind HPWREN smoke boxes** | 744 (v1) and 2,192 (v2) annotated images, plus a cloud/fog negative set | Annotations **CC BY-NC-SA 4.0** [SRC] | HPWREN public cameras | ❌ (annotations NC). Raw HPWREN images: HPWREN asks only for attribution [SEARCH]; commercial terms UNVERIFIED |
| **HPWREN FIgLib** | ~25k labelled images, 80-minute sequences per fire | "CC BY" seen in a search snippet, possibly the paper's licence → UNVERIFIED | HPWREN cameras | ⚠️ |
| GWFP (arXiv 2606.10174, 2026) | Large wildfire image+video set | CC BY 4.0 [SEARCH] | UNVERIFIED | ⚠️ check provenance |
| Fire Recognition Image Dataset (Data in Brief, Apr 2026) | 1,112 images: real fire, smoke, "safe fire", artificial fire | Article CC BY 4.0 [SEARCH]; data licence UNVERIFIED | UNVERIFIED | ⚠️ useful "safe fire" (candles/stoves) negatives |
| Simuletic CCTV Smoke & Fire (HF) | 220 synthetic early-ignition images (bin fires, smouldering), descriptions not boxes | **CC BY-NC 4.0** [SRC] | Synthetic | ❌ (full 2k set is commercial; quote needed) |
| HF `Vertex-Test/FireSmokeDataset`, `baizhanquan/firesafety-fire-smoke` | — | apache-2.0 tags [SRC] | Unknown re-uploads | ⚠️ provenance unknown |
| Roboflow Universe fire/smoke sets (e.g. METU 15,345 imgs; DataCluster Labs; "synthetic fire-smoke" Yunnan Univ.) | Various | Mostly uploader-chosen **CC BY 4.0** [SEARCH] | Typically scraped web / YouTube / other datasets | ⚠️ the licence label doesn't cover the underlying images. Evaluation only, or after per-set provenance review |
| Kaggle fire sets | Various | Varies (often "Other"/unknown) | Mostly scraped | ⚠️/❌ per set |

### 2.4 Typical false alarms to stage or collect (fire/smoke, India-specific)

- **Fire look-alikes:**
  - Diyas and agarbatti; puja and havan; Diwali lamps and fireworks; Holi colours.
  - Chulhas, tandoors, street-food stalls; welding and grinding sparks; furnace mouths in factories.
  - Sodium-vapour and LED orange lighting; sunsets and sunrises reflected on glass; vehicle tail and brake lights; rotating beacons.
  - Saffron, red and orange clothing (saris, uniforms, flags); orange safety vests; marigold garlands.
- **Smoke look-alikes:**
  - Steam from tea stalls, kitchens and cooling towers; locomotive and DG-set exhaust; vehicle exhaust.
  - Winter fog and smog (North India, Dec–Feb); dust from construction, unloading and train passage.
  - Mosquito-fogging machines; incense; cigarette smoke; cloud and haze at outdoor sites.
  - Camera artefacts: lens dirt, cobwebs, IR-night bloom, compression blocks.
- **Thermal channel (if the camera has one):** hot machinery, sun-heated roofs, vehicles. These are handled by the camera vendors' own thresholds.

---

## 3. Weapons

### 3.1 Pretrained weapon models

| Model | Licence | Framework | Verdict |
|---|---|---|---|
| HF `cosgun99/gun-knife-yolo11n` | tagged MIT, library ultralytics [SRC] | Ultralytics | ❌ (Ultralytics derivative) |
| HF `akhil0238/Weapon_Detection` | tagged MIT, ultralytics [SRC] | Ultralytics | ❌ |
| HF `NabilaLM/detr-weapons-detection` | no licence [SRC] | transformers DETR | ❌ (no licence) |
| CCTV-Gun benchmark models (srikarym/CCTV-Gun) | Code Apache-2.0 (mmdetection fork) [SRC]; trained on USRT (NC) + MGD + UCF | mmdet | ❌ for weights (NC data). ✅ to reuse the **cross-dataset evaluation protocol** |
| Monash-Guns-Dataset repo (M2Det) | Code MIT [SRC] | PyTorch | ❌ for weights/data (no data licence) |
| Most Roboflow / GitHub "weapon detection" models | Ultralytics YOLOv5/8/11 | — | ❌ (AGPL) unless confirmed otherwise |

**No pretrained weapon model is usable.** We must fine-tune our own.

### 3.2 Weapon datasets

| Dataset | Size / content | Licence | Provenance | Verdict |
|---|---|---|---|---|
| **OD-WeaponDetection** (DaSCI, Univ. Granada; Pérez-Hernández, Olmos, Tabik et al.) | Pistol detection ~3,000 images (VOC); knife detection ~2,078 images; pistol and knife classification sets; **Sohas** (pistol, knife, bill, purse, smartphone, card), which is a useful *hard-negative* set of objects held like weapons [SRC] | **Conflict:** License.md = **CC BY 4.0**; README badge and text = **CC BY-SA 4.0** [SRC]. Some files were withheld "for anonymization of personal data" [SRC] | Mostly internet images plus some recorded video frames (UNVERIFIED split) | ⚠️ (CC BY-SA on *data* probably doesn't infect model weights, but that is a legal call; web-image provenance) |
| **US Real-time Gun Detection in CCTV** (Salazar-González et al., Univ. Sevilla, Neural Networks 2020) | **Mock Attack**: 5,149 full-HD frames from 3 real CCTV cameras during a permitted university drill. **Unity synthetic**: splits of 500 / 1,000 / 2,500 images with 11 objects (4 handguns, 5 rifles, knife, smartphone) [SEARCH] | **CC BY-NC 4.0** [SRC]: "academic research free of charge… commercial purposes please contact" (jaalvarez@us.es). HF mirror `jsalazar/...` also cc-by-nc-4.0 [SRC] | Staged with permissions; synthetic | ❌ unless a commercial licence is negotiated (worth asking; it is the closest match to our domain) |
| **YouTube-GDD** (UCAS) | 5,000 images from 343 YouTube videos; 16,064 gun and 9,046 person boxes [SRC] | Repo LICENSE Apache-2.0 covers *code/labels*; there is **no grant for the images**, which are YouTube frames [SRC] | YouTube | ❌ |
| **Monash Guns Dataset (MGD)** | ~2,500 to 7,780 images depending on the source; 1920×1080 staged CCTV (UNVERIFIED counts) | Repo has no data licence (MIT for M2Det code) [SRC]. A Roboflow re-upload claims CC BY 4.0 [SEARCH] | Staged CCTV | ❌/⚠️ (re-uploader can't grant rights) |
| **ACF – Armed CCTV Footage** (Mahidol Univ., Sensors 2022) | 8,319 images: handguns, knives, short rifles; staged in the Faculty of Engineering under permits [SEARCH] | CC BY 4.0 per search (may be the article licence, not the data) → UNVERIFIED | Own staged footage | ⚠️ promising, confirm the data licence |
| **Firearm-related action recognition & detection** (UCLM; Data in Brief 2024) | 398 videos; classes Handgun, Machine_Gun, No_Gun; COCO JSON | **Conflict:** Mendeley v2 = CC BY-NC 3.0 [SEARCH]; Zenodo 15387426 = CC BY 4.0 [SEARCH] | Own recordings | ⚠️ get written confirmation of the CC BY 4.0 Zenodo copy |
| **CCTV-Gun** benchmark | Re-annotated subsets of MGD, USRT and UCF-Crime | Inherits sources (NC / none) | — | ❌ data; ✅ protocol idea |
| **AGH Knives Image Database** (Grega & Matiolanski, Sensors 2016) | 12,899 crops of 100×100 px (3,559 positive) | "Free in any scientific work"; commercial use requires contacting the authors [SEARCH] | CCTV recordings | ❌ without permission |
| **Simuletic samples** (HF/Kaggle) | `cctv-weapon-dataset` (person + weapon, sample); `cctv-knife-detection-dataset` (114 images) | **CC BY 4.0** [SRC] | Fully synthetic (generator unspecified: UNVERIFIED whether 3D-rendered or diffusion) | ✅ but tiny; useful for smoke-testing pipelines |
| Simuletic `CCTV_Weapon_Detection_Rifles_vs_Umbrellas` | Rifles vs closed umbrellas (hard negatives) | HF metadata **cc-by-nc-4.0**, body text says CC BY 4.0 [SRC] → conflict | Synthetic | ⚠️ ask Simuletic |
| Simuletic `CCTV_ATM_Robbery_Detection_Dataset_Gun_Knife`, `Surveillance-VLM-Weapon-Knife` | — | CC BY-NC 4.0 / CC BY-SA 4.0 [SRC] | Synthetic | ❌ / ⚠️ |
| HF `Subh775/WeaponDetection`, `Turki-Alshuaibi/haris-weapon-detection-dataset-curated` | — | cc-by-4.0 tags [SRC] | Unknown / likely aggregated web sets | ⚠️ provenance |
| Roboflow Universe weapon sets ("Gun and Knife Detection" 8,451 images; NTUT 3,000 incl. baseball bat; "Weapon_Detector 1.0" 5,064) | — | uploader-chosen CC BY 4.0 [SEARCH] | Typically scraped web / movie / YouTube frames | ⚠️ evaluation only |
| **Weapon7** (axe, bow and arrow, gun, knife, **lathi**, pistol, sword) | — | "Shared upon individual request" [SEARCH] | Public sets + internet + own capture | ❌ without an agreement |
| **India blunt objects** (arXiv 2606.05708, 2026) | 336 smartphone frames: iron_rod, wooden_rod, plastic_rod, merged with a gun/knife set into 7,959 images | UNVERIFIED | Own capture in India | ⚠️ contact authors; confirms the gap |
| **COCO "knife"** | Mostly kitchen/table knives in dining scenes | COCO annotations CC BY 4.0; images under Flickr with mixed licences (some NC) | Flickr | Not a weapon class. Useful only as a pretraining prior; it will fire on cutlery |

**Indian edged and blunt tools (machete/koyta, sickle/darati, lathi/rod): no usable public dataset exists.** Context matters a lot here. Sickles and lathis are ordinary tools for farmers, gardeners, security guards and RPF/police (lathis). Recommend these as **"object present in restricted zone" alerts**, configured per camera, not as "threat" classifications.

### 3.3 Synthetic data approaches and their licences

| Approach | Licence considerations | Notes |
|---|---|---|
| Unity / Unreal rendered CCTV scenes (Salazar-González: +0.8 AP on small objects with 500 Unity images [SEARCH]) | Engine output is generally ours (Unity/Unreal EULAs; check the current EULA terms). **3D asset licences** (weapon and character models from marketplaces) must allow ML-training use. UNVERIFIED per asset | Best for controllable pose, distance, angle and lighting; there is a domain gap, so always fine-tune on real data last |
| Commercial synthetic vendors (Simuletic, others) | Per-contract | Free samples are CC BY; the full sets need a quote |
| Diffusion-generated / inpainted weapons (e.g. SDXL, OpenRAIL++) | The model's licence must allow commercial output (SDXL OpenRAIL++ does, with use restrictions; FLUX.1-dev is non-commercial). Output-copyright status varies by jurisdiction | Quality control is hard: hands and grips are often wrong. Better used for hard-negative backgrounds |
| Copy-paste augmentation of segmented weapon cut-outs onto our own CCTV frames | Cut-outs must come from licensed images (our own photos of replicas) | Cheap and effective for small objects |

### 3.4 Accuracy evidence (weapons)

- YouTube-GDD, YOLOv5s: gun AP50 67.7 from scratch, 75.0 with transfer, 77.3 with context [SEARCH]. These are dynamic, close-up YouTube frames, not CCTV.
- Salazar-González: Faster R-CNN FPN R50, ~90 ms on a GTX-1080Ti. Synthetic pretraining helps small objects; they evaluated at confidence 0.99 to suppress FPs [SEARCH].
- CCTV-Gun introduced cross-dataset evaluation precisely because intra-dataset numbers overstate real performance (exact numbers not retrieved → UNVERIFIED).
- Field reality: Actuate's "99%" is reportedly conditioned on a gun brandished for about 5 s. Documented false positives include an arm shadow and prop guns in a theatre rehearsal [SEARCH]. Scylla claims 0.1 false positives per camera per day for guns (vendor claim) [SEARCH].

---

## 4. Detector bases for fine-tuning (licence check)

| Base | Code | Weights | Pretraining-data caveat | ONNX | Verdict |
|---|---|---|---|---|---|
| **YOLOX** (already shipped) | Apache-2.0 | Apache-2.0 (COCO) | COCO images are Flickr, mixed licences | Yes | ✅ fastest path, known CPU cost |
| **RF-DETR N/S/M/L** (+Seg N–XL) | Apache-2.0 [SRC] | Apache-2.0 [SRC] | **Objects365 pretraining** (60 epochs) on a DINOv2 backbone [SEARCH] | Yes: `model.export()` → ONNX; CPU cookbook in repo [SRC] | ✅ licence-wise; ⚠️ O365 data question |
| RF-DETR XL / 2XL | — | **PML 1.0** [SRC] | — | — | ❌ (not Apache) |
| **D-FINE** N/S/M/L/X | Apache-2.0 [SRC] | COCO-only checkpoints, plus `_obj365` / `_obj2coco` checkpoints | README: Objects365 checkpoints "should not be assumed to be commercially cleared" [SRC] | Yes: `tools/deployment/export_onnx.py` [SRC] | ✅ **use the COCO-only checkpoints** |
| **DEIM (v1)** | Apache-2.0 (Intellindust) [SRC] | Apache | Same O365 issue for O365 variants | Yes: `export_onnx.py` [SRC] | ✅ (COCO-only weights) |
| **DEIMv2** | **DEIMv2 License: non-commercial; commercial use requires a separate licence** (2026) [SRC] | Same | DINOv3 backbone (Meta DINOv3 licence, separate) | — | ❌. HF mirrors tagged apache-2.0 (e.g. `harshaljanjani/DEIMv2_*`) are mis-labelled |
| **RT-DETR / RT-DETRv2** (lyuwenyu) | Apache-2.0 [SRC] | Apache | Some checkpoints use COCO+Objects365 | Yes: `export_onnx.py`, ORT example [SRC] | ✅ (avoid the Ultralytics RT-DETR port, which is AGPL) |
| PP-YOLOE (PaddleDetection) | Apache-2.0 [SRC] | Apache | O365 variants exist | via Paddle2ONNX | ✅ but adds a toolchain |

**CPU realism:** RF-DETR-Small measured **~360 ms per frame end-to-end** on ONNX Runtime CPU (shared Colab vCPU, batch 1, 2.8 FPS) in Roboflow's own cookbook [SRC]. On a 4–8-core server, plan for roughly 2–6 FPS per model instance (UNVERIFIED for our hardware). Fire and weapon analytics should therefore run at **1–3 FPS per camera on motion-gated frames**, or on GPU. Weapon detection needs high resolution (guns are often under 20 px), so use person-crop tiling rather than full-frame upscaling.

---

## 5. Recommended build plan

### 5.1 Fire & smoke (target: v1 shippable as "visual fire/smoke alert, operator-verified")

1. **Model:** fine-tune **YOLOX-S** (already shipped) *and* **D-FINE-S (COCO weights)** or **RF-DETR-S** if Legal clears O365. Use two classes (`fire`, `smoke`) plus an optional `fire_like` / `other` negative class (DFS idea) to absorb lamps, sunsets and clothing. Input 640.
2. **Training data:**
   - Core: D-Fire (CC0) + Pyro-SDIS (Apache) + our own staged and collected data.
   - Optional: FASDD_CV (CC BY 4.0) if Legal accepts its crawled-image provenance.
   - Exclude anything NC or unlicensed (DFS, Smoke100k, FLAME, AI For Mankind, Simuletic NC).
3. **Data to collect ourselves (the key differentiator):**
   - Controlled burns with customer or fire-service cooperation: drum, bin, cable-tray, pallet, vehicle-tyre and electrical-panel fires.
   - Theatrical/fog-machine smoke (it looks unlike real smoke, so use sparingly) and smoke candles.
   - Filmed on **real deployed cameras**: typical Indian CCTV, 2–4 MP, H.264/H.265, IR night mode, 3–8 m mounting.
   - At least **500–1,000 camera-hours of negative video** per vertical (factory, railway platform, yard, campus, office), covering the India-specific look-alikes in §2.4, with winter fog/smog and Diwali/Holi periods specifically.
   - Mine the false positives (the Pyro-SDIS approach) and loop them back as hard negatives.
4. **Temporal verifier (rule-based first, no training needed):**
   - Motion/background-subtraction gate: a candidate box must overlap foreground for fire; smoke may be slow, so use a longer-window difference.
   - Persistence: about 5 of 8 sampled frames over 4–8 s for fire; 10–30 s for smoke.
   - Area and centroid variation statistics (flicker for fire, upward growth and drift for smoke).
   - Per-camera exclusion masks and schedules (e.g. welding bay, kitchen, puja room).
   - Optional crop verifier: a small CNN, or SigLIP 2 text-vs-crop, run only on candidates.
5. **Evaluation (publish internally and be honest):**
   - Frame mAP on D-Fire test **and cross-dataset** (train D-Fire+Pyro, test FASDD_CV and our own). Expect large drops; the 2026 study saw 38–65 points.
   - **Event-level** precision/recall and **notification delay** (ONFIRE protocol) on FIRESENSE + MIVIA (with permission) + our own staged events.
   - **False alarms per camera per day** on the long negative footage, broken down by vertical and day/night. Set a release gate, e.g. ≤ 0.1 FA/camera/day at ≥ 90% event recall on staged fires (business decision).
6. **Product framing:**
   - "Supplementary visual fire/smoke alert; not a certified fire detection system (IS 2189 / IS/ISO 7240-29)". Alerts go to an operator with a clip.
   - Offer **camera-native thermal/bi-spectrum fire events** (Hikvision HeatPro, Dahua WizMind) as an integration for high-risk sites rather than building thermal analytics ourselves.

### 5.2 Weapons (target: "human-verified advisory" only)

1. **Architecture (two stages, person-centric):**
   1. Person detection with the existing YOLOX.
   2. Track the person; crop the upper body and hands at higher resolution (letterbox the crop to 512–640).
   3. Run a **weapon detector on crops**. Fine-tune RF-DETR-S or D-FINE-S (COCO). Classes: `handgun`, `long_gun`, `knife`, `machete/large_blade`, `sickle`, `rod/lathi`. Add explicit **confuser classes**: `phone`, `drill/tool`, `umbrella`, `bottle`, `wallet`, `torch`, `walkie-talkie`, `stick/broom`, `flag_pole`.
   4. Optional: a pose model to require the object to be in or near a hand (the Ruiz-Santaquiteria "pose + appearance" idea).
   5. **Temporal persistence**: at least k detections on the same track within about 2 s.
   6. Send to the VMS operator with a clip; never auto-dispatch.
2. **Data:**
   - **Staged collection is mandatory.** Use replica/airsoft pistols and rifles, real knives, koyta/machete, sickle, lathi, iron and PVC rods. Film with actors on customer cameras at 3–8 m height across distances (2–25 m), angles, day/night IR, crowding, and partial concealment (waistband, bag).
   - Get **written consent and model releases** from actors. Coordinate with site security and local police before staging (replica guns cause real responses). Check Arms Act / state rules for replicas (legal review).
   - Mix in Unity/Unreal synthetic renders (own scenes, licensed assets) for rare angles and small objects, plus copy-paste augmentation.
   - Optional: OD-WeaponDetection after legal review of the BY vs BY-SA conflict; the Sohas hard negatives are especially useful.
   - Try to **license**: US Real-time Gun / Mock Attack + Unity (Sevilla, NC; ask for commercial terms), ACF (Mahidol), the UCLM firearm-action set (Zenodo CC BY 4.0 copy, confirm), Simuletic full sets.
3. **Evaluation:**
   - AP by **object pixel size** (<16, 16–32, 32–96 px).
   - **Cross-site** evaluation: train on sites A–C, test on D.
   - **FP per camera per day** on ≥ 1,000 camera-hours of normal footage per vertical (railway platforms with umbrellas, tools and phones; factories with drills and pipes; campuses).
   - **Time-to-alert** after brandishing.
   - Publish a "known limitations" sheet: concealed weapons are not detectable; small or distant guns are unreliable; holstered police and RPF weapons will trigger, so zone or uniform rules are needed.
4. **Indian edged/blunt tools:** treat these as zone policies ("sickle/rod present in platform zone after 22:00"). Don't present them as threat detection; there are too many legitimate carriers.

---

## 6. Open-vocabulary / zero-shot quick path

| Model | Licence | ONNX | CPU feasibility | Fire/weapon evidence | Verdict |
|---|---|---|---|---|---|
| **OWL-ViT B/32** (`google/owlvit-base-patch32`) | Apache-2.0 [SRC] | Yes: `Xenova/owlvit-base-patch32`, `onnx-community/owlvit-base-patch32-ONNX` [SRC] | Fastest of this group; roughly hundreds of ms to 1 s per 768 px image on 4–8 cores (UNVERIFIED) | None published for fire or weapons | ✅ quick prototype |
| **OWLv2 B/16 ensemble** | Apache-2.0 [SRC] | Yes: `Xenova/owlv2-base-patch16-ensemble` [SRC] | Heavier (960 px input); likely 1–3 s per image on CPU (UNVERIFIED) | None found | ✅ verifier on crops / GPU |
| **Grounding DINO tiny/base** (IDEA) | Apache-2.0 code and weights [SRC] | Yes: `onnx-community/grounding-dino-tiny-ONNX` [SRC] | Swin-T + BERT; seconds per image on CPU (UNVERIFIED) | None found for fire/weapons | ⚠️ licence OK; pretraining included O365/GoldG/Cap4M |
| **MM-Grounding-DINO** (mmdetection) | Apache-2.0 [SEARCH]; HF `openmmlab-community/mm_grounding_dino_*` apache-2.0 [SRC] | Via mmdeploy (UNVERIFIED) | Similar to GDINO | — | ⚠️ same data caveat |
| **Grounding DINO 1.5 / 1.6 Pro/Edge, DINO-X** | API only, "no plan to release weights" [SEARCH] | No | Cloud API | — | ❌ for on-prem |
| **NVIDIA TAO Grounding DINO (commercial)** | NVIDIA EULA; "trained on commercial data… can be used commercially" [SEARCH] | Via TAO export (UNVERIFIED) | GPU-oriented | — | ⚠️ attractive for the data-provenance problem; read the EULA |
| **YOLO-World** | **GPL-3.0** [SRC] | — | Fast | — | ❌ |
| **YOLOE** | **AGPL-3.0** [SRC] (Ultralytics-based) | — | Fast | — | ❌ |
| **Florence-2 base/large** | MIT [SRC] | Yes: `onnx-community/Florence-2-base-ft` [SRC] | Seq2seq decoding; ~1–3 s per image on CPU (UNVERIFIED) | — | ✅ captioning or verification on event snapshots |
| **SigLIP 2** (base/so400m) | Apache-2.0 [SRC] | Exportable (vision and text towers separate; UNVERIFIED community ONNX) | Base @224 is cheap per crop | — | ✅ **best fit as a crop verifier** ("handgun" vs "phone / drill / umbrella"; "fire" vs "orange light / sunset / sari") |

**Recommended quick path:**
1. Keep the existing YOLOX motion/person pipeline. On candidate crops only (motion blobs with fire colours, or hand regions of tracked persons), run SigLIP 2 text-vs-crop with positive and confuser prompts.
2. If the GPU is present, add OWLv2 on the crop.
3. Label alerts **"AI-suggested, unverified"** and route them to operators.
4. Use these alerts to **mine data** for the supervised models in §5.

Evidence that this works for false-alarm filtering is limited to FIRE-TASTIC (ACM 2025: a detector proposes, a zero-shot VLM rejects fire look-alikes) [SEARCH]. No published zero-shot AP for fire or weapon prompts was found → **UNVERIFIED; we must measure it ourselves** on the §5 evaluation sets before promising anything.

---

## 7. Commercial landscape

| Vendor | What they claim | Human-in-the-loop | Published FA rates / failures | Notes |
|---|---|---|---|---|
| **ZeroEyes** (US) | Visible-gun detection on existing cameras | Yes: every detection reviewed by analysts in Pennsylvania/Hawaii operations centres before dispatch [SEARCH] | No accuracy % published; FAQ says false positives "vary greatly depending on human activity" [SEARCH]. Third-party summary cites "0 false-positive dispatches 2026 YTD" (vendor-sourced) | The human centre is the product |
| **Omnilert** (US) | Gun detection "before a shot is fired" | Yes: human review | **Antioch HS, 22 Jan 2025**: the system did not flag the shooter's gun; lawsuit filed May 2026 alleging limitations were not disclosed [SEARCH]. **Kenwood HS, Oct 2025**: a Doritos bag flagged as a gun; reviewers cancelled within 2 min but the principal escalated, and police handcuffed the student [SEARCH] | Shows the alert workflow and UX matter as much as the model |
| **Evolv** (walk-through scanners, AI) | "Detects all weapons" (marketing) | — | **FTC complaint/settlement, Nov 26 2024**: deceptive accuracy claims; a 7-inch knife was missed (Oct 2022 stabbing); raising sensitivity produced ~50% false alarms; some K-12 contracts can be cancelled; unsubstantiated AI accuracy claims banned [SEARCH] | Key lesson for our marketing copy: **no unsubstantiated accuracy claims** |
| **Scylla** | Gun detection; "filters up to 99.95% of false alarms" (intrusion); 0.1 FP/camera/day for guns [SEARCH] | Optional | Vendor claims only | — |
| **Actuate** | "99% accuracy" gun detection [SEARCH] | Monitoring-centre partners | Reported caveat: 99% applies to guns brandished ~5 s; documented FPs from an arm shadow and prop guns [SEARCH] | — |
| **Eagle Eye Networks** | Gun detection launched 10 Oct 2025 | **Triple-layer**: edge AI → cloud AI → human review [SEARCH] | — | The edge-then-bigger-model-then-human pattern matches our proposed design |
| **Hikvision** | Visible-light smoke/fire algorithms; HeatPro bi-spectrum thermal fire detection; partner iThermAI (2024) [SEARCH] | — | Vendor claims to filter sun reflections and moving vehicles [SEARCH] | Integrate their events |
| **Dahua** | WizMind fire detection (up to 10 km, thermal); flame-detection IPC (HY-FT443HFP) [SEARCH] | — | — | Integrate their events |
| **Videonetics** (India) | Fire/smoke analytics "field-tested for rugged Indian environments"; 100+ cities, 80+ airports [SEARCH] | — | None published | Main Indian VMS competitor |
| **Staqu JARVIS** (India) | 50+ use cases including fire/smoke; audio-video fusion (gunshot, scream); 11 state police forces, UP prisons [SEARCH] | — | None published | Audio fusion is a differentiator |
| **AllGoVision** (India) | Smoke/fire early warning for outdoor, large indoor, oil & gas, datacentres; CPU and GPU; Milestone/Genetec integrations [SEARCH] | — | None published; weapon detection not confirmed | — |

### Regulatory notes

- **India, fire:**
  - NBC 2016 Part 4 and IS 2189 govern automatic fire detection and alarm (spot smoke/heat detectors, MCPs etc.) [SEARCH].
  - India has **IS/ISO 7240-29:2017 (Video Fire Detectors)**; ISO itself updated it to ISO 7240-29:2024 [SEARCH].
  - Certification consultants state that the **Fire Detection and Alarm Systems (Quality Control) Order, 2025 makes BIS ISI certification mandatory for VFDs** [SEARCH; UNVERIFIED in the Gazette].
  - Implication: if VigilOne markets a "video fire detector" as part of a fire alarm system, it may fall under QCO certification. Software-only VMS analytics marketed as a *supplementary alert* is the safer position. Legal should confirm.
- **US reference:** NFPA 72 (since 2007) requires VISD hardware and software to be *listed*; UL 268B is the investigation outline; FM has listed VISD to ANSI/UL 268 [SEARCH].
- **India, CCTV procurement:** STQC Essential Requirements certification for CCTV cameras has been mandatory since 9 Apr 2025, and for government procurement since June 2024 [SEARCH]. That covers cameras, not VMS software, but tender documents often reference it.
- **Railways:** the RDSO VSS specification (RDSO/SPN/TC/65) covers video analytics and face recognition. Coach fire detection uses aspiration-type smoke detection (RDSO/2008/CG-04) [SEARCH]. I found no RDSO acceptance of video fire detection (UNVERIFIED).
- **Privacy:** staged weapon datasets with actors need DPDP Act 2023 consent and retention handling.

---

## 8. Risks and decisions needing a human

1. **Objects365 / COCO pretraining.** Do we accept pretrained weights whose upstream data has academic or Flickr terms? This affects RF-DETR (all sizes, O365), D-FINE/DEIM/RT-DETR O365 checkpoints, Grounding DINO and, to a lesser degree, COCO everywhere (including our shipped YOLOX). Options:
   - (a) accept, as the industry generally does;
   - (b) use COCO-only checkpoints;
   - (c) ImageNet-only backbones and train detection heads on our own data;
   - (d) NVIDIA TAO "commercial" models.
2. **CC BY-SA datasets (OD-WeaponDetection)** and **conflicting labels** (Granada BY vs BY-SA; UCLM Mendeley NC vs Zenodo BY; Simuletic umbrella NC vs BY). These need legal interpretation or written confirmation from the authors.
3. **Web-scraped images under CC BY labels** (FASDD_CV, Roboflow Universe, HF re-uploads). Decide whether to use them for training, for evaluation only, or not at all.
4. **Negotiate commercial licences?** Candidates: US Real-time Gun / Mock Attack (Sevilla), ACF (Mahidol), MIVIA, Simuletic full sets, Pyronear.
5. **Staging weapons on customer sites:** police coordination, replica-gun legality, actor consent and insurance.
6. **Marketing claims:** after the Evolv FTC order, publish only measured, scoped numbers ("X false alerts per camera-day on N camera-hours at site type Y"). Never "detects all weapons/fires".
7. **Product positioning:** fire as a "supplementary alert, not a fire alarm system" (QCO / IS 2189 exposure); weapons as "advisory, human-verified, no auto-dispatch".
8. **Operator workflow:** the Kenwood incident shows that cancelled alerts must propagate to everyone who was notified. Design acknowledge/cancel states into the VMS alarm model.
9. **Compute budget:** transformer detectors take about 360 ms per frame on CPU. Decide the per-camera FPS budget and whether to require a GPU for weapons.
10. **Edged-tool classes** (sickle, lathi): agree that these are zone-policy alerts, not threat claims.

---

## 9. Sources

### Read directly (repos and cards) [SRC]
- D-Fire: https://github.com/gaiasd/DFireDataset (LICENSE CC0, README)
- D-Fire models / hybrid temporal: https://github.com/pedbrgs/Fire-Detection (MIT)
- OD-WeaponDetection: https://github.com/ari-dasci/OD-WeaponDetection (License.md CC BY 4.0; README CC BY-SA 4.0)
- US Real-time Gun Detection: https://github.com/Deepknowledge-US/US-Real-time-gun-detection-in-CCTV-An-open-problem-dataset (CC BY-NC 4.0); HF mirror https://huggingface.co/datasets/jsalazar/US-Real-time-gun-detection-in-CCTV-An-open-problem-dataset
- YouTube-GDD: https://github.com/UCAS-GYX/YouTube-GDD
- Monash Guns: https://github.com/MarcusLimJunYi/Monash-Guns-Dataset
- CCTV-Gun: https://github.com/srikarym/CCTV-Gun
- DFS: https://github.com/siyuanwu/DFS-FIRE-SMOKE-Dataset
- AI For Mankind wildfire smoke: https://github.com/aiformankind/wildfire-smoke-dataset
- FLAME UAV: https://github.com/AlirezaShamsoshoara/Fire-Detection-UAV-Aerial-Image-Classification-Segmentation-UnmannedAerialVehicle
- Pyronear: https://github.com/pyronear/pyro-engine, https://github.com/pyronear/pyro-vision, https://github.com/pyronear/pyro-dataset, https://huggingface.co/pyronear/yolo11s_rapid-raccoon_v8.1.0, https://huggingface.co/datasets/pyronear/pyro-sdis
- RF-DETR: https://github.com/roboflow/rf-detr (README licence table, docs/cookbooks/export-cpu.ipynb)
- D-FINE: https://github.com/Peterande/D-FINE (README Objects365 licence note)
- DEIM: https://github.com/ShihuaHuang95/DEIM ; DEIMv2: https://github.com/Intellindust-AI-Lab/DEIMv2 (LICENSE.md non-commercial)
- RT-DETR: https://github.com/lyuwenyu/RT-DETR
- YOLO-World: https://github.com/AILab-CVC/YOLO-World (GPL-3.0); YOLOE: https://github.com/THU-MIG/yoloe (AGPL-3.0)
- Grounding DINO: https://github.com/IDEA-Research/GroundingDINO
- PaddleDetection: https://github.com/PaddlePaddle/PaddleDetection
- HF models: https://huggingface.co/google/owlv2-base-patch16-ensemble, https://huggingface.co/google/owlvit-base-patch32, https://huggingface.co/Xenova/owlv2-base-patch16-ensemble, https://huggingface.co/Xenova/owlvit-base-patch32, https://huggingface.co/IDEA-Research/grounding-dino-tiny, https://huggingface.co/onnx-community/grounding-dino-tiny-ONNX, https://huggingface.co/openmmlab-community/mm_grounding_dino_large_all, https://huggingface.co/microsoft/Florence-2-base, https://huggingface.co/onnx-community/Florence-2-base-ft, https://huggingface.co/google/siglip2-base-patch16-224, https://huggingface.co/jameslahm/yoloe, https://huggingface.co/rabahdev/fire-smoke-yolov8n, https://huggingface.co/mfranzon/fire-smoke-yolov8, https://huggingface.co/xiazh0219/yolo26m-UAV-fire-smoke-detection, https://huggingface.co/cosgun99/gun-knife-yolo11n, https://huggingface.co/akhil0238/Weapon_Detection, https://huggingface.co/harshaljanjani/DEIMv2_DINOv3_S_COCO_Transformers
- HF datasets: https://huggingface.co/datasets/Simuletic/cctv-weapon-dataset, https://huggingface.co/datasets/Simuletic/cctv-knife-detection-dataset, https://huggingface.co/datasets/Simuletic/CCTV_Weapon_Detection_Rifles_vs_Umbrellas, https://huggingface.co/datasets/Simuletic/CCTV-Smoke-Fire-Emergency-Detection-Dataset, https://huggingface.co/datasets/Subh775/WeaponDetection

### From search results [SEARCH] (primary page not opened by me)
- Objects365 terms: https://www.objects365.org/download.html
- FASDD: https://essd.copernicus.org/preprints/essd-2023-73/essd-2023-73.pdf ; https://www.scidb.cn/en/detail?dataSetId=ce9c9400b44148e1b0a749f5c3eb0bda ; https://www.tandfonline.com/doi/full/10.1080/10095020.2024.2347922
- DFS paper: https://dl.acm.org/doi/10.1007/s11042-022-13580-x
- FIRESENSE: https://zenodo.org/records/836749
- MIVIA: https://mivia.unisa.it/datasets/video-analysis-datasets/fire-detection-dataset/ ; ONFIRE 2023: https://mivia.unisa.it/onfire2023/ ; https://link.springer.com/article/10.1007/s12652-024-04939-z ; ONFIRE 2025: https://link.springer.com/chapter/10.1007/978-3-032-11381-8_46
- FLAME (video, 2024): https://link.springer.com/article/10.1007/s00521-024-10963-z
- Hybrid spatial-temporal fire detection: https://dl.acm.org/doi/10.1007/s00521-023-08260-2
- Cross-dataset YOLOv8 fire study (2026): https://www.mdpi.com/2504-446X/10/8/635
- FIRE-TASTIC zero-shot VLM fire: https://dl.acm.org/doi/10.1145/3721291
- Fire datasets review: https://arxiv.org/html/2503.14552v1
- BoWFire: https://arxiv.org/pdf/1506.03495
- FLAME UAV dataset: https://ieee-dataport.org/open-access/flame-dataset-aerial-imagery-pile-burn-detection-using-drones-uavs
- Smoke100k: https://bigmms.github.io/cheng_gcce19_smoke100k/
- SKLFS/USTC: http://smoke.ustc.edu.cn/
- HPWREN: https://www.hpwren.ucsd.edu/news/20180501/ ; FIgLib: https://www.hpwren.ucsd.edu/FIgLib/ ; https://arxiv.org/pdf/2112.08598
- PyroNear-2024/2025: https://arxiv.org/abs/2402.05349
- GWFP: https://arxiv.org/html/2606.10174v1
- Fire Recognition Image Dataset: https://pmc.ncbi.nlm.nih.gov/articles/PMC13157024/
- Salazar-González 2020: https://www.sciencedirect.com/science/article/abs/pii/S0893608020303361 ; https://deepknowledge-us.github.io/US-Real-time-gun-detection-in-CCTV-An-open-problem-dataset/
- ACF: https://www.mdpi.com/1424-8220/22/19/7158
- CCTV-Gun: https://arxiv.org/abs/2303.10703
- UCLM firearm action dataset: https://data.mendeley.com/datasets/bbzpxhd22j/2 ; https://zenodo.org/records/15387426 ; https://pmc.ncbi.nlm.nih.gov/articles/PMC10827673/
- AGH Knives: http://kt.agh.edu.pl/~matiolanski/KnivesImagesDatabase/ ; https://www.mdpi.com/1424-8220/16/1/47
- YouTube-GDD paper: https://arxiv.org/pdf/2203.04129
- Weapon7: https://link.springer.com/article/10.1007/s11760-024-03458-w
- India blunt-object dataset: https://arxiv.org/html/2606.05708v1
- Granada weapons project: https://sci2s.ugr.es/weapons-detection
- Roboflow Universe examples: https://universe.roboflow.com/middle-east-tech-university/fire-and-smoke-detection-hiwia , https://universe.roboflow.com/mahad-ahmed/gun-and-knife-detection , https://universe.roboflow.com/arms/the-monash-guns-dataset
- Ultralytics licence: https://www.ultralytics.com/license ; https://github.com/orgs/ultralytics/discussions/2127
- RF-DETR paper: https://arxiv.org/html/2511.09554v1
- Grounding DINO 1.5 API: https://github.com/IDEA-Research/Grounding-DINO-1.5-API ; DINO-X: https://github.com/idea-research/dino-x-api
- MM-Grounding-DINO: https://github.com/open-mmlab/mmdetection/blob/main/configs/mm_grounding_dino/README.md
- NVIDIA TAO Grounding DINO: https://catalog.ngc.nvidia.com/orgs/nvidia/teams/tao/models/grounding_dino
- YOLO-World/YOLOE licensing summaries: https://roboflow.com/model-licenses/yolo-world , https://playground.roboflow.com/models/thu-mig/yoloe
- Evolv / FTC: https://statescoop.com/ftc-ai-weapon-detection-company-evolv-deceptively-advertised-schools/ ; https://www.nbcchicago.com/investigations/ftc-finds-evolv-made-false-claims-misrepresented-weapons-detectors-capabilities/3611410/ ; https://www.wsmv.com/2025/01/27/weapons-detection-system-newly-installed-antioch-high-school-settles-with-ftc-over-misleading-claims/
- Omnilert Antioch: https://www.wsmv.com/2025/01/23/antioch-high-schools-weapons-detection-system-didnt-detect-shooters-weapon-wsmv4-investigates-uncovered/ ; https://www.newschannel5.com/news/antioch-high-shooting-survivor-sues-ai-gun-detection-companies-saying-system-failed-to-save-lives
- Omnilert Kenwood: https://www.cbsnews.com/baltimore/news/false-alarm-gun-detection-kenwood-maryland-artificial-intelligence-review/ ; https://incidentdatabase.ai/cite/1250/ ; https://www.thebanner.com/education/k-12-schools/baltimore-county-ai-gun-detection-omnilert-julian-jones-O734CM4CHFHWPFGFIBUEFABZHI/
- ZeroEyes: https://zeroeyes.com/operations-center ; https://zeroeyes.com/faqs ; https://surveillant.ai/guides/zeroeyes-weapons-detection
- Scylla: https://www.scylla.ai/false-alarm-filtering/ ; https://www.scylla.ai/gun-detection/
- Actuate: https://actuate.ai/ ; https://surveillant.ai/guides/best-gun-detection-software
- Eagle Eye: https://www.een.com/blog/making-communities-safer-eagle-eye-networks-launches-ai-camera-gun-detection/
- Hikvision: https://www.hikvision.com/en/newsroom/latest-news/2024/hikvision-and-ithermaI-work-together-to-provide-AI-based-fire-and-smoke-detection-solutions/ ; https://internationalsecurityjournal.com/fire-risks-hikvision-cameras/
- Dahua: https://www.dahuasecurity.com/products/key-technologies/wizmind ; https://www.dahuasecurity.com/bd/products/All-Products/Fire-Alarm/Fire-Safety-Camera/Flame-Detection-Camera/HY-FT443HFP
- Videonetics: https://www.videonetics.com/warehouse ; Staqu: https://www.staqu.com/blog-jarvis-ai-video-analytics-platform/ ; AllGoVision: https://www.allgovision.com/security-application.php
- NFPA 72 / UL 268B VISD: https://www.jensenhughes.com/insights/whats-the-deal-with-video-image-detection ; https://www.shopulstandards.com/ProductDetail.aspx?UniqueKey=19730
- ISO 7240-29: https://www.iso.org/standard/83347.html ; https://www.iso.org/standard/72262.html
- India QCO / IS/ISO 7240-29: https://pcnindiaglobal.com/2026/06/25/bis-certification-for-fire-detection-alarm-systems-in-india-is-2189-is-iso-7240-the-2025-qco/ ; https://www.standphillindia.in/product/fire-detection-alarm-systems.php
- IS 2189: https://law.resource.org/pub/in/bis/S03/is.2189.2008.pdf ; NBC 2016 Part 4: https://infralens.in/knowledge/nbc-2016-part-4-fire-safety
- STQC CCTV mandate: https://www.asmag.com/showpost/34950.aspx
- RDSO VSS: https://iriset.railnet.gov.in/content/gyandeep/2019/Article7.pdf
