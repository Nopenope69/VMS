-- Phase 2 (P2.3/P2.6/P2.9): model signature, deployment state and evaluation on ModelManifest;
-- per-inference provenance on DetectionEvent; canonical orchestrator events; alarm links to the
-- canonical event and automation rule.
-- Also creates the Incident table (Step 4 spatial incidents), which was in schema.prisma without a
-- migration, so incident inserts failed on any database built with 'prisma migrate deploy'.

-- AlterTable
ALTER TABLE "Alarm" ADD COLUMN     "automationRuleId" TEXT,
ADD COLUMN     "canonicalEventId" TEXT;

-- AlterTable
ALTER TABLE "DetectionEvent" ADD COLUMN     "modelSha256" TEXT,
ADD COLUMN     "objectClass" TEXT,
ADD COLUMN     "provenanceJson" JSONB;

-- AlterTable
ALTER TABLE "ModelManifest" ADD COLUMN     "classesJson" JSONB,
ADD COLUMN     "deployed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "deployedAt" TIMESTAMP(3),
ADD COLUMN     "evaluationJson" JSONB,
ADD COLUMN     "modelSignatureJson" JSONB,
ADD COLUMN     "nmsConfigJson" JSONB,
ADD COLUMN     "task" TEXT NOT NULL DEFAULT 'object_detection',
ADD COLUMN     "weightsSource" TEXT;

-- CreateTable
CREATE TABLE "CanonicalEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'INFO',
    "timestampUtc" TIMESTAMP(3) NOT NULL,
    "correlationId" TEXT NOT NULL,
    "trackId" TEXT,
    "payloadJson" JSONB NOT NULL,
    "provenanceJson" JSONB,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CanonicalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "ruleId" TEXT,
    "trackId" TEXT NOT NULL,
    "cooldownBucket" BIGINT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "EventSeverity" NOT NULL DEFAULT 'WARNING',
    "metadataJson" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CanonicalEvent_processedAt_createdAt_idx" ON "CanonicalEvent"("processedAt", "createdAt");

-- CreateIndex
CREATE INDEX "CanonicalEvent_tenantId_type_timestampUtc_idx" ON "CanonicalEvent"("tenantId", "type", "timestampUtc");

-- CreateIndex
CREATE INDEX "CanonicalEvent_tenantId_cameraId_timestampUtc_idx" ON "CanonicalEvent"("tenantId", "cameraId", "timestampUtc");

-- CreateIndex
CREATE INDEX "CanonicalEvent_correlationId_idx" ON "CanonicalEvent"("correlationId");

-- CreateIndex
CREATE INDEX "Incident_tenantId_cameraId_timestamp_idx" ON "Incident"("tenantId", "cameraId", "timestamp");

-- CreateIndex
CREATE INDEX "Incident_ruleId_trackId_idx" ON "Incident"("ruleId", "trackId");

-- CreateIndex
CREATE UNIQUE INDEX "Incident_cameraId_ruleId_trackId_cooldownBucket_key" ON "Incident"("cameraId", "ruleId", "trackId", "cooldownBucket");

-- CreateIndex
CREATE INDEX "DetectionEvent_modelSha256_idx" ON "DetectionEvent"("modelSha256");

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_canonicalEventId_fkey" FOREIGN KEY ("canonicalEventId") REFERENCES "CanonicalEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_automationRuleId_fkey" FOREIGN KEY ("automationRuleId") REFERENCES "AutomationRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CanonicalEvent" ADD CONSTRAINT "CanonicalEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SpatialAnalyticsRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

