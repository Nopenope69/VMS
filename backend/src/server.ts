import prisma from './config/database';
import config from './config/env';
import app from './app';
import { startBackgroundServices, stopBackgroundServices } from './composition';
import { LeaderLease } from './services/cluster/leaderLease';
import { setClusterRoleSource } from './services/cluster/clusterRole';

// Every long-lived module is built in composition.ts; this file runs the HTTP server, the HA lease and shutdown.
const haNodeId = process.env.VIGILONE_HA_NODE_ID?.trim();
export const leaderLease = haNodeId
  ? new LeaderLease(prisma, {
      nodeId: haNodeId,
      ttlMs: Number(process.env.VIGILONE_HA_LEASE_TTL_MS || 15_000),
      onLeader: () => startBackgroundServices(),
      // Background services must not keep running without the lease: exit, and let the supervisor restart this
      // node as a follower.
      onLost: (reason) => {
        console.error(`[VigilOne] Lost the leader lease (${reason}); exiting so background services stop.`);
        process.exit(75);
      },
      log: (m) => console.log(m),
    })
  : null;
setClusterRoleSource(() => (leaderLease ? { nodeId: leaderLease.nodeId, role: leaderLease.currentRole } : null));

export const server = app.listen(config.PORT, () => {
  console.log(`[VigilOne] Backend API running on port ${config.PORT} (env: ${config.NODE_ENV})`);
  console.log(`[VigilOne] MediaMTX API configured at: ${config.MEDIAMTX_API_URL}`);

  // Start background services & startup reconciler unless running in test mode
  if (config.NODE_ENV !== 'test') {
    if (leaderLease) {
      console.log(`[VigilOne] High availability on: node ${leaderLease.nodeId}; background services run only on the leader`);
      leaderLease.start();
    } else {
      startBackgroundServices();
    }
  }
});

process.on('SIGTERM', async () => {
  console.log('[VigilOne] Shutting down gracefully...');
  await leaderLease?.release().catch((err) => console.error('[VigilOne] lease release failed:', err.message));
  await stopBackgroundServices();
  server.close(() => {
    prisma.$disconnect();
    process.exit(0);
  });
});

export default app;
