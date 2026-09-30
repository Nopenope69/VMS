-- Phase 5 Wave A: explanation records, object-crop metadata and the per-site person-crop switch.
-- CreateTable
CREATE TABLE "Explanation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "cameraId" TEXT,
    "alarmTriggeredAt" TIMESTAMP(3) NOT NULL,
    "explanationId" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "recordSha256" TEXT NOT NULL,
    "recordJson" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Explanation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectCrop" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "detectionEventId" TEXT,
    "cropClass" TEXT NOT NULL,
    "objectClass" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteLength" INTEGER NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObjectCrop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteCropPolicy" (
    "siteId" TEXT NOT NULL,
    "personCropsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedPurpose" TEXT,
    "acknowledgedByUserId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "nonPersonRetentionDays" INTEGER,
    "personRetentionDays" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteCropPolicy_pkey" PRIMARY KEY ("siteId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Explanation_explanationId_key" ON "Explanation"("explanationId");

-- CreateIndex
CREATE INDEX "Explanation_tenantId_cameraId_alarmTriggeredAt_idx" ON "Explanation"("tenantId", "cameraId", "alarmTriggeredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Explanation_alarmId_templateVersion_key" ON "Explanation"("alarmId", "templateVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectCrop_detectionEventId_key" ON "ObjectCrop"("detectionEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectCrop_relativePath_key" ON "ObjectCrop"("relativePath");

-- CreateIndex
CREATE INDEX "ObjectCrop_expiresAt_idx" ON "ObjectCrop"("expiresAt");

-- CreateIndex
CREATE INDEX "ObjectCrop_tenantId_cameraId_capturedAt_idx" ON "ObjectCrop"("tenantId", "cameraId", "capturedAt");

-- AddForeignKey
ALTER TABLE "Explanation" ADD CONSTRAINT "Explanation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Explanation" ADD CONSTRAINT "Explanation_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectCrop" ADD CONSTRAINT "ObjectCrop_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectCrop" ADD CONSTRAINT "ObjectCrop_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectCrop" ADD CONSTRAINT "ObjectCrop_detectionEventId_fkey" FOREIGN KEY ("detectionEventId") REFERENCES "DetectionEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteCropPolicy" ADD CONSTRAINT "SiteCropPolicy_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The database refuses what the application must never write (same approach as the Phase 4 tables).
ALTER TABLE "Explanation" ADD CONSTRAINT "Explanation_hashes_check"
  CHECK ("explanationId" ~ '^[a-f0-9]{64}$' AND "recordSha256" ~ '^[a-f0-9]{64}$' AND length("templateVersion") > 0);
ALTER TABLE "ObjectCrop" ADD CONSTRAINT "ObjectCrop_class_check"
  CHECK ("cropClass" IN ('PERSON', 'NON_PERSON'));
ALTER TABLE "ObjectCrop" ADD CONSTRAINT "ObjectCrop_sha256_check"
  CHECK ("sha256" ~ '^[a-f0-9]{64}$' AND "byteLength" > 0 AND "expiresAt" > "capturedAt");
-- Person crops on a site need a recorded purpose and who acknowledged it; retention overrides are bounded.
ALTER TABLE "SiteCropPolicy" ADD CONSTRAINT "SiteCropPolicy_person_ack_check"
  CHECK ("personCropsEnabled" = false OR ("acknowledgedPurpose" IS NOT NULL AND length(btrim("acknowledgedPurpose")) > 0 AND "acknowledgedByUserId" IS NOT NULL AND "acknowledgedAt" IS NOT NULL));
ALTER TABLE "SiteCropPolicy" ADD CONSTRAINT "SiteCropPolicy_retention_check"
  CHECK (("nonPersonRetentionDays" IS NULL OR "nonPersonRetentionDays" BETWEEN 1 AND 3650) AND ("personRetentionDays" IS NULL OR "personRetentionDays" BETWEEN 1 AND 3650));
