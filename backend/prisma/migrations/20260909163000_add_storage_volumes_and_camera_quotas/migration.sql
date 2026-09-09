-- CreateEnum
CREATE TYPE "VolumeStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'READ_ONLY', 'UNMOUNTED');

-- CreateEnum
CREATE TYPE "RetentionPriority" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "DegradationReason" AS ENUM ('NONE', 'STORAGE_PRESSURE_WARNING', 'STORAGE_PRESSURE_CRITICAL', 'EVIDENCE_PRESERVATION');

-- AlterEnum
ALTER TYPE "SegmentStatus" ADD VALUE IF NOT EXISTS 'FILE_MISSING';
ALTER TYPE "SegmentStatus" ADD VALUE IF NOT EXISTS 'QUARANTINED';
ALTER TYPE "SegmentStatus" ADD VALUE IF NOT EXISTS 'RECOVERY_FAILED';

-- AlterEnum
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_FAILOVER';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_DEGRADED_MODE_ACTIVE';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_DEGRADED_MODE_CLEARED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_VOLUME_DEGRADED';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_VOLUME_READONLY';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_EVIDENCE_DEADLOCK_PREVENTION';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'STORAGE_CORRUPT_SEGMENT_QUARANTINED';

-- AlterTable
ALTER TABLE "RetentionPolicy" ADD COLUMN "maxStorageGigabytes" INTEGER;

-- CreateTable
CREATE TABLE "StorageVolume" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "deviceIdentifier" TEXT,
    "mountSource" TEXT,
    "filesystemType" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "maxBytes" BIGINT,
    "status" "VolumeStatus" NOT NULL DEFAULT 'HEALTHY',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHealthyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailureAt" TIMESTAMP(3),
    "healthReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageVolume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageEpoch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "epochNumber" INTEGER NOT NULL,
    "storageVolumeId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "transitionReason" TEXT,
    "prevEpochHash" TEXT,
    "epochHash" TEXT,
    "metadataJson" JSONB,

    CONSTRAINT "StorageEpoch_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Camera" ADD COLUMN "storageVolumeId" TEXT,
ADD COLUMN "retentionPriority" "RetentionPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN "effectiveRecordingMode" "RecordingMode" NOT NULL DEFAULT 'CONTINUOUS',
ADD COLUMN "degradationReason" "DegradationReason" NOT NULL DEFAULT 'NONE',
ADD COLUMN "degradationSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RecordingSegment" ADD COLUMN "storageVolumeId" TEXT,
ADD COLUMN "storageEpochId" TEXT,
ADD COLUMN "originalSha256" TEXT,
ADD COLUMN "repairedSha256" TEXT,
ADD COLUMN "repairedAt" TIMESTAMP(3),
ADD COLUMN "quarantineReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "StorageVolume_path_key" ON "StorageVolume"("path");

-- CreateIndex
CREATE INDEX "StorageVolume_tenantId_status_idx" ON "StorageVolume"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StorageEpoch_tenantId_cameraId_epochNumber_idx" ON "StorageEpoch"("tenantId", "cameraId", "epochNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StorageEpoch_cameraId_epochNumber_key" ON "StorageEpoch"("cameraId", "epochNumber");

-- AddForeignKey
ALTER TABLE "StorageVolume" ADD CONSTRAINT "StorageVolume_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEpoch" ADD CONSTRAINT "StorageEpoch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEpoch" ADD CONSTRAINT "StorageEpoch_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEpoch" ADD CONSTRAINT "StorageEpoch_storageVolumeId_fkey" FOREIGN KEY ("storageVolumeId") REFERENCES "StorageVolume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_storageVolumeId_fkey" FOREIGN KEY ("storageVolumeId") REFERENCES "StorageVolume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_storageVolumeId_fkey" FOREIGN KEY ("storageVolumeId") REFERENCES "StorageVolume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_storageEpochId_fkey" FOREIGN KEY ("storageEpochId") REFERENCES "StorageEpoch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
