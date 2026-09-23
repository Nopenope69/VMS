-- AlterTable
ALTER TABLE "DetectionEvent" ADD COLUMN     "inferenceId" TEXT,
ADD COLUMN     "modelManifestId" TEXT;

-- CreateTable
CREATE TABLE "ModelManifest" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "codeLicense" TEXT NOT NULL,
    "weightLicense" TEXT NOT NULL,
    "trainingDataJson" JSONB NOT NULL,
    "thresholdsJson" JSONB,
    "runtimeConfigJson" JSONB NOT NULL,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT false,
    "noticeRequired" BOOLEAN NOT NULL DEFAULT false,
    "licenseNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelManifest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelManifest_name_version_sha256_idx" ON "ModelManifest"("name", "version", "sha256");

-- CreateIndex
CREATE INDEX "ModelManifest_isActive_idx" ON "ModelManifest"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ModelManifest_name_version_key" ON "ModelManifest"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DetectionEvent_inferenceId_key" ON "DetectionEvent"("inferenceId");

-- CreateIndex
CREATE INDEX "DetectionEvent_modelManifestId_idx" ON "DetectionEvent"("modelManifestId");

-- AddForeignKey
ALTER TABLE "DetectionEvent" ADD CONSTRAINT "DetectionEvent_modelManifestId_fkey" FOREIGN KEY ("modelManifestId") REFERENCES "ModelManifest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
