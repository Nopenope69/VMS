-- P4.1: LPR camera mode, watchlist match types, recognition provenance on plate observations.
-- AlterTable
ALTER TABLE "Camera" ADD COLUMN     "lprConfigJson" JSONB,
ADD COLUMN     "lprMode" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "VehicleObservation" ADD COLUMN     "lines" INTEGER,
ADD COLUMN     "plateFormat" TEXT,
ADD COLUMN     "provenanceJson" JSONB,
ADD COLUMN     "rawText" TEXT;

-- AlterTable
ALTER TABLE "VehicleWatchlist" ADD COLUMN     "matchType" TEXT NOT NULL DEFAULT 'EXACT';


ALTER TABLE "VehicleWatchlist" ADD CONSTRAINT "VehicleWatchlist_matchType_check" CHECK ("matchType" IN ('EXACT', 'WILDCARD', 'REGEX'));
ALTER TABLE "VehicleObservation" ADD CONSTRAINT "VehicleObservation_lines_check" CHECK ("lines" IS NULL OR "lines" IN (1, 2));
