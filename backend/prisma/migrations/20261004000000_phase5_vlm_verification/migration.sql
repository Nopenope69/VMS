
-- CreateTable
CREATE TABLE "VlmVerification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "cameraId" TEXT,
    "detectionEventId" TEXT,
    "imageSource" TEXT NOT NULL,
    "imageSha256" TEXT NOT NULL,
    "targetClass" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "promptSha256" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "modelSha256" TEXT NOT NULL,
    "adapterId" TEXT NOT NULL,
    "inferenceId" TEXT NOT NULL,
    "provenanceJson" JSONB NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VlmVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VlmVerification_tenantId_createdAt_idx" ON "VlmVerification"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VlmVerification_alarmId_modelSha256_key" ON "VlmVerification"("alarmId", "modelSha256");

-- AddForeignKey
ALTER TABLE "VlmVerification" ADD CONSTRAINT "VlmVerification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VlmVerification" ADD CONSTRAINT "VlmVerification_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Only the three answers, well-formed hashes, a known image source.
ALTER TABLE "VlmVerification" ADD CONSTRAINT "VlmVerification_answer_check" CHECK ("answer" IN ('yes', 'no', 'unclear'));
ALTER TABLE "VlmVerification" ADD CONSTRAINT "VlmVerification_imageSource_check" CHECK ("imageSource" IN ('SNAPSHOT', 'CROP'));
ALTER TABLE "VlmVerification" ADD CONSTRAINT "VlmVerification_hashes_check" CHECK ("imageSha256" ~ '^[a-f0-9]{64}$' AND "promptSha256" ~ '^[a-f0-9]{64}$' AND "modelSha256" ~ '^[a-f0-9]{64}$');
ALTER TABLE "VlmVerification" ADD CONSTRAINT "VlmVerification_latency_check" CHECK ("latencyMs" >= 0);
