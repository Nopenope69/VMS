# 0005: Phase 5 search and explain

## Status
Accepted (29 Sept 2026). The four decisions below were put to the product owner, who asked the agent to choose and give reasons. They can be reopened; each entry says what would change the answer.

## Context
Phase 5 adds explanation records, semantic search over object crops, and local VLM verification of flagged events. The base already provides a provenance block on every AI record, an offline verifier (`vigilone-verify`), a purpose-limited audit path for sensitive queries, and the `embedding` task in `ai-adapter.v1`. It has no crop storage, no vector index, and no VLM runtime. Postgres runs as `postgres:16-alpine`, which does not include pgvector.

## Decisions

### 1. Order: explanations, then search, then VLM
- Explanation records need no model and can be closed completely with offline tamper tests.
- They define the record that search hits and VLM verdicts attach to.
- Search quality on small, distant CCTV crops is unknown until site data exists, and VLM accuracy cannot be measured until a pilot produces operator verdicts (`AlarmFeedback`). Both depend on human-supplied data, so they go after the item that does not.
- Crop capture starts in the first wave, because the labelled retrieval set can only be built from stored crops.

### 2. The VLM runs as a separate `llama.cpp` sidecar
- Isolation: AI failure must never touch recording (`ai-adapter.v1` invariant 3). A VLM call takes seconds and would stall the ai-worker event loop.
- A VLM is not a single ONNX call; it needs a generation loop and a KV cache. Building that in TypeScript would be a large hand-written component needing its own reference tests.
- `llama.cpp` is MIT, runs on CPU, has a multimodal path and an HTTP server, and quantised SmolVLM2 builds exist for it. A thin adapter in the worker speaks `ai-adapter.v1` to it over authenticated loopback.
- Conditions: pin the build and the model file by SHA-256, record the real llama.cpp version in provenance, fix temperature and seed, constrain the output to the verdict enum (verify grammar-constrained output when the adapter is built), add licence entries for the converted weights.
- Would change if: the reference hardware is Hailo or Jetson. The adapter boundary keeps that swap cheap.

### 3. The tokenizer is TypeScript (`@huggingface/tokenizers`), tested against reference token IDs
- Apache-2.0, pure TypeScript, no dependencies, supports BPE and Unigram.
- The runtime stays Python-free, as in earlier phases (models were ported to TypeScript and proved equal to the Python reference).
- A hand-written tokenizer is the silent-mismatch risk itself; a Python sidecar adds a runtime and a failure domain.
- The first test must reproduce the reference IDs for SigLIP 2's tokenizer on committed fixtures (Devanagari, mixed script, emoji, long input, and the padding, truncation and casing rules from the reference). If it cannot, fix or patch the library. A Python sidecar is the last resort.

### 4. Person-crop embeddings are off by default and enabled per site
- Person crops contain faces, and a vector index over them allows search for a person by appearance across time, which behaves like profiling even without face recognition. The lawful basis per deployment is an open human decision.
- Precedent: the face-processing switch is off by default and needs acknowledgement (P4.6).
- Turning it on later is one setting; collecting first and deleting later is hard with evidence holds.
- Non-person crops follow the general `SEMANTIC_SEARCH` flag. Person crops have their own switch and a shorter default retention. This is a design position, not legal advice.

## Defaults proposed in this ADR (pending the human DPDP decision)
- Crop retention: non-person 14 days, person 7 days, both overridable per site. Held evidence is never purged by the crop purge.
- Person-crop capture and embedding: disabled until a site sets the switch and records a purpose acknowledgement.
- Crops are written only when free space is above a configured floor; below it, capture fails loudly and the recording path is untouched.

## Consequences
- The compose, CI and DR-drill Postgres image changes to `pgvector/pgvector:0.8.0-pg16` when the vector index lands (Wave B). **Correction (Wave B):** an earlier draft of this ADR said the data directory stays compatible because the major version is the same. That is not safe to assume: `postgres:16-alpine` (musl) and the pgvector image (Debian, glibc) can order text differently, which can corrupt existing indexes. An existing volume from the alpine image must be moved by `pg_dump` and restore, not reused in place. There are no production installs yet, so nothing is migrated today; `docs/operations/SEMANTIC_SEARCH.md` records the procedure. Backup and restore drills must be re-run with the extension.
- A new adapter task `vlm_verification` is an additive change to the adapter contract (v1.1).
- A new evidence-package artifact `explanations.json` (role `EXPLANATIONS`) is covered by the signed manifest and checked by `vigilone-verify`.

## Implementation notes (Wave A wiring, 29 Sept 2026)
- The per-site person-crop switch is the `SiteCropPolicy` table (one row per site, person crops off when no row exists). Turning it on needs a recorded purpose and who acknowledged it; a database CHECK refuses anything less. It is set through `PUT /api/v1/crop-policy/:siteId` (administrators, audited); there is no UI yet.
- Crop metadata is `ObjectCrop`; the bytes are under `CROPS_DIR` (default `<RECORDINGS_DIR>/crops`). The ai-worker cuts the crop from its own frame and attaches it (`AI_ATTACH_CROPS`, default off), so the full frame is never written or sent; the backend can instead cut from a `snapshotPath` image. The backend decides whether to keep it (flag, per-site person policy).
- Explanations are stored as `Explanation` rows (immutable per alarm and template) and written into exports whenever records exist or the flag is on.
- The crop purge and the DPDP purge share one hold lookup (`services/privacy/holds.ts`) and both stop rather than guess when it cannot be read.

## Implementation notes (Wave B, 29 Sept 2026)
- Built without the SigLIP 2 model: the vector store and index (`CropEmbedding`, `vector(768)`, HNSW cosine), the embedder worker, query-by-example search, the audited person-crop path and the retrieval scorer. The dimension is fixed at 768 (SigLIP 2 base size); a model of another size needs a migration.
- The `ai-adapter.v1` result gains an optional `embedding` field (v1.1, additive). Text queries are refused with 501 until a text encoder and tokenizer exist.
- Not built, and blocked: the SigLIP 2 adapter, its pinned hash and licence entry, the tokenizer reference-ID tests, and text search. They need the model files from Hugging Face, which this environment's network policy denies.
- An embedding is deleted with its crop (foreign-key cascade), so crop retention, evidence holds and the person-crop switch govern it. A person crop is embedded only while its site still has person crops enabled.


## Implementation notes (SigLIP 2 adapter and text search, 30 Sept 2026)
- Built: the embedding adapter (image and text towers, mode `embedding`, port 7013), Pillow-exact preprocessing, the TypeScript tokenizer with reference IDs, the additive `POST /v1/embed-text` request (v1.1) and text search in `POST /api/v1/search/crops`. The pipeline file `scripts/models/pipelines/embedding-siglip2-v1.json` pins both towers and its own SHA-256 is the model identity stored with every vector, so a text vector and a crop vector always come from the same pair of towers.
- The pinned ONNX towers were compared with the official PyTorch checkpoint (cosine at least 0.9999998), and the worker reproduces the official embeddings, so the export is not an unexamined third-party conversion.
- The tokenizer decision held: `@huggingface/tokenizers` reproduced the official IDs on every fixture, so no Python sidecar is needed. Emoji was in the planned fixture list and was not tested.
- Still a human decision: the licence approval for the towers (training data unpublished). Still unmeasured: retrieval quality on site footage.
