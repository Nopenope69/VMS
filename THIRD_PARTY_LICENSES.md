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
| `bcryptjs` | **MIT** | Password hashing for operator credentials |
| `@2bad/onvif` | **MIT** | ONVIF SOAP client, WS-Discovery, PTZ commands |
| `axios` | **MIT** | HTTP client for MediaMTX Control API |
| `pdfkit` | **MIT** | Generates Section 63 BSA Part A & Part B PDFs |
| `archiver` | **MIT** | Assembles evidentiary zip packages |
| `check-disk-space` | **MIT** | Storage sentinel disk space monitoring |
| `cors` | **MIT** | Cross-origin resource sharing middleware |
| `helmet` | **MIT** | HTTP security headers |

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
