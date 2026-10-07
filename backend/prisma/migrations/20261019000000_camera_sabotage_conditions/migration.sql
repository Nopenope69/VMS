-- Camera-sabotage conditions (ADR 0019): one row per reported condition, closed when the worker reports it gone.
CREATE TABLE "CameraSabotageCondition" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "clearedAt" TIMESTAMP(3),
    "clearReason" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "measurementsJson" JSONB NOT NULL,
    "eventId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraSabotageCondition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CameraSabotageCondition_type_check" CHECK ("changeType" IN ('OCCLUSION', 'DEFOCUS', 'DISPLACEMENT', 'BLINDED')),
    CONSTRAINT "CameraSabotageCondition_clear_check" CHECK (("clearedAt" IS NULL AND "clearReason" IS NULL) OR ("clearedAt" IS NOT NULL AND "clearReason" IN ('RESTORED', 'RELEARNED')))
);

CREATE UNIQUE INDEX "CameraSabotageCondition_eventId_key" ON "CameraSabotageCondition"("eventId");
CREATE INDEX "CameraSabotageCondition_tenantId_cameraId_confirmedAt_idx" ON "CameraSabotageCondition"("tenantId", "cameraId", "confirmedAt");

ALTER TABLE "CameraSabotageCondition" ADD CONSTRAINT "CameraSabotageCondition_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;
