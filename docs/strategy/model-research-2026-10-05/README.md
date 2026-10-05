# Open-model research for VigilOne (5 Oct 2026)

The owner asked for thorough research on pose models (for person down and fence climbing) and on every other
open model the VMS could use. Four research passes checked licence files, model cards, dataset terms and, where
possible, CPU speed on our own stack (onnxruntime, 4-core Xeon). Each detailed report lists its sources and marks
what could not be checked directly as UNVERIFIED. Several sites (arXiv, Kaggle, Roboflow Universe, Zenodo, many
vendor pages) were blocked from the research sessions, so some facts come from search results only.

| Report | Covers |
| --- | --- |
| [pose-fall-climb.md](pose-fall-climb.md) | Pose models, fall and fence-climb detection, fall datasets, competitors |
| [fire-smoke-weapons.md](fire-smoke-weapons.md) | Fire and smoke, guns and knives, open-vocabulary checks, regulation |
| [events-over-time.md](events-over-time.md) | Vehicle accidents, fights, crowds, tailgating, anomaly detection, video VLMs |
| [other-models.md](other-models.md) | Detectors, trackers and ReID, attributes, PPE, segmentation, VLMs and LLMs, camera health, audio, ANPR, embeddings |

## The one finding that runs through everything

**Code licences are rarely the problem; training data is.** Most ready-made weights with an Apache or MIT label
were trained on datasets that forbid commercial use (pose: AI Challenger, CrowdPose, MPII, PoseTrack, which bans
commercial surveillance outright; fights and falls: YouTube clips, NTU RGB+D, UR Fall, Le2i; ReID: Market-1501,
MSMT17). Every recommendation below says where its weights come from. The owner needs one policy decision on
this (see Decisions).

## Person down and fence climbing (the next build)

- **Pose model:** RTMPose-s on the person boxes YOLOX already finds (Apache-2.0 code, 17 COCO keypoints, plain
  ONNX, measured 6.2 ms per person; RTMPose-m 15.5 ms). RTMO-s for crowded cameras (one pass per frame, 77 ms at
  640x640). Fallbacks: Lite-HRNet (Apache-2.0, COCO only, 18.5 ms) and YOLOX-Pose (COCO only).
- **Weights:** the widely used RTMPose/RTMO ONNX files ("body7") are high-risk to ship because of their training
  data. The cleanest pretrained choice is the **COCO-only RTMO and YOLOX-Pose checkpoints**, which need a one-time
  ONNX export. Long term: retrain RTMPose/RTMO on COCO plus our own consented footage.
- **Rejected:** Ultralytics pose and OpenPifPaf (AGPL), OpenPose and AlphaPose (academic only), YOLO-NAS-Pose
  weights (no commercial use), Sapiens (non-commercial; Sapiens2 bans surveillance), ED-Pose, DWPose and RTMW
  (non-commercial data), MoveNet and MediaPipe (their model cards put surveillance out of scope; single person).
- **Fall:** rules on tracked keypoints, not a trained classifier: a fall seen happening (torso angle, drop speed
  relative to height), then lying still for N seconds. A separate, lower-severity "lying still" alert. Zones and
  schedules where lying is normal (people sleep on Indian railway platforms). Optional VLM check of the snapshot.
- **Climb:** the operator draws the fence base and fence-top lines; wrists above the top line, feet off the
  ground and the hip crossing the line, then the person on the protected side. Box-only rules when pose is weak
  (night IR, small or hidden people). Hikvision defines climbing the same way.
- **Data:** commercially usable fall sets exist (CAUCAFall, UP-Fall, Simuletic synthetic, CC BY 4.0;
  GMDCSA-24, MIT). No usable fence-climb set exists: staged recordings are needed.

## Other events

- **Fire and smoke:** clean training data exists (D-Fire, CC0; Pyro-SDIS, Apache-2.0; FASDD, CC BY 4.0 but partly
  web-crawled). No ready model is shippable (nearly all are Ultralytics, AGPL). Fine-tune our own detector and add
  a time check (persists, flickers, grows). Expect many false alarms from steam, fog, dust and sunsets; sell it as
  an extra alert next to the fire alarm system, never instead of it.
- **Weapons:** no clean, large CCTV weapon dataset; nothing for Indian tools (sickle, machete, lathi). It needs
  our own staged footage with replica weapons and a person-crop detector that also knows look-alikes (phone, drill,
  umbrella). Always an advisory that an operator confirms. Public failures (Evolv, Omnilert) show the cost of
  over-claiming.
- **Accidents, crowds, tailgating:** mostly rules on our existing tracks (vehicle stopped in a live lane after a
  sudden slowdown or near contact; crowd density, running, scattering; tailgating tied to door access), then a
  multi-frame VLM check. Trained fight and accident models are blocked mainly by data licences.
- **Anomaly detection (UCF-Crime style):** not worth it; an "unusual motion" statistic on our own tracks, for
  review rather than alarms, is more useful.

## Improvements to what we already run (from other-models.md)

1. **PP-OCRv6 text detector** in place of PP-OCRv4 for ANPR: Apache-2.0, official ONNX, measured 18.4 ms against
   39.5 ms.
2. **D-FINE-N/S** as the CPU detector upgrade (Apache-2.0, about +10 COCO AP over YOLOX-tiny, 28 ms at 416);
   RF-DETR (Nano to Large are Apache) only on GPU boxes, since it is slow on CPU.
3. **One local model for text and images:** Qwen3.5 small models (Apache-2.0) could replace both SmolVLM2 and
   Qwen3-4B. MiniCPM-V 4.6 (Apache-2.0) or Gemma 4 E2B (Apache-2.0) as a faster yes/no checker.
4. **UVH-26** (Bengaluru CCTV, CC BY 4.0, 14 Indian vehicle classes) to fine-tune for autos, e-rickshaws and
   tempos.
5. **OC-SORT / ByteTrack** ideas (MIT) for the tracker; person attributes trained by us on PA-100K (CC BY 4.0);
   SAM 2.1-tiny or EfficientSAM for click-to-mask redaction; YAMNet or EfficientAT for audio; IndicTrans2 (MIT)
   for regional-language text.

## Licence changes and traps found (verify before use)

- DEIMv2 (and the same lab's EdgeCrafter) moved to a non-commercial licence in 2026; DEIM v1 stays Apache.
- RF-DETR XL and 2XL are under PML 1.0; only Nano to Large are Apache.
- D-FINE and RF-DETR base weights are pretrained on Objects365, whose commercial terms are unclear.
- YOLO-World is GPL-3.0; YOLOE, BoxMOT and all Ultralytics models are AGPL-3.0.
- MobileCLIP and MobileCLIP2 weights are research-only; Moondream 3 forbids use in a competing paid product.
- Qwen2.5-VL-3B is under the Qwen Research licence even where a GGUF copy says Apache.
- Llama 3.2's use policy excludes critical infrastructure and transportation, which covers railway and smart-city
  work; Meta's DINOv3 and SAM 3 licences exclude military and espionage uses (needs a legal reading for police and
  RPF tenders).
- Sarvam-1 is non-commercial and Sarvam-Translate is GPL; Krutrim needs a separate commercial deal; Liquid LFM is
  free only below US$10M revenue.

## Decisions for the owner

1. **Training-data policy (blocks the pose build).** Do we ship only weights whose training data allows commercial
   use (COCO-only or our own data), or also permissively licensed weights trained on non-commercial data? The
   research recommends the first for anything shipped, with Indian legal advice.
2. **Which pose weights to start with:** the COCO-only RTMO / YOLOX-Pose checkpoints (exported to ONNX by us), or
   wait for a retrain.
3. **Objects365-pretrained detectors** (D-FINE, RF-DETR): acceptable or not.
4. **Our own data collection:** staged falls and fence climbs (with consent forms, DPDP Act), replica-weapon footage
   (with police coordination), fire false-alarm footage.
5. **Evaluation on non-commercial datasets:** allowed internally or not.
6. **Acceptance targets** before selling a detection (for example: fall recall of at least 90% on staged falls and
   no more than one false alarm per camera per day on platform footage), measured on our own data.
