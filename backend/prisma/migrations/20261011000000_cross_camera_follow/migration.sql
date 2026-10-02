-- Cross-camera following (North Star Bucket 3): camera neighbours and operator-decided track links.
-- CreateTable
CREATE TABLE "CameraNeighbour" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraAId" TEXT NOT NULL,
    "cameraBId" TEXT NOT NULL,
    "minTransitSeconds" INTEGER NOT NULL DEFAULT 0,
    "maxTransitSeconds" INTEGER NOT NULL DEFAULT 120,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CameraNeighbour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromTrackId" TEXT NOT NULL,
    "toTrackId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidenceJson" JSONB NOT NULL,
    "note" TEXT,
    "decidedByUserId" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CameraNeighbour_tenantId_idx" ON "CameraNeighbour"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CameraNeighbour_cameraAId_cameraBId_key" ON "CameraNeighbour"("cameraAId", "cameraBId");

-- CreateIndex
CREATE INDEX "TrackLink_toTrackId_idx" ON "TrackLink"("toTrackId");

-- CreateIndex
CREATE INDEX "TrackLink_tenantId_status_idx" ON "TrackLink"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TrackLink_fromTrackId_toTrackId_key" ON "TrackLink"("fromTrackId", "toTrackId");

-- AddForeignKey
ALTER TABLE "CameraNeighbour" ADD CONSTRAINT "CameraNeighbour_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraNeighbour" ADD CONSTRAINT "CameraNeighbour_cameraAId_fkey" FOREIGN KEY ("cameraAId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraNeighbour" ADD CONSTRAINT "CameraNeighbour_cameraBId_fkey" FOREIGN KEY ("cameraBId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackLink" ADD CONSTRAINT "TrackLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackLink" ADD CONSTRAINT "TrackLink_fromTrackId_fkey" FOREIGN KEY ("fromTrackId") REFERENCES "ObjectTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackLink" ADD CONSTRAINT "TrackLink_toTrackId_fkey" FOREIGN KEY ("toTrackId") REFERENCES "ObjectTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Pairs are stored once, in id order, and never link a track or camera to itself.
ALTER TABLE "CameraNeighbour" ADD CONSTRAINT "CameraNeighbour_ordered_check" CHECK ("cameraAId" < "cameraBId");
ALTER TABLE "CameraNeighbour" ADD CONSTRAINT "CameraNeighbour_transit_check" CHECK ("minTransitSeconds" >= 0 AND "maxTransitSeconds" >= "minTransitSeconds" AND "maxTransitSeconds" <= 86400);
ALTER TABLE "TrackLink" ADD CONSTRAINT "TrackLink_ordered_check" CHECK ("fromTrackId" < "toTrackId");
ALTER TABLE "TrackLink" ADD CONSTRAINT "TrackLink_method_check" CHECK ("method" IN ('PLATE', 'APPEARANCE'));
ALTER TABLE "TrackLink" ADD CONSTRAINT "TrackLink_status_check" CHECK ("status" IN ('CONFIRMED', 'REJECTED'));
