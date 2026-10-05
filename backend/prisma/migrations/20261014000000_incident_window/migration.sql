-- Incident window (ADR 0014): a later trigger of the same rule on the same camera can join an open alarm
-- instead of raising a new one. Existing alarms keep one occurrence and no window.
ALTER TABLE "Alarm" ADD COLUMN "lastActivityAt" TIMESTAMP(3);
ALTER TABLE "Alarm" ADD COLUMN "occurrenceCount" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Alarm" ADD COLUMN "lastCanonicalEventId" TEXT;
CREATE INDEX "Alarm_tenantId_automationRuleId_cameraId_state_idx" ON "Alarm"("tenantId", "automationRuleId", "cameraId", "state");
