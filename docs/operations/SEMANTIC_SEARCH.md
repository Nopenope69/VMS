# Semantic crop search (Phase 5, ADR 0005)

Status: **built, and shown to work end to end with the real SigLIP 2 model on public-domain pictures.
The owner approved the model to run in the product on 30 Sept 2026** (a business decision recorded in
`scripts/models/model-license-exceptions.json`, not a legal clearance; see "Turning it on"), and
**retrieval quality on site data has not been measured.**

## What exists

* **Storage:** table `CropEmbedding` in PostgreSQL with the pgvector extension: one row per crop and
  model, a `vector(768)` column, an HNSW index on cosine distance. The size is fixed at 768 (the
  SigLIP 2 base size). A model with another size needs a migration. The row is deleted with its crop.
* **Embedder worker (`cropEmbedder`):** every `CROP_EMBED_INTERVAL_MS` (default 30 s, at least 1000)
  it verifies the adapter, then embeds unexpired crops that have no embedding from that model. It
  checks each crop's SHA-256 before sending it, embeds a person crop only while its site still allows
  person crops, and sets aside a crop that keeps failing.
* **Embedding adapter (`services/ai-worker`, mode `embedding`, port 7013):** SigLIP 2 base, patch 16,
  224 px, image and text towers, ONNX on CPU. `ai-adapter.v1.1`: task `embedding` (a JPEG or raw crop in,
  a 768-dim `float32_base64` vector out) and `POST /v1/embed-text` (text in, a vector in the same space
  out). The model identity the backend registers and stores with every vector is the SHA-256 of the
  pipeline file `scripts/models/pipelines/embedding-siglip2-v1.json`, which pins both towers and the
  tokenizer by SHA-256. The client accepts a model only if it is registered here as an active `embedding`
  model with the same name, version and SHA-256 and the answer's provenance names it. See
  `docs/contracts/ai-adapter.v1.md`.
* **Image preprocessing** reproduces Pillow's bilinear resize to 224x224 (an anti-aliasing filter, not
  OpenCV's), then scale 1/255 and mean/std 0.5, exactly as the official processor does. The resized bytes
  equal Pillow's on the test images.
* **Text:** lower-cased, tokenized with `@huggingface/tokenizers` (Apache-2.0, TypeScript) from the
  official `tokenizer.json`, truncated or padded to 64 tokens with the end-of-text token kept, as the
  model was trained. Token IDs equal the official tokenizer's on committed fixtures (mixed Latin and
  Devanagari, accents, empty, upper case, and an over-long input).
* **Search API:** `POST /api/v1/search/crops` by example (`cropId` or `embedding`), and
  `GET /api/v1/search/crops/:cropId/image` (hash-checked). Filters: cameras, time window, object
  classes, minimum score, limit (at most 100). Results come back with `mode`: `ann` (the index) or
  `exact` (an exact scan, used when the index returns fewer rows than asked for, so a short answer
  means there really are no more matches). **Text queries** (`{"text": "a white delivery van"}`, 1 to 512
  characters) are embedded by the adapter's text tower through the same verified client (health,
  descriptor, registry and provenance are checked on every query) and searched like any vector. Without
  `EMBEDDING_ADAPTER_URL` it is 501 `TEXT_QUERY_NOT_AVAILABLE`; an unreachable, erroring or mismatched
  adapter is 503; naming a `modelSha256` other than the encoder's is 409 `TEXT_MODEL_MISMATCH`. Text
  that is meant to find people (`includePersons`/`personsOnly`) is person access like any other, and
  every text query is audited with its text. Scores between a text and a picture are on a different scale
  from picture-to-picture scores (SigLIP text-image cosines are small), so do not reuse a `minScore`
  between the two.
* **Privacy:** see "Semantic search over crops" in `DATA_PROTECTION.md`.

## Turning it on

1. Use the pgvector database image (`pgvector/pgvector:0.8.0-pg16`, already in `docker-compose.yml`).
   The migration `20261003000000_phase5_crop_embeddings` runs `CREATE EXTENSION vector` and **fails if
   the extension is not available**, on purpose.
2. Fetch the model files (about 1.5 GB, SHA-256 verified; the towers come from
   `huggingface.co`, which an air-gapped site must load another way):
   `scripts/models/fetch-model.sh siglip2-base-p16-224-vision` and `... siglip2-base-p16-224-text`.
3. **A human approval is required, and has been given.** The towers are candidate models because SigLIP 2's
   training data (WebLI) is unpublished. The worker refuses to load them (`LICENSE_REJECTED`, health FAILED,
   nothing is embedded) unless `scripts/models/model-license-exceptions.json` holds an approval for the exact
   SHA-256 of each tower, and the backend refuses to register the pipeline without the same approvals. The
   repository owner approved both towers on 30 Sept 2026 (entered by the coding agent at the owner's
   instruction; the entry says so). It is a business decision: counsel has not reviewed the training data.
   A deployment that mounts its own approvals file (`VIGILONE_MODEL_EXCEPTIONS`) must carry the same entries. The weights
   themselves are Apache-2.0 upstream (`google/siglip2-base-patch16-224`); the ONNX repository this build
   uses states no licence of its own and points to that base model.
4. Start the adapter: `docker compose --profile search up -d embedding-worker` (or
   `AI_WORKER_MODE=embedding`). It registers the model with the backend. Memory: measured peak RSS while
   loading was about 3.7 GB and about 2.2 GB afterwards on the build machine (Node 20, onnxruntime-node
   1.30.0, CPU); the compose limit is 4.5 GB. Speed on that machine (4 cores, one inference thread) was about 0.33 s
   per crop and about 0.11 s per text query; not measured on reference hardware.
5. Set `VIGILONE_FEATURE_SEMANTIC_SEARCH=true` and `EMBEDDING_ADAPTER_URL=http://127.0.0.1:7013`. The backend
   refuses to start the worker if the URL is missing or not http(s), or if the interval is invalid.
   Crop capture (`VIGILONE_FEATURE_OBJECT_CROPS`) must also be on for there to be crops to embed, and
   the tenant needs the `ADVANCED_SEARCH` licence feature.

## Existing installs: the database image changed

The pgvector image is Debian-based; the earlier `postgres:16-alpine` is not. The two can order text
differently, which can corrupt indexes if the data directory is reused. **Do not point the new image at
an existing alpine data volume.** Move the data with `pg_dump` from the old container and a restore
into the new one, then run `prisma migrate deploy`. Restores need the pgvector extension installed.
There are no production installs yet, so nothing has been migrated. The `postgres` service memory limit
in `docker-compose.yml` (512 MB) may need raising once the index holds many vectors; not measured.

## Measuring retrieval (the Phase 5 exit gate)

Not done: it needs labelled queries from a real site.

The full procedure is in `docs/operations/RETRIEVAL_LABELLING.md`. In short:

1. Pick crops from the site and label, for each query crop, which other crops are relevant (labels
   file, `vigilone.retrieval-labels.v1`; a template is `tools/eval/sample/retrieval-labels.example.json`).
2. `node tools/eval/retrieval-collect.mjs --labels l.json --url ... --token ... --out r.json` runs each
   query through `POST /api/v1/search/crops` and saves the crop ids in the order returned, with the
   model's SHA-256. It writes nothing if any query fails or a different model answers.
3. `node tools/eval/retrieval-eval.mjs --labels l.json --results r.json --real-site-data --dataset "..."`
   prints recall@k, hit rate with a 95% interval and MRR. It only says EVALUATED with real site
   data and at least 100 labelled queries (a proposal, not a standard). Publish the output next to the
   model's card. Person queries need a purpose; label with the DPDP position in mind.

## What was checked, and what was not

Checked by running it (the commands are in `docs/STATUS.md`):

* Pillow-exact preprocessing on five synthetic images; the resized bytes are identical.
* The official PyTorch checkpoint (`google/siglip2-base-patch16-224`, `model.safetensors` SHA-256
  `612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b`, transformers 5.17.0) against the
  pinned ONNX towers: cosine at least 0.9999998 and largest component difference 7.6e-6 for 5 images and 9
  prompts (`tools/reference/siglip2_reference.py`, results in
  `services/ai-worker/src/__tests__/fixtures/embedding/siglip2.reference.json`). The worker's own
  preprocessing, tokenizer and towers reproduce those embeddings (cosine above 0.99999).
* End to end: the real adapter over HTTP, the crop embedder, PostgreSQL with pgvector and the Express
  API, on four public-domain pictures. Text queries for an astronaut, a cat, a cup of coffee and a
  camera each return the matching picture first (`backend/src/__tests__/semanticSearchRealModels.test.ts`).

Not checked:

* **Retrieval quality on site footage.** Four clean stock pictures show the pipeline works, not that it
  finds a white van in a night-time crop from a 2 MP camera. That is the Phase 5 exit gate and needs
  labelled site queries (above).
* Hindi and other Indian-language queries were tokenized correctly (Devanagari fixture) but their ranking
  quality was not measured.
* Speed and memory on the reference appliance; the numbers above are from a build machine.
