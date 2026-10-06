-- Body-pose threat rules (person down, fence climbing). They read the pose the ai-worker attaches to confirmed person
-- detections and keep their own settings in SpatialAnalyticsRule.paramsJson (already present).
ALTER TYPE "RuleTriggerType" ADD VALUE IF NOT EXISTS 'PERSON_DOWN' AFTER 'WRONG_WAY';
ALTER TYPE "RuleTriggerType" ADD VALUE IF NOT EXISTS 'FENCE_CLIMB' AFTER 'PERSON_DOWN';
