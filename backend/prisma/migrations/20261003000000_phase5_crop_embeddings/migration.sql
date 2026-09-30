-- Phase 5 (P5.3): crop embeddings for semantic search. Requires the pgvector extension: the database image
-- must include it (pgvector/pgvector, see docker-compose.yml). If it is missing this migration fails, on purpose.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "CropEmbedding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cropId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "modelSha256" TEXT NOT NULL,
    "adapterId" TEXT NOT NULL,
    "inferenceId" TEXT,
    "dim" INTEGER NOT NULL,
    "embedding" vector(768) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CropEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CropEmbedding_tenantId_modelSha256_idx" ON "CropEmbedding"("tenantId", "modelSha256");

-- CreateIndex
CREATE UNIQUE INDEX "CropEmbedding_cropId_modelSha256_key" ON "CropEmbedding"("cropId", "modelSha256");

-- AddForeignKey
ALTER TABLE "CropEmbedding" ADD CONSTRAINT "CropEmbedding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CropEmbedding" ADD CONSTRAINT "CropEmbedding_cropId_fkey" FOREIGN KEY ("cropId") REFERENCES "ObjectCrop"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The vector column is fixed at 768 dimensions (SigLIP 2 base). A model with another size needs a new
-- column or table by migration; the row records its size and the database keeps the two consistent.
ALTER TABLE "CropEmbedding" ADD CONSTRAINT "CropEmbedding_dim_check" CHECK ("dim" = 768);
ALTER TABLE "CropEmbedding" ADD CONSTRAINT "CropEmbedding_sha256_check" CHECK ("modelSha256" ~ '^[a-f0-9]{64}$');

-- Approximate nearest neighbour by cosine distance. Created in the migration because Prisma has no syntax for it,
-- so `prisma migrate diff` reports it as the only difference from schema.prisma.
CREATE INDEX "CropEmbedding_embedding_hnsw" ON "CropEmbedding" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
