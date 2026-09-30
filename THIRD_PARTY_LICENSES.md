# Software Bill of Materials (SBOM) & Third-Party Licensing Policy

**Project:** VigilOne VMS  
**Commercial Model:** Perpetual License / Subscription Software Appliance  
**IP Boundary Policy Version:** 1.0.0 (Phase 1)

---

## 1. Core Architectural Licensing Principle

VigilOne maintains a strict commercial separation between **proprietary application value** and **commodity open-source infrastructure**:

- **Proprietary Application Codebase (`backend/`, `frontend/`, Orchestration):** All direct and transitive library dependencies linked or imported into the VigilOne runtime must be licensed under permissive licenses: **MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, or ISC**.
- **Copyleft Exclusion Policy:** No packages or modules under **AGPL-3.0** (e.g., Ultralytics YOLO, OpenALPR) or **GPL** (e.g., ZoneMinder, Bluecherry core) may be imported, linked, or embedded into the proprietary application codebase.
- **Hardware & Commodity Media Infrastructure:** Infrastructure components (Caddy, MediaMTX, PostgreSQL, Linux Kernel, FFmpeg) run as isolated OS-level containers or subprocesses across standard process boundaries (network sockets and standard I/O pipes).

---

## 2. Standalone Subprocess Boundary: FFmpeg & libx264 (GPL Compliance)

### 2.1 Architectural Isolation
VigilOne does not link against `libavcodec`, `libavformat`, or `libavutil` via C/C++ bindings or node-gyp bindings. Furthermore, the deprecated `fluent-ffmpeg` wrapper has been completely removed.

All media operations (metadata probing, keyframe stream-copy slicing, boundary frame re-encoding for `FRAME_ACCURATE` export, and SHA-256 stream hashing) are executed exclusively by spawning the external `ffmpeg` / `ffprobe` CLI binaries as independent operating system subprocesses using Node.js `child_process.spawn()`.

Under well-established copyright and licensing doctrine:
1. VigilOne communicates with the external FFmpeg binary via command-line arguments, exit status codes, and standard pipes (`stdin`/`stdout`).
2. VigilOne is not a derivative work of FFmpeg. The proprietary codebase is free of copyleft propagation.

### 2.2 Shipped FFmpeg Binary GPL Obligations
When shipping an edge appliance image containing an FFmpeg binary compiled with `--enable-gpl --enable-libx264` (required for high-quality H.264 video re-encoding in `FRAME_ACCURATE` mode), VigilOne complies fully with the terms of the GNU General Public License (GPLv2 / GPLv3):

1. **License Text:** The full text of the GNU General Public License is included in this document and shipped with the appliance filesystem at `/usr/share/doc/ffmpeg/LICENSE.GPL`.
2. **Build Configuration Disclosure:** The exact compiler flags and configuration used to build the containerized FFmpeg binary are documented:
   ```bash
   ./configure \
     --enable-gpl \
     --enable-libx264 \
     --enable-nonfree=no \
     --disable-static \
     --enable-shared \
     --disable-debug \
     --disable-doc
   ```
3. **Written Offer of Source Code:** VigilOne hereby makes a continuous, valid written offer to provide any customer or licensee of the appliance with a machine-readable copy of the exact matching source code of the FFmpeg binary and libx264 library upon request, or via our public mirror at `https://github.com/FFmpeg/FFmpeg` (pinned release tag).

---

## 3. Dependency Inventory & License Matrix

### 3.1 Infrastructure & Containers
| Component | Project Repository | License | Role in VigilOne |
| :--- | :--- | :--- | :--- |
| **MediaMTX** | `github.com/bluenviron/mediamtx` | **MIT** | RTSP ingest, WebRTC (WHEP), HLS, fMP4 segmenting |
| **Caddy Server** | `github.com/caddyserver/caddy` | **Apache-2.0** | Unified reverse proxy, auto-TLS, single HTTP origin |
| **PostgreSQL** | `postgresql.org` | **PostgreSQL License** (BSD-style) | Relational database (metadata, audit log, events) |
| **Alpine Linux** | `alpinelinux.org` | **MIT / BSD / GPL** (Base distribution) | Minimal container operating system base images |

### 3.2 Backend Runtime Dependencies (`backend/package.json`)
| Package | License | Purpose |
| :--- | :--- | :--- |
| `@prisma/client` | **Apache-2.0** | Database ORM & query builder |
| `express` | **MIT** | HTTP REST server framework |
| `zod` | **MIT** | Environment & schema validation |
| `jsonwebtoken` | **MIT** | JWT authentication & short-lived media tokens |
| `jose` 5.10.0 | **MIT** | OpenID Connect ID-token verification (JWKS, signatures) for single sign-on |
| `bcryptjs` | **MIT** | Password hashing for operator credentials |
| `onvif` | **MIT** | ONVIF SOAP client, WS-Discovery, PTZ commands (pulls in `xml2js` -> `sax`, BlueOak-1.0.0: pending licence review, see docs/STATUS.md) |
| `axios` | **MIT** | HTTP client for MediaMTX Control API |
| `pdfkit` | **MIT** | Generates Section 63 BSA Part A & Part B PDFs |
| `archiver` | **MIT** | Assembles evidentiary zip packages |
| `check-disk-space` | **MIT** | Storage sentinel disk space monitoring |
| `cors` | **MIT** | Cross-origin resource sharing middleware |
| `helmet` | **MIT** | HTTP security headers |
| `fast-xml-parser` (+ `strnum`, `is-unsafe`, `xml-naming`, `fast-xml-builder`, `path-expression-matcher`, `@nodable/entities`) | **MIT** | Camera event protocols: ONVIF SOAP, Hikvision ISAPI, Profile M metadata (Phase 3) |

SMTP delivery uses an in-house client (`backend/src/services/notification/smtp/smtpClient.ts`)
because the common Node mail libraries are MIT-0, which is not on the allowlist.

### 3.2a AI worker runtime dependencies (`services/ai-worker/package.json`)
| Package | License | Purpose |
| :--- | :--- | :--- |
| `onnxruntime-node` / `onnxruntime-common` 1.30.0 | **MIT** | ONNX inference (CPU binaries bundled in the package) |
| `adm-zip`, `globalthis`, `matcher`, `serialize-error`, `define-properties`, `gopd`, `escape-string-regexp`, `define-data-property`, `has-property-descriptors`, `object-keys`, `es-define-property`, `es-errors` | **MIT** | onnxruntime-node install/runtime helpers |
| `global-agent` | **BSD-3-Clause** | onnxruntime-node proxy support |
| `semver` | **ISC** | onnxruntime-node |
| `@huggingface/tokenizers` 0.2.0 | **Apache-2.0** | SigLIP 2 text tokenizer (pure TypeScript, no dependencies) |
| llama.cpp `llama-server` (tag b11277, commit eae11d2) | **MIT** | Runs the VLM second opinion; built from source in `services/ai-worker/Dockerfile.vlm`, started by the worker as a child process |
| `type-fest` | **MIT OR CC0-1.0** (used under MIT) | type definitions |

### 3.2b AI models (weights are fetched by `scripts/models/fetch-model.sh`, pinned by SHA-256 in `scripts/models/models.lock.json`; not committed)
| Model | License | Notes |
| :--- | :--- | :--- |
| YOLOX nano / tiny / s (Megvii) | **Apache-2.0** | Default detectors. Trained on COCO (see licence questions in docs/STATUS.md). |
| RF-DETR Nano (Roboflow) | **Apache-2.0** | Exported locally with `scripts/models/export-rfdetr.sh`; optional. |

**Candidate models** (`candidateModels` in the lock file). Their code and weight licences are permissive, but their training data needs a human decision, so the product refuses to run them (`LICENSE_REJECTED`) until `scripts/models/model-license-exceptions.json` holds an approval naming the exact SHA-256. See "Licence questions" in docs/STATUS.md.

| Model | License | Source | Open question |
| :--- | :--- | :--- | :--- |
| PP-OCRv4 text detection (`ppocrv4-det`) | **Apache-2.0** | PaddleOCR, ONNX from the `rapidocr_onnxruntime` 1.4.4 wheel (Apache-2.0) | Training datasets not fully published; some public text datasets are research-only |
| fast-plate-ocr `cct_s_v2_global` (`fast-plate-ocr-cct-s-v2`) | **MIT** | github.com/ankandrew/cnn-ocr-lp release `arg-plates` | Training data unpublished; India is not a listed region |
| YuNet 2023mar (`yunet-2023mar`) | **MIT** | opencv/opencv_zoo | Trained on WIDER FACE, whose terms forbid commercial use of derived data |
| SmolVLM2 2.2B Instruct GGUF Q4_K_M and Q8_0 projector (`smolvlm2-2.2b-instruct-q4km`, `-mmproj-q8`) | **Apache-2.0** | HuggingFaceTB/SmolVLM2-2.2B-Instruct, GGUF by ggml-org, pinned commit `1bc3c9f74cea` | Training mix has mixed or unclear licences (model-generated instruction data, video sources) |
| SigLIP 2 base patch16-224 vision and text towers (`siglip2-base-p16-224-vision`, `-text`) | **Apache-2.0** (upstream `google/siglip2-base-patch16-224`; the ONNX repository's own card states no licence) | ONNX export by `onnx-community/siglip2-base-patch16-224-ONNX`, pinned commit `ba1f3b0843f2`; tokenizer file identical to the official one | Training data (WebLI) unpublished. **Approved by the owner on 30 Sept 2026** (business decision, not a legal clearance) |

### 3.2c Test and evaluation tools (never shipped in the appliance)
| Tool | License | Use |
| :--- | :--- | :--- |
| `oidc-provider` 9.12.2 (with `koa`, `jose` 6) | **MIT** | Real OpenID Connect provider for the SSO tests (`tools/sim/oidc`); never shipped |
| `supervision` (Roboflow) | **MIT** | Reference ByteTrack / LineZone for tracker validation |
| `pycocotools` | **BSD-2-Clause** (FreeBSD) | Reference COCO evaluation |
| `onnxruntime` (Python), `opencv-python-headless`, `numpy` | **MIT**, **Apache-2.0 / MIT**, **BSD-3-Clause** | Python reference decoders |
| MailHog 1.0.1 | **MIT** | SMTP interop test server (binary, CI only) |
| `rapidocr_onnxruntime` 1.4.4 (Python) | **Apache-2.0** | Reference DB text-detection post-processing for the ANPR golden tests |
| `fast-plate-ocr` 1.1.0 (Python) | **MIT** | Reference plate OCR decoding for the ANPR golden tests |
| `botocore` (Python) | **Apache-2.0** | Reference SigV4 signatures for the S3 client tests (`tools/reference/s3_sigv4_reference.py`) |
| `moto` 5.1.0 server (Python), with `Flask`, `flask-cors` | **Apache-2.0**, **BSD-3-Clause**, **MIT** | S3-compatible server for the archive tests, locally and in CI (`tools/sim/requirements-test-servers.txt`); never shipped |
| `torch` 2.14.0, `transformers` 5.17.0, `tokenizers`, `safetensors`, `sentencepiece`, `pillow` (Python) | **BSD-3-Clause**, **Apache-2.0**, **Apache-2.0**, **Apache-2.0**, **Apache-2.0**, **MIT-CMU (HPND)** | Reference embeddings and token IDs for the SigLIP 2 tests (`tools/reference/requirements-siglip2.txt`); never shipped |
| `pyclipper`, `shapely`, `Pillow`, `PyYAML` | **MIT**, **BSD-3-Clause**, **MIT-CMU (HPND)**, **MIT** | Reference-tool dependencies; synthetic plate rendering |
| DejaVu fonts | **Bitstream Vera / public-domain derivative** | Rendering SYNTHETIC plate fixtures only; the fonts are not committed |
| NASA portrait of Eileen Collins (`skimage/data/astronaut.png` from scikit-image 0.26.0, BSD-3-Clause package) | **Public domain** ("No known copyright restrictions, released into the public domain", scikit-image docs) | The only real-world image in the redaction test fixture; pinned by SHA-256 in `tools/redaction/make_fixtures.py` |
| ANPR fine-tuning stack (`tools/anpr/finetune/requirements-train.txt`): `fast-plate-ocr[train]` 1.1.0, TensorFlow 2.21, Keras 3.15, albumentations 2.0.8, tf2onnx, onnxslim, onnxruntime | **MIT / Apache-2.0** (top level); transitive `matplotlib` (Matplotlib licence) and `tqdm` (MPL-2.0 AND MIT) are not on the allowed list, see Licence questions | Workstation-only training; never installed in the appliance |
| fast-plate-ocr base Keras weights `cct_s_v2_global.keras` + model config | **MIT** (github.com/ankandrew/cnn-ocr-lp) | Fine-tuning starting point, pinned in `tools/anpr/finetune/base-model.lock.json` |


### 3.3 Frontend Runtime Dependencies (`frontend/package.json`)
| Package | License | Purpose |
| :--- | :--- | :--- |
| `react` / `react-dom` | **MIT** | UI Component architecture |
| `lucide-react` | **ISC** (Permissive) | Surveillance & equipment UI icons |
| `axios` | **MIT** | REST client for `/api/v1` |
| `clsx` / `tailwind-merge` | **MIT** | Dynamic CSS class manipulation |
| `tailwindcss` | **MIT** | Utility-first styling framework |
| `vite` | **MIT** | Frontend build tool |

---

## 4. Prohibited Dependencies & License Blacklist

The following license families are strictly **BLACKLISTED** from being added as runtime dependencies to `backend/` or `frontend/`:
- **AGPL-3.0** (GNU Affero General Public License)
- **GPL-2.0 / GPL-3.0** (GNU General Public License) — strictly permitted only as standalone subprocess CLI binaries (e.g. FFmpeg), never as imported libraries
- **SSPL** (Server Side Public License)
- **Commons Clause** / Non-Commercial restrictive clauses
- Proprietary SDKs without commercial redistribution agreements
