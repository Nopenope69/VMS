-- DropIndex
DROP INDEX IF EXISTS "ChainOfCustodyLog_tenantId_evidenceId_sequenceNumber_idx";

-- AlterTable
ALTER TABLE "ChainOfCustodyLog" ALTER COLUMN "sequenceNumber" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ChainOfCustodyLog_tenantId_evidenceId_sequenceNumber_key" ON "ChainOfCustodyLog"("tenantId", "evidenceId", "sequenceNumber");
