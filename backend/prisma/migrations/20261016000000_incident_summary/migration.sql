-- Incident summary snapshots (ADR 0016).
CREATE TABLE "IncidentSummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "cameraId" TEXT,
    "alarmTriggeredAt" TIMESTAMP(3) NOT NULL,
    "summaryId" TEXT NOT NULL,
    "templateVersion" TEXT NOT NULL,
    "factsSha256" TEXT NOT NULL,
    "recordSha256" TEXT NOT NULL,
    "recordJson" JSONB NOT NULL,
    "generatedById" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncidentSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IncidentSummary_summaryId_key" ON "IncidentSummary"("summaryId");
CREATE INDEX "IncidentSummary_tenantId_cameraId_alarmTriggeredAt_idx" ON "IncidentSummary"("tenantId", "cameraId", "alarmTriggeredAt");
CREATE INDEX "IncidentSummary_alarmId_generatedAt_idx" ON "IncidentSummary"("alarmId", "generatedAt");

ALTER TABLE "IncidentSummary" ADD CONSTRAINT "IncidentSummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IncidentSummary" ADD CONSTRAINT "IncidentSummary_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;
