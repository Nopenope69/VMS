-- Segment seals (ADR 0018). No foreign keys: a seal outlives its segment and camera.
CREATE TABLE "SegmentSeal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "cameraId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "segmentId" TEXT NOT NULL,
    "startUtc" TIMESTAMP(3) NOT NULL,
    "endUtc" TIMESTAMP(3) NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mediaSha256" TEXT NOT NULL,
    "prevSealHash" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "sealHash" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentSeal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SegmentSeal_sequence_check" CHECK ("sequence" >= 1),
    CONSTRAINT "SegmentSeal_hashes_check" CHECK ("mediaSha256" ~ '^[0-9a-f]{64}$' AND "prevSealHash" ~ '^[0-9a-f]{64}$' AND "sealHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "SegmentSeal_segmentId_key" ON "SegmentSeal"("segmentId");
CREATE UNIQUE INDEX "SegmentSeal_sealHash_key" ON "SegmentSeal"("sealHash");
CREATE UNIQUE INDEX "SegmentSeal_cameraId_sequence_key" ON "SegmentSeal"("cameraId", "sequence");
