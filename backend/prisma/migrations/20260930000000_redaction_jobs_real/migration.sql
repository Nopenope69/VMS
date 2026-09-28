-- P4.4: real redaction jobs. Detector kinds, sampling, provenance, output facts; modelVersion has no invented default.
-- AlterTable
ALTER TABLE "RedactionJob" ADD COLUMN     "cameraId" TEXT,
ADD COLUMN     "detectKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "maskCount" INTEGER,
ADD COLUMN     "outputBytes" BIGINT,
ADD COLUMN     "provenanceJson" JSONB,
ADD COLUMN     "sampleFps" DOUBLE PRECISION NOT NULL DEFAULT 4,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ALTER COLUMN "modelVersion" DROP NOT NULL,
ALTER COLUMN "modelVersion" DROP DEFAULT;


ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_detectKinds_check" CHECK ("detectKinds" <@ ARRAY['FACE', 'LICENSE_PLATE']::TEXT[]);
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_sampleFps_check" CHECK ("sampleFps" >= 0.5 AND "sampleFps" <= 10);
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_outputBytes_check" CHECK ("outputBytes" IS NULL OR "outputBytes" > 0);
-- A job can only be COMPLETED with a hashed, non-empty output file. NOT VALID: rows written by the
-- pre-P4.4 code are not re-checked, every new write is.
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_completed_output_check"
  CHECK ("status" <> 'COMPLETED' OR ("outputSha256" IS NOT NULL AND "outputSha256" ~ '^[a-f0-9]{64}$' AND "outputBytes" IS NOT NULL AND "outputBytes" > 0 AND "outputObjectKey" IS NOT NULL)) NOT VALID;
