-- Phase 8 high availability: one row per lease (services/cluster/leaderLease.ts).
-- CreateTable
CREATE TABLE "ClusterLease" (
    "name" TEXT NOT NULL,
    "holderId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClusterLease_pkey" PRIMARY KEY ("name")
);

