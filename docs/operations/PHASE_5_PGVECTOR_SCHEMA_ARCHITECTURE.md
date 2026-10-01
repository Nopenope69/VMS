# Phase 5 semantic search: the pgvector schema as built

> Corrected 2026-10-01. The first version of this file (commit `4482397` on `main`) proposed a `VisualEmbedding`
> table of keyframe embeddings. That design was not built. What exists is described below; the decision record
> is ADR 0005 (`docs/adr/0005-phase5-search-and-explain.md`). The source of truth is the migration
> `backend/prisma/migrations/20261003000000_phase5_crop_embeddings/migration.sql`.

## What is embedded

Embeddings are made from **object crops** (`ObjectCrop`: the image of one detected object, cut from a frame by the
crop worker), not from whole keyframes.

- **Model:** SigLIP 2 base (`siglip2-base-p16-224`, vision and text towers) served by the ai-worker through
  ai-adapter.v1. It must be a registered, active model.
- **Search by text:** text queries go through the text tower (`POST /v1/embed-text`), so the query and the crops
  are compared in the same vector space.

## Table

`CropEmbedding`:

| Column | Notes |
| --- | --- |
| `id`, `tenantId`, `cropId` | `cropId` references `ObjectCrop` (cascade delete), `tenantId` references `Tenant` |
| `modelName`, `modelVersion`, `modelSha256`, `adapterId`, `inferenceId` | Which model and inference produced the vector |
| `dim` | Always 768 (check constraint) |
| `embedding` | `vector(768)` |

Constraints and indexes:

- unique `(cropId, modelSha256)`: one vector per crop per model;
- `modelSha256` must be 64 lower-case hex digits;
- `(tenantId, modelSha256)` index for the tenant and model pre-filter;
- HNSW index on `embedding` with `vector_cosine_ops`, `m = 16`, `ef_construction = 64`. It is created in the
  migration because Prisma has no syntax for it.

## Query

`searchSimilar` (`backend/src/services/search/cropEmbeddingStore.ts`):

- **Ranking:** results are ordered by cosine distance (`<=>`), and the score is `1 - distance`.
- **Filters:** tenant, model SHA-256, cameras, time range, object classes, and person or non-person crops.
  Person crops need their own permission and a declared purpose (`routes/cropSearch.routes.ts`).
- **Approximate search:** sets `hnsw.ef_search` to `max(100, 4 × limit)` for that query only.
- **Exact search:** turns index scans off for that one transaction (`exact: true`).
- **Model versions:** vectors from different model versions are never compared, because the query is restricted
  to one `modelSha256`.
