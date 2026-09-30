-- AlterEnum
ALTER TYPE "RuleTriggerType" ADD VALUE 'DOOR_EVENT';

-- AlterTable
ALTER TABLE "DigitalIoPin" ADD COLUMN     "address" INTEGER,
ADD COLUMN     "deviceId" TEXT;

-- CreateTable
CREATE TABLE "IoDevice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 502,
    "unitId" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IoDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Door" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cameraId" TEXT,
    "strikePinId" TEXT,
    "contactPinId" TEXT,
    "contactOpenWhenOn" BOOLEAN NOT NULL DEFAULT true,
    "unlockPulseMs" INTEGER NOT NULL DEFAULT 5000,
    "heldOpenSeconds" INTEGER NOT NULL DEFAULT 30,
    "unlockGraceSeconds" INTEGER NOT NULL DEFAULT 10,
    "state" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "stateChangedAt" TIMESTAMP(3),
    "lastUnlockAt" TIMESTAMP(3),
    "heldOpenAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Door_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IoDevice_tenantId_name_key" ON "IoDevice"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Door_strikePinId_key" ON "Door"("strikePinId");

-- CreateIndex
CREATE UNIQUE INDEX "Door_contactPinId_key" ON "Door"("contactPinId");

-- CreateIndex
CREATE UNIQUE INDEX "Door_tenantId_name_key" ON "Door"("tenantId", "name");

-- AddForeignKey
ALTER TABLE "DigitalIoPin" ADD CONSTRAINT "DigitalIoPin_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "IoDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IoDevice" ADD CONSTRAINT "IoDevice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Door" ADD CONSTRAINT "Door_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Door" ADD CONSTRAINT "Door_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Door" ADD CONSTRAINT "Door_strikePinId_fkey" FOREIGN KEY ("strikePinId") REFERENCES "DigitalIoPin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Door" ADD CONSTRAINT "Door_contactPinId_fkey" FOREIGN KEY ("contactPinId") REFERENCES "DigitalIoPin"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Known module kinds, sane addresses and timings, and a known door state.
ALTER TABLE "IoDevice" ADD CONSTRAINT "IoDevice_kind_check" CHECK ("kind" IN ('MODBUS_TCP'));
ALTER TABLE "IoDevice" ADD CONSTRAINT "IoDevice_port_check" CHECK ("port" BETWEEN 1 AND 65535 AND "unitId" BETWEEN 0 AND 255);
ALTER TABLE "DigitalIoPin" ADD CONSTRAINT "DigitalIoPin_address_check" CHECK ("address" IS NULL OR "address" BETWEEN 0 AND 65535);
ALTER TABLE "Door" ADD CONSTRAINT "Door_state_check" CHECK ("state" IN ('OPEN', 'CLOSED', 'UNKNOWN'));
ALTER TABLE "Door" ADD CONSTRAINT "Door_timing_check" CHECK ("unlockPulseMs" BETWEEN 500 AND 30000 AND "heldOpenSeconds" BETWEEN 5 AND 3600 AND "unlockGraceSeconds" BETWEEN 1 AND 300);
