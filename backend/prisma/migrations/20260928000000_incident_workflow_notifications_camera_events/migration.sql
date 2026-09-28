-- Phase 3: incident workflow (assignment, SLA, escalation, evidence holds), alarm feedback,
-- notification delivery receipts and WhatsApp/SMS channels, camera event sources, CAMERA_ANALYTIC trigger.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationChannelType" ADD VALUE 'WHATSAPP';
ALTER TYPE "NotificationChannelType" ADD VALUE 'SMS';

-- AlterEnum
ALTER TYPE "RuleTriggerType" ADD VALUE 'CAMERA_ANALYTIC';

-- AlterTable
ALTER TABLE "Alarm" ADD COLUMN     "ackDueAt" TIMESTAMP(3),
ADD COLUMN     "ackSlaBreachedAt" TIMESTAMP(3),
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedToUserId" TEXT,
ADD COLUMN     "resolveDueAt" TIMESTAMP(3),
ADD COLUMN     "resolveSlaBreachedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "NotificationJob" ADD COLUMN     "escalationStep" INTEGER,
ADD COLUMN     "providerMessageId" TEXT;

-- AlterTable
ALTER TABLE "NotificationLog" ADD COLUMN     "deliveryStatus" TEXT,
ADD COLUMN     "deliveryUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT;

-- CreateTable
CREATE TABLE "AlarmSlaPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "severity" "EventSeverity" NOT NULL,
    "ackWithinMinutes" INTEGER NOT NULL,
    "resolveWithinMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlarmSlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSeverity" "EventSeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "stepsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscalationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlarmEscalation" (
    "id" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "channelIds" JSONB NOT NULL,
    "notificationsQueued" INTEGER NOT NULL DEFAULT 0,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlarmEscalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlarmFeedback" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reason" TEXT,
    "userId" TEXT NOT NULL,
    "automationRuleId" TEXT,
    "cameraId" TEXT,
    "modelSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlarmFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncidentEvidenceHold" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "segmentsPinned" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IncidentEvidenceHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraEventSource" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "lastEventAt" TIMESTAMP(3),
    "lastError" TEXT,
    "clockSkewMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraEventSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AlarmSlaPolicy_tenantId_severity_key" ON "AlarmSlaPolicy"("tenantId", "severity");

-- CreateIndex
CREATE INDEX "EscalationPolicy_tenantId_enabled_idx" ON "EscalationPolicy"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AlarmEscalation_alarmId_policyId_stepIndex_key" ON "AlarmEscalation"("alarmId", "policyId", "stepIndex");

-- CreateIndex
CREATE UNIQUE INDEX "AlarmFeedback_alarmId_key" ON "AlarmFeedback"("alarmId");

-- CreateIndex
CREATE INDEX "AlarmFeedback_tenantId_verdict_createdAt_idx" ON "AlarmFeedback"("tenantId", "verdict", "createdAt");

-- CreateIndex
CREATE INDEX "AlarmFeedback_automationRuleId_idx" ON "AlarmFeedback"("automationRuleId");

-- CreateIndex
CREATE INDEX "AlarmFeedback_modelSha256_idx" ON "AlarmFeedback"("modelSha256");

-- CreateIndex
CREATE INDEX "IncidentEvidenceHold_status_windowEnd_idx" ON "IncidentEvidenceHold"("status", "windowEnd");

-- CreateIndex
CREATE UNIQUE INDEX "IncidentEvidenceHold_alarmId_cameraId_key" ON "IncidentEvidenceHold"("alarmId", "cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "CameraEventSource_cameraId_protocol_key" ON "CameraEventSource"("cameraId", "protocol");

-- CreateIndex
CREATE INDEX "NotificationJob_providerMessageId_idx" ON "NotificationJob"("providerMessageId");

-- CreateIndex
CREATE INDEX "NotificationLog_providerMessageId_idx" ON "NotificationLog"("providerMessageId");

-- AddForeignKey
ALTER TABLE "AlarmSlaPolicy" ADD CONSTRAINT "AlarmSlaPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationPolicy" ADD CONSTRAINT "EscalationPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmEscalation" ADD CONSTRAINT "AlarmEscalation_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmEscalation" ADD CONSTRAINT "AlarmEscalation_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "EscalationPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmFeedback" ADD CONSTRAINT "AlarmFeedback_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmFeedback" ADD CONSTRAINT "AlarmFeedback_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncidentEvidenceHold" ADD CONSTRAINT "IncidentEvidenceHold_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraEventSource" ADD CONSTRAINT "CameraEventSource_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraEventSource" ADD CONSTRAINT "CameraEventSource_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- String-typed state columns are constrained at the database, not only in application code.
ALTER TABLE "AlarmFeedback" ADD CONSTRAINT "AlarmFeedback_verdict_check" CHECK ("verdict" IN ('FALSE_ALARM', 'TRUE_ALARM'));
ALTER TABLE "IncidentEvidenceHold" ADD CONSTRAINT "IncidentEvidenceHold_status_check" CHECK ("status" IN ('PENDING', 'COMPLETE', 'FAILED'));
ALTER TABLE "IncidentEvidenceHold" ADD CONSTRAINT "IncidentEvidenceHold_window_check" CHECK ("windowEnd" > "windowStart");
ALTER TABLE "CameraEventSource" ADD CONSTRAINT "CameraEventSource_protocol_check" CHECK ("protocol" IN ('ONVIF_PULLPOINT', 'HIKVISION_ISAPI', 'DAHUA_EVENT_MANAGER'));
ALTER TABLE "CameraEventSource" ADD CONSTRAINT "CameraEventSource_status_check" CHECK ("status" IN ('STOPPED', 'CONNECTING', 'RUNNING', 'BACKOFF', 'FAILED'));
ALTER TABLE "AlarmEscalation" ADD CONSTRAINT "AlarmEscalation_stepIndex_check" CHECK ("stepIndex" >= 0);
ALTER TABLE "AlarmSlaPolicy" ADD CONSTRAINT "AlarmSlaPolicy_minutes_check" CHECK ("ackWithinMinutes" > 0 AND ("resolveWithinMinutes" IS NULL OR "resolveWithinMinutes" > 0));
