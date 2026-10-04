-- Threat detections without a new model (unattended object, wrong way). The detector now also tracks carried
-- objects (backpack, handbag, suitcase) as OBJECT_DETECTED; the two new spatial rule types keep their own settings
-- in paramsJson.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'OBJECT_DETECTED' AFTER 'VEHICLE_DETECTED';
ALTER TABLE "SpatialAnalyticsRule" ADD COLUMN "paramsJson" JSONB;
ALTER TYPE "RuleTriggerType" ADD VALUE IF NOT EXISTS 'UNATTENDED_OBJECT' AFTER 'LOITERING_DWELL';
ALTER TYPE "RuleTriggerType" ADD VALUE IF NOT EXISTS 'WRONG_WAY' AFTER 'UNATTENDED_OBJECT';
