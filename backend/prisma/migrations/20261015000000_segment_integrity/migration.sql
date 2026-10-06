-- Periodic integrity checks on recorded segments (RecordingCatalog audit, F7): when the cheap presence/size check and
-- the content-hash check last looked at each segment, so the checks go round all of them, least recently checked first.
ALTER TABLE "RecordingSegment" ADD COLUMN "integrityCheckedAt" TIMESTAMP(3);
ALTER TABLE "RecordingSegment" ADD COLUMN "hashVerifiedAt" TIMESTAMP(3);
CREATE INDEX "RecordingSegment_status_integrityCheckedAt_idx" ON "RecordingSegment"("status", "integrityCheckedAt");
CREATE INDEX "RecordingSegment_status_hashVerifiedAt_idx" ON "RecordingSegment"("status", "hashVerifiedAt");
