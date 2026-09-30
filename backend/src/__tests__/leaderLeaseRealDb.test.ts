/**
 * Phase 8 high availability: the leader lease against the real database. Short leases (1.5 s) keep it fast.
 * The two-process failover (real servers, kill -9) is scripts/e2e/ha-failover.sh.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { LeaderLease } from '../services/cluster/leaderLease';

jest.setTimeout(60000);

describe('leader lease (real database)', () => {
  const prisma = new PrismaClient();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let name = '';
  const made: LeaderLease[] = [];
  function lease(nodeId: string, events: string[] = [], client: PrismaClient = prisma) {
    const l = new LeaderLease(client, {
      name,
      nodeId,
      ttlMs: 1500,
      renewMs: 400,
      onLeader: () => void events.push(`${nodeId}:leader`),
      onLost: (reason) => void events.push(`${nodeId}:lost:${reason}`),
    });
    made.push(l);
    return l;
  }

  beforeEach(() => {
    name = `test-${crypto.randomUUID()}`;
  });
  afterEach(() => made.splice(0).forEach((l) => l.stop()));
  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "ClusterLease" WHERE "name" LIKE 'test-%'`;
    await prisma.$disconnect();
  });

  it('refuses a renewal interval that leaves no margin', () => {
    expect(() => new LeaderLease(prisma, { nodeId: 'x', ttlMs: 1000, renewMs: 600, onLeader: () => undefined, onLost: () => undefined })).toThrow(/half/);
  });

  it('ten nodes racing for a free lease: exactly one leader', async () => {
    const nodes = Array.from({ length: 10 }, (_, i) => lease(`node-${i}`));
    await Promise.all(nodes.map((n) => n.tick()));
    await Promise.all(nodes.map((n) => n.tick()));
    expect(nodes.filter((n) => n.currentRole === 'LEADER')).toHaveLength(1);
    const holder = await LeaderLease.holder(prisma, name);
    expect(holder!.holderId).toBe(nodes.find((n) => n.currentRole === 'LEADER')!.nodeId);
  });

  it('a crashed leader (no more renewals) is replaced after the lease expires, not before', async () => {
    const events: string[] = [];
    const a = lease('a', events);
    const b = lease('b', events);
    await a.tick();
    await b.tick();
    expect([a.currentRole, b.currentRole]).toEqual(['LEADER', 'FOLLOWER']);
    a.stop(); // crash: nothing renews any more
    await sleep(700);
    await b.tick();
    expect(b.currentRole).toBe('FOLLOWER');
    await sleep(1000);
    await b.tick();
    expect(b.currentRole).toBe('LEADER');
    expect(events).toEqual(['a:leader', 'b:leader']);
  });

  it('a leader that was paused past its lease steps down when it wakes (and says why)', async () => {
    const events: string[] = [];
    const a = lease('a', events);
    const b = lease('b', events);
    await a.tick();
    await sleep(1700); // a is paused (GC, VM freeze) and does not renew
    await b.tick();
    await a.tick(); // a wakes up
    expect(a.currentRole).toBe('FOLLOWER');
    expect(b.currentRole).toBe('LEADER');
    expect(events).toEqual(['a:leader', 'b:leader', 'a:lost:another node holds the lease']);
  });

  it('a graceful release hands over at the follower\'s next tick', async () => {
    const a = lease('a');
    const b = lease('b');
    await a.tick();
    await b.tick();
    await a.release();
    await b.tick();
    expect(b.currentRole).toBe('LEADER');
  });

  it('a leader that cannot reach the database gives up before its lease could have expired', async () => {
    const events: string[] = [];
    let broken = false;
    const flaky = new Proxy(prisma, {
      get(target, prop, recv) {
        if (prop === '$queryRaw' && broken) return () => Promise.reject(new Error('connection refused'));
        return Reflect.get(target, prop, recv);
      },
    }) as PrismaClient;
    const a = lease('a', events, flaky);
    await a.tick();
    broken = true;
    const t0 = Date.now();
    await a.tick(); // right after a renewal: still safely inside the lease
    expect(a.currentRole).toBe('LEADER');
    while (a.currentRole === 'LEADER') {
      await sleep(100);
      await a.tick();
    }
    const gaveUpAfter = Date.now() - t0;
    expect(gaveUpAfter).toBeLessThan(1500); // before the database-side expiry
    expect(events[1]).toMatch(/a:lost:cannot renew the lease \(connection refused\)/);
    // and nobody else could have taken it before it gave up
    const b = lease('b');
    await b.tick();
    expect(b.currentRole).toBe('FOLLOWER');
  });

  it('a renewing leader keeps the lease indefinitely', async () => {
    const a = lease('a');
    const b = lease('b');
    for (let i = 0; i < 8; i++) {
      await a.tick();
      await b.tick();
      await sleep(400);
    }
    expect([a.currentRole, b.currentRole]).toEqual(['LEADER', 'FOLLOWER']);
  });
});
