# High availability (Phase 8)

**Status:**
- Backend failover is built and tested with two real backend processes on one machine, sharing one PostgreSQL.
- Database replication and failover are **not built**.
- Recording failover (cameras recorded by a second node) is **not built**.

## What it does

Several VigilOne backends can run against the same PostgreSQL database. All of them serve the API. Only one,
the **leader**, runs the background services:
- recording catalog and retention
- schedules and watchdogs
- alarm escalation
- the notification dispatcher
- the orchestrator outbox
- DPDP purges
- crop and embedding workers
- (with their flags) camera events and ANPR

The leader holds a lease: one row in the `ClusterLease` table. It renews the lease every third of its
lifetime. If the leader crashes, another node takes the lease once it expires.

A node that is no longer sure it holds the lease exits with code 75. This happens when another node took the
lease, or when renewals failed for longer than the lease can safely last. Its supervisor (systemd
`Restart=always`, or Docker `restart: unless-stopped`) restarts it as a follower. This guarantees that
background services never run on two nodes at once. On SIGTERM the leader releases the lease, so a follower
takes over within one renewal interval.

`GET /api/v1/health` reports `cluster: { nodeId, role }` when high availability is on.

## Turning it on

On every backend node:

```
VIGILONE_HA_NODE_ID=<unique name, e.g. vms-a>   # turns high availability on
VIGILONE_HA_LEASE_TTL_MS=15000                  # optional; default 15 s (renewal every 5 s)
DATABASE_URL=<the same database for all nodes>
```

- Without `VIGILONE_HA_NODE_ID`, a single node starts its background services directly, as before.
- Put the nodes behind a load balancer that checks `/api/v1/health`.
- Clocks must be NTP-synchronised. The safety margin assumes clocks within a few seconds of each other.

## How it was tested

`backend/src/__tests__/leaderLeaseRealDb.test.ts` runs against the real database:
- ten nodes race for a free lease, and exactly one leads;
- a crashed leader is replaced only after expiry;
- a paused leader steps down when it wakes;
- a graceful handover works;
- a leader that loses the database gives up before its lease could have expired;
- a renewing leader keeps the lease.

As a mutation check, removing the "only if free or expired" condition fails 5 of the 7 tests.

`scripts/e2e/ha-failover.sh` runs in CI with two real backend processes. It kills the leader with `kill -9`,
checks that the follower takes over only after the lease expires, restarts the killed node (which comes back as
a follower), then stops the new leader gracefully and checks the handover. Local run with a 6 s lease: takeover
after 5.4 s, graceful handover after 1.4 s.

## Not done (needed for real high availability)

- **PostgreSQL is still a single point of failure.** Use streaming replication with automatic failover
  (for example Patroni, or a managed PostgreSQL). This is not built or tested here.
- **Recording is per node.** MediaMTX and the recordings live on the node that records. If that node fails,
  its cameras are not recorded until it returns. Dual recording or shared storage is not built.
- Uploaded files and exports on local disk are not shared between nodes. Use shared storage for
  `EXPORTS_DIR` and `RECORDINGS_DIR`, or pin such requests to one node.
- Only loopback was tested. A network partition between a node and the database, and a real load balancer,
  have not been tested.
- Some in-memory state is per node: for example, login rate limits.
