-- Track index (feature TRACK_INDEX): one row per tracked object per camera. services/tracks/trackIndex.service.ts.
-- CreateTable
CREATE TABLE "ObjectTrack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "objectClass" TEXT NOT NULL,
    "classVotesJson" JSONB NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "dwellSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observationCount" INTEGER NOT NULL DEFAULT 0,
    "maxConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bestDetectionId" TEXT,
    "pathJson" JSONB NOT NULL,
    "direction" TEXT,
    "zonesJson" JSONB NOT NULL,
    "zoneIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "colourVotesJson" JSONB NOT NULL,
    "upperColour" TEXT,
    "lowerColour" TEXT,
    "bodyColour" TEXT,
    "vehicleObservationId" TEXT,
    "modelSha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObjectTrack_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ObjectTrack_tenantId_lastSeenAt_idx" ON "ObjectTrack"("tenantId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ObjectTrack_tenantId_objectClass_lastSeenAt_idx" ON "ObjectTrack"("tenantId", "objectClass", "lastSeenAt");

-- CreateIndex
CREATE INDEX "ObjectTrack_vehicleObservationId_idx" ON "ObjectTrack"("vehicleObservationId");

-- CreateIndex
CREATE INDEX "ObjectTrack_zoneIds_idx" ON "ObjectTrack" USING GIN ("zoneIds");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectTrack_cameraId_trackId_key" ON "ObjectTrack"("cameraId", "trackId");

-- AddForeignKey
ALTER TABLE "ObjectTrack" ADD CONSTRAINT "ObjectTrack_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectTrack" ADD CONSTRAINT "ObjectTrack_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectTrack" ADD CONSTRAINT "ObjectTrack_vehicleObservationId_fkey" FOREIGN KEY ("vehicleObservationId") REFERENCES "VehicleObservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

