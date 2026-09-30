-- AlterTable
ALTER TABLE "FederatedNode" ADD COLUMN     "deprovisionedAt" TIMESTAMP(3),
ADD COLUMN     "lastLogHash" TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
ADD COLUMN     "syncCursorLog" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "FederatedRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dataJson" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederatedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationPairingToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tokenSha256" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationPairingToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationOutbox" (
    "seq" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "dataJson" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationOutbox_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "FederationUplinkState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "nodeUuid" TEXT NOT NULL,
    "hqUrl" TEXT NOT NULL,
    "hqTenantId" TEXT NOT NULL,
    "localTenantId" TEXT NOT NULL,
    "ackedSeq" BIGINT NOT NULL DEFAULT 0,
    "eventWatermark" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00 +00:00',
    "eventWatermarkId" TEXT NOT NULL DEFAULT '',
    "alarmWatermark" TIMESTAMP(3) NOT NULL DEFAULT '1970-01-01 00:00:00 +00:00',
    "alarmWatermarkId" TEXT NOT NULL DEFAULT '',
    "auditWatermark" BIGINT NOT NULL DEFAULT 0,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FederationUplinkState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FederatedRecord_tenantId_kind_occurredAt_idx" ON "FederatedRecord"("tenantId", "kind", "occurredAt");

-- CreateIndex
CREATE INDEX "FederatedRecord_nodeId_kind_sourceId_idx" ON "FederatedRecord"("nodeId", "kind", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedRecord_nodeId_seq_key" ON "FederatedRecord"("nodeId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "FederationPairingToken_tokenSha256_key" ON "FederationPairingToken"("tokenSha256");

-- CreateIndex
CREATE UNIQUE INDEX "FederationOutbox_hash_key" ON "FederationOutbox"("hash");

-- AddForeignKey
ALTER TABLE "FederatedRecord" ADD CONSTRAINT "FederatedRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FederatedRecord" ADD CONSTRAINT "FederatedRecord_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "FederatedNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FederationPairingToken" ADD CONSTRAINT "FederationPairingToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only known record kinds; well-formed hashes; one uplink state row.
ALTER TABLE "FederatedRecord" ADD CONSTRAINT "FederatedRecord_kind_check" CHECK ("kind" IN ('EVENT', 'ALARM', 'AUDIT'));
ALTER TABLE "FederatedRecord" ADD CONSTRAINT "FederatedRecord_hash_check" CHECK ("hash" ~ '^[a-f0-9]{64}$' AND "prevHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "FederationOutbox" ADD CONSTRAINT "FederationOutbox_kind_check" CHECK ("kind" IN ('EVENT', 'ALARM', 'AUDIT'));
ALTER TABLE "FederationOutbox" ADD CONSTRAINT "FederationOutbox_hash_check" CHECK ("hash" ~ '^[a-f0-9]{64}$' AND "prevHash" ~ '^[a-f0-9]{64}$');
ALTER TABLE "FederationUplinkState" ADD CONSTRAINT "FederationUplinkState_singleton_check" CHECK ("id" = 1);
