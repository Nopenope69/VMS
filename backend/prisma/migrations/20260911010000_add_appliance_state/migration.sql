-- CreateTable
CREATE TABLE "ApplianceState" (
    "id" TEXT NOT NULL DEFAULT 'SINGLETON',
    "isBootstrapped" BOOLEAN NOT NULL DEFAULT false,
    "bootstrappedAt" TIMESTAMP(3),
    "initializationVersion" TEXT DEFAULT '1.0.0',
    "applianceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplianceState_pkey" PRIMARY KEY ("id")
);

-- Initialize singleton default record if not present
INSERT INTO "ApplianceState" ("id", "isBootstrapped", "initializationVersion", "applianceId", "updatedAt")
VALUES ('SINGLETON', false, '1.0.0', gen_random_uuid()::text, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
