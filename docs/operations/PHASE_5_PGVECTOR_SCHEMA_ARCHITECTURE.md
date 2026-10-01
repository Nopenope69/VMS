# Phase 5: Semantic Forensic Search & pgvector Schema Architecture

> **Authoritative Technical Specification: Database Tier (PostgreSQL + pgvector)**  
> **Status:** APPROVED FOR IMPLEMENTATION  
> **Applicable Subsystems:** `backend/prisma/schema.prisma`, `services/ai-worker`, `backend/src/services/search/smartSearch.service.ts`

---

## 1. Workload Characterization & Scale Targets

VigilOne Edge Appliances process continuous CCTV footage with local AI worker decimation:
- **Vision-Language Model:** `siglip2-base-p16-224` vision encoder generates **768-dimensional** dense unit-normalized float embeddings from keyframe crops (1 keyframe per 2–5 seconds during motion/active episodes).
- **Scale on 16-Camera Appliance:**
  - $\sim 17,280$ embeddings per camera/day $\approx 276,000$ rows/day.
  - 30-day retention envelope: $\approx 8.3 \times 10^6$ rows.
  - 768-dimensional float32 vector = $768 \times 4 = 3,072$ bytes payload per embedding ($\approx 25.5$ GB raw vector storage for 30 days).
- **Query Patterns:**
  1. *Natural Language Forensic Prompt:* Text query encoded by `siglip2-base-p16-224-text` $\rightarrow$ find nearest keyframe vectors filtered by `tenantId`, `cameraId` (optional list), and `[startTime, endTime]`.
  2. *Visual Query by Example:* Crop of interest $\rightarrow$ nearest neighbor vector search across historical timeline.
  3. *Zero False Multi-Tenancy Leaks:* A similarity search must NEVER return vectors belonging to another tenant under any cosine proximity score.

---

## 2. PostgreSQL Schema Definition

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums
DO $$ BEGIN
    CREATE TYPE "EmbeddingTargetKind" AS ENUM ('FULL_FRAME', 'OBJECT_CROP', 'ANPR_PLATE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. Visual Keyframe & Object Embeddings Table
CREATE TABLE "VisualEmbedding" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "segmentId" TEXT,
    "targetKind" "EmbeddingTargetKind" NOT NULL DEFAULT 'FULL_FRAME',
    "sampledAt" TIMESTAMPTZ NOT NULL,
    "pts" BIGINT,
    
    -- Normalized bounding box [0..1] in camera coordinates if targetKind == OBJECT_CROP
    "bboxX" DOUBLE PRECISION,
    "bboxY" DOUBLE PRECISION,
    "bboxWidth" DOUBLE PRECISION,
    "bboxHeight" DOUBLE PRECISION,
    
    -- Model Provenance
    "modelName" TEXT NOT NULL DEFAULT 'siglip2-base-p16-224-vision',
    "modelVersion" TEXT NOT NULL DEFAULT 'v1',
    "modelSha256" TEXT NOT NULL,
    
    -- 768-dimensional dense vector
    "embedding" vector(768) NOT NULL,
    
    -- Context metadata (tags, labels, OCR text if plate)
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "VisualEmbedding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VisualEmbedding_tenantId_fkey" FOREIGN KEY ("tenantId") 
        REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VisualEmbedding_cameraId_fkey" FOREIGN KEY ("cameraId") 
        REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VisualEmbedding_segmentId_fkey" FOREIGN KEY ("segmentId") 
        REFERENCES "RecordingSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
```

---

## 3. Indexing Strategy: HNSW vs. IVFFlat for Edge Appliances

For edge appliances operating in air-gapped environments without database administrator intervention:
- **Decision: HNSW (`Hierarchical Navigable Small World`)** is chosen over IVFFlat.
  - **Reason 1: Zero Re-Training Requirement.** IVFFlat requires building Voronoi centroids (`lists = 1000`) based on existing data; if trained on day 1 with 1,000 vectors, it becomes severely unbalanced and degraded as 8 million vectors accumulate over 30 days. HNSW incrementally builds its graph with zero offline retraining.
  - **Reason 2: High Recall at Low Latency.** HNSW delivers $>98\%$ recall at $p99 < 8$ ms on 8M vectors on commodity x86 hardware.

### Production Index Declarations

```sql
-- 1. Vector Similarity Index (Cosine metric for normalized SigLIP embeddings)
CREATE INDEX "VisualEmbedding_embedding_hnsw_idx" 
ON "VisualEmbedding" 
USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 2. Tenant & Temporal Composite Index for Pre-Filtering
CREATE INDEX "VisualEmbedding_tenant_camera_sampledAt_idx" 
ON "VisualEmbedding" ("tenantId", "cameraId", "sampledAt" DESC);

-- 3. Temporal Cleanup Index for Retention Purge
CREATE INDEX "VisualEmbedding_sampledAt_idx" 
ON "VisualEmbedding" ("sampledAt" ASC);
```

---

## 4. Query Architecture with Safe Multi-Tenancy & Iterative Index Scans

In PostgreSQL with `pgvector` 0.7+, iterative index scans automatically handle combined vector searches with scalar pre-filters (`tenantId`, `cameraId`, `sampledAt`):

```sql
-- Canonical Forensic Semantic Search Query
EXPLAIN (ANALYZE, BUFFERS)
SELECT 
    v."id",
    v."cameraId",
    v."sampledAt",
    v."pts",
    v."bboxX", v."bboxY", v."bboxWidth", v."bboxHeight",
    1 - (v."embedding" <=> $1::vector) AS "similarityScore"
FROM "VisualEmbedding" v
WHERE v."tenantId" = $2
  AND v."cameraId" = ANY($3::text[])
  AND v."sampledAt" >= $4::timestamptz
  AND v."sampledAt" <= $5::timestamptz
  AND (v."embedding" <=> $1::vector) < (1 - $6::float8) -- Filter by minimum similarity threshold
ORDER BY v."embedding" <=> $1::vector ASC
LIMIT $7;
```

---

## 5. Invariants & Media Plane Isolation

1. **Surveillance Path Sovereignty:** Embeddings are generated strictly from background decimation loops. If embedding generation backs up, frames are dropped in `BoundedFrameQueue`; under no circumstances may embedding calculation or vector inserts block RTSP ingestion or fMP4 disk writes.
2. **Deterministic Retention Cascading:** When `RetentionPolicy` prunes segments past site limits, embeddings whose `sampledAt < retentionFloor` and that have no active legal pin (`EvidencePin`) are purged during off-peak hours via `DELETE ... WHERE "sampledAt" < ...`.
3. **Model Version Invariant:** Embeddings generated with model version $V_A$ must never be compared against text query vectors generated with model version $V_B$. Queries enforce `WHERE "modelSha256" = $modelSha256`.
