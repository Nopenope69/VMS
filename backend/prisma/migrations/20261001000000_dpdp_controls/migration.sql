-- P4.6: DPDP controls (face switch default off, retention for plate reads and snapshots, allowed query purposes).
-- CreateTable
CREATE TABLE "DataProtectionSettings" (
    "tenantId" TEXT NOT NULL,
    "faceProcessingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "plateRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "detectionSnapshotRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "allowedPurposes" TEXT[] DEFAULT ARRAY['SECURITY_INCIDENT_INVESTIGATION', 'LAW_ENFORCEMENT_REQUEST', 'ACCESS_CONTROL', 'SAFETY_EMERGENCY', 'LEGAL_CLAIM', 'AUDIT_REVIEW']::TEXT[],
    "lastPurgeAt" TIMESTAMP(3),
    "lastPurgeJson" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "DataProtectionSettings_pkey" PRIMARY KEY ("tenantId")
);

-- AddForeignKey
ALTER TABLE "DataProtectionSettings" ADD CONSTRAINT "DataProtectionSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "DataProtectionSettings" ADD CONSTRAINT "DataProtectionSettings_retention_check"
  CHECK ("plateRetentionDays" BETWEEN 1 AND 3650 AND "detectionSnapshotRetentionDays" BETWEEN 1 AND 3650);
ALTER TABLE "DataProtectionSettings" ADD CONSTRAINT "DataProtectionSettings_purposes_check"
  CHECK ("allowedPurposes" <@ ARRAY['SECURITY_INCIDENT_INVESTIGATION', 'LAW_ENFORCEMENT_REQUEST', 'ACCESS_CONTROL', 'SAFETY_EMERGENCY', 'LEGAL_CLAIM', 'AUDIT_REVIEW']::TEXT[]);
