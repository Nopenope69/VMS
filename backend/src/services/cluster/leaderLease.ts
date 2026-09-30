/**
 * High availability (Phase 8): a leader lease in PostgreSQL so that several VigilOne backends can share one
 * database while background work (recording catalog, retention, alarm escalation, notifications, door monitor,
 * crop and embedding workers ...) runs on exactly one of them.
 *
 * The lease is one row in "ClusterLease". A node takes it when it is free or expired, and the holder renews it
 * every renewMs; it expires ttlMs after the last renewal. Taking and renewing are single conditional statements,
 * so two nodes can never both hold it.
 *
 * A node that stops being sure it holds the lease (a renewal answered "someone else", or no successful renewal
 * for longer than the lease can last) calls onLost. The server exits then, and its supervisor (systemd, Docker)
 * restarts it as a follower: background services are never left running on a node without the lease.
 * The margin (renew every ttl/3, give up before expiry) leaves room for clock and scheduling delays between
 * nodes; it assumes clocks within a few seconds of each other.
 */
import { PrismaClient } from '@prisma/client';

export type LeaseRole = 'LEADER' | 'FOLLOWER';

export interface LeaderLeaseOptions {
  name?: string;
  nodeId: string;
  ttlMs?: number;
  renewMs?: number;
  onLeader: () => void | Promise<void>;
  onLost: (reason: string) => void;
  log?: (msg: string) => void;
}

export class LeaderLease {
  private timer: NodeJS.Timeout | null = null;
  private role: LeaseRole = 'FOLLOWER';
  private heldUntil = 0;
  private stopped = false;
  private ticking = false;
  readonly name: string;
  readonly ttlMs: number;
  readonly renewMs: number;

  constructor(private readonly prisma: PrismaClient, private readonly o: LeaderLeaseOptions) {
    this.name = o.name ?? 'background-services';
    this.ttlMs = o.ttlMs ?? 15_000;
    this.renewMs = o.renewMs ?? Math.floor(this.ttlMs / 3);
    if (!o.nodeId || o.nodeId.length > 200) throw new Error('nodeId must be 1 to 200 characters');
    if (this.renewMs * 2 >= this.ttlMs) throw new Error('renewMs must be less than half of ttlMs');
  }

  get currentRole(): LeaseRole {
    return this.role;
  }

  get nodeId(): string {
    return this.o.nodeId;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const run = () => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick().finally(() => (this.ticking = false));
    };
    this.timer = setInterval(run, this.renewMs);
    run();
  }

  /** Takes or renews the lease once. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    let holder: string | null = null;
    const sentAt = Date.now();
    const ttlSeconds = this.ttlMs / 1000;
    try {
      const rows = await this.prisma.$queryRaw<{ holderId: string }[]>`
        INSERT INTO "ClusterLease" ("name", "holderId", "expiresAt", "acquiredAt")
        VALUES (${this.name}, ${this.o.nodeId}, now() + make_interval(secs => ${ttlSeconds}), now())
        ON CONFLICT ("name") DO UPDATE
          SET "holderId" = EXCLUDED."holderId",
              "expiresAt" = EXCLUDED."expiresAt",
              "acquiredAt" = CASE WHEN "ClusterLease"."holderId" = EXCLUDED."holderId" THEN "ClusterLease"."acquiredAt" ELSE now() END
          WHERE "ClusterLease"."holderId" = EXCLUDED."holderId" OR "ClusterLease"."expiresAt" < now()
        RETURNING "holderId"`;
      holder = rows[0]?.holderId ?? null;
    } catch (err: any) {
      if (this.role === 'LEADER' && Date.now() >= this.heldUntil - this.renewMs) {
        return this.lose(`cannot renew the lease (${err.message})`);
      }
      this.o.log?.(`[LeaderLease] renewal failed, lease still valid locally: ${err.message}`);
      return;
    }
    if (holder === this.o.nodeId) {
      // Counted from before the statement ran, so the local view never outlives the database's.
      this.heldUntil = sentAt + this.ttlMs - this.renewMs;
      if (this.role !== 'LEADER') {
        this.role = 'LEADER';
        this.o.log?.(`[LeaderLease] ${this.o.nodeId} is now the leader`);
        await this.o.onLeader();
      }
    } else if (this.role === 'LEADER') {
      this.lose('another node holds the lease');
    }
  }

  private lose(reason: string): void {
    this.role = 'FOLLOWER';
    this.stop();
    this.o.log?.(`[LeaderLease] ${this.o.nodeId} lost the lease: ${reason}`);
    this.o.onLost(reason);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Graceful shutdown: gives the lease up so a follower takes over at its next tick. */
  async release(): Promise<void> {
    this.stop();
    if (this.role !== 'LEADER') return;
    this.role = 'FOLLOWER';
    await this.prisma.$executeRaw`DELETE FROM "ClusterLease" WHERE "name" = ${this.name} AND "holderId" = ${this.o.nodeId}`;
  }

  static async holder(prisma: PrismaClient, name = 'background-services'): Promise<{ holderId: string; expiresAt: Date; acquiredAt: Date } | null> {
    const rows = await prisma.$queryRaw<{ holderId: string; expiresAt: Date; acquiredAt: Date }[]>`
      SELECT "holderId", "expiresAt", "acquiredAt" FROM "ClusterLease" WHERE "name" = ${name} AND "expiresAt" >= now()`;
    return rows[0] ?? null;
  }
}
