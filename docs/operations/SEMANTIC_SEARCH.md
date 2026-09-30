# Semantic crop search (Phase 5, ADR 0005)

Status: **built and tested on synthetic vectors; no embedding model is installed.** Nothing is embedded
until an embedding adapter is configured, and retrieval quality on site data has not been measured.

## What exists

* **Storage:** table `CropEmbedding` in PostgreSQL with the pgvector extension: one row per crop and
  model, a `vector(768)` column, an HNSW index on cosine distance. The size is fixed at 768 (the
  SigLIP 2 base size). A model with another size needs a migration. The row is deleted with its crop.
* **Embedder worker (`cropEmbedder`):** every `CROP_EMBED_INTERVAL_MS` (default 30 s, at least 1000)
  it verifies the adapter, then embeds unexpired crops that have no embedding from that model. It
  checks each crop's SHA-256 before sending it, embeds a person crop only while its site still allows
  person crops, and sets aside a crop that keeps failing.
* **Adapter contract:** `ai-adapter.v1.1`, task `embedding`, a JPEG crop in, `embedding`
  (`float32_base64`, 768 dims) out. The client accepts a model only if it is registered here as an
  active `embedding` model with the same name, version and SHA-256 and the answer's provenance
  names it. See `docs/contracts/ai-adapter.v1.md`.
* **Search API:** `POST /api/v1/search/crops` by example (`cropId` or `embedding`), and
  `GET /api/v1/search/crops/:cropId/image` (hash-checked). Filters: cameras, time window, object
  classes, minimum score, limit (at most 100). Results come back with `mode`: `ann` (the index) or
  `exact` (an exact scan, used when the index returns fewer rows than asked for, so a short answer
  means there really are no more matches). A **text query returns 501 `TEXT_QUERY_NOT_AVAILABLE`**.
* **Privacy:** see "Semantic search over crops" in `DATA_PROTECTION.md`.

## Turning it on

1. Use the pgvector database image (`pgvector/pgvector:0.8.0-pg16`, already in `docker-compose.yml`).
   The migration `20261003000000_phase5_crop_embeddings` runs `CREATE EXTENSION vector` and **fails if
   the extension is not available**, on purpose.
2. Run an adapter that serves the `embedding` task and register its model in the model registry
   (task `embedding`, exact SHA-256). None is provided yet.
3. Set `VIGILONE_FEATURE_SEMANTIC_SEARCH=true` and `EMBEDDING_ADAPTER_URL=http://...`. The backend
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

1. Pick crops from the site and label, for each query crop, which other crops show the same
   object (labels file, `vigilone.retrieval-labels.v1`; see `tools/eval/retrieval-eval.mjs`).
2. Run each query through `POST /api/v1/search/crops` with `{"cropId": ..., "limit": 20}` and save the
   crop ids in the order returned, with the model's SHA-256 (`vigilone.retrieval-results.v1`).
3. `node tools/eval/retrieval-eval.mjs --labels l.json --results r.json --real-site-data --dataset "..."`
   prints recall@k, hit rate with a 95% interval and MRR. It only says EVALUATED with real site
   data and at least 100 labelled queries (a proposal, not a standard). Publish the output next to the
   model's card. Person queries need a purpose; label with the DPDP position in mind.

## Not built (needs the model files)

The SigLIP 2 adapter (image tower), its pinned SHA-256 and licence entry, the text tower, the tokenizer
and its reference-ID tests, and text search. They need files from huggingface.co, which this
environment's network policy denies; the exact requests are in `docs/STATUS.md`.
