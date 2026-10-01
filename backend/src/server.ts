import prisma from './config/database';
import config from './config/env';
import app from './app';
import { startBackgroundServices, stopBackgroundServices } from './composition';
import { LeaderLease } from './services/cluster/leaderLease';
import { setClusterRoleSource } from './services/cluster/clusterRole';
import { setting, settingProblems } from './config/settings';

// Every long-lived module is built in composition.ts; this file runs the HTTP server, the HA lease and shutdown.

// A setting that does not parse (an interval of "5s", a flag of "yes") stops the start here, naming the variable,
// instead of running with NaN timers or a silently ignored value.
const badSettings = settingProblems();
if (badSettings.length > 0) {
  console.error(`[VigilOne] Refusing to start: invalid settings:\n  ${badSettings.join('\n  ')}`);
  process.exit(1);
}
const haNodeId = setting('VIGILONE_HA_NODE_ID')?.trim();
export const leaderLease = haNodeId
  ? new LeaderLease(prisma, {
      nodeId: haNodeId,
      ttlMs: setting('VIGILONE_HA_LEASE_TTL_MS'),
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
