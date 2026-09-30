/**
 * `vigilonectl golive` runs this inside the backend container: node dist/ops/goLiveCheckCli.js [--json]
 * Exit 0 when nothing blocks go-live, 1 when something does, 2 when the check itself could not run.
 * VIGILONE_HOST_NTP_SYNC (yes|no), set by vigilonectl from the host's timedatectl, overrides the clock probe
 * (a container cannot see the host's NTP state).
 */
import prisma from '../config/database';
import { collectSnapshot, evaluate, render } from './goLiveCheck';

async function main() {
  const snapshot = await collectSnapshot(prisma);
  const host = process.env.VIGILONE_HOST_NTP_SYNC;
  if (host === 'yes' || host === 'no') snapshot.ntpSynchronized = host === 'yes';
  const results = evaluate(snapshot);
  const blocked = results.some((r) => r.verdict === 'BLOCK');
  if (process.argv.includes('--json')) console.log(JSON.stringify({ at: new Date().toISOString(), ready: !blocked, results }, null, 2));
  else console.log(render(results));
  await prisma.$disconnect();
  process.exit(blocked ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`go-live check could not run: ${e?.message ?? e}`);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(2);
});
