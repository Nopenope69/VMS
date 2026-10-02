-- Time-to-answer stopwatch (feature INVESTIGATION_TIMING). services/investigation/investigationTiming.service.ts.
-- CreateTable
CREATE TABLE "InvestigationTiming" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstResultOpenedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "outcome" TEXT NOT NULL DEFAULT 'OPEN',
    "searches" INTEGER NOT NULL DEFAULT 0,
    "resultsOpened" INTEGER NOT NULL DEFAULT 0,
    "camerasViewed" INTEGER NOT NULL DEFAULT 0,
    "exports" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InvestigationTiming_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvestigationTiming_tenantId_startedAt_idx" ON "InvestigationTiming"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "InvestigationTiming_tenantId_userId_outcome_idx" ON "InvestigationTiming"("tenantId", "userId", "outcome");

-- AddForeignKey
ALTER TABLE "InvestigationTiming" ADD CONSTRAINT "InvestigationTiming_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One running stopwatch per operator (Prisma cannot express a partial index; the service maps a clash to 409).
CREATE UNIQUE INDEX "InvestigationTiming_one_open_per_user" ON "InvestigationTiming"("tenantId", "userId") WHERE "outcome" = 'OPEN';
