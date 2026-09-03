import crypto from 'crypto';
import { PrismaClient, AuditEvent } from '@prisma/client';
import { canonicalizeJson } from '../../utils/license';

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export interface RecordAuditOptions {
  tenantId: string;
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  ipAddress: string;
  userAgent?: string | null;
  metadata?: any;
}

export class AuditChainService {
  /**
   * Computes the cryptographic SHA-256 hash of an audit entry linked to its predecessor.
   */
  static computeEventHash(
    prevHash: string,
    timestampUtc: Date,
    tenantId: string,
    userId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadataJson: any
  ): string {
    const raw = [
      prevHash,
      timestampUtc.toISOString(),
      tenantId,
      userId || 'SYSTEM',
      action,
      resourceType,
      resourceId || '',
      canonicalizeJson(metadataJson || null),
    ].join('|');

    return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
  }

  /**
   * Appends an audit event to the tenant's tamper-evident hash chain.
   */
  static async record(prisma: PrismaClient, options: RecordAuditOptions): Promise<AuditEvent> {
    // 1. Get the most recent event hash for this tenant
    const lastEvent = await prisma.auditEvent.findFirst({
      where: { tenantId: options.tenantId },
      orderBy: { sequenceNumber: 'desc' },
      select: { eventHash: true },
    });

    const prevHash = lastEvent ? lastEvent.eventHash : GENESIS_HASH;
    const timestampUtc = new Date();

    const eventHash = this.computeEventHash(
      prevHash,
      timestampUtc,
      options.tenantId,
      options.userId || null,
      options.action,
      options.resourceType,
      options.resourceId || null,
      options.metadata
    );

    return await prisma.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        userId: options.userId || null,
        action: options.action,
        resourceType: options.resourceType,
        resourceId: options.resourceId || null,
        timestampUtc,
        ipAddress: options.ipAddress || '127.0.0.1',
        userAgent: options.userAgent || null,
        metadataJson: options.metadata || undefined,
        prevHash,
        eventHash,
      },
    });
  }

  /**
   * Validates the mathematical and cryptographic integrity of the entire audit chain for a tenant.
   * Proves no records were deleted, inserted, or modified after the fact.
   */
  static async verifyChain(
    prisma: PrismaClient,
    tenantId: string
  ): Promise<{ valid: boolean; verifiedCount: number; brokenSequence?: bigint; error?: string }> {
    const events = await prisma.auditEvent.findMany({
      where: { tenantId },
      orderBy: { sequenceNumber: 'asc' },
    });

    if (events.length === 0) {
      return { valid: true, verifiedCount: 0 };
    }

    let expectedPrevHash = GENESIS_HASH;

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      // Check linkage to predecessor
      if (event.prevHash !== expectedPrevHash) {
        return {
          valid: false,
          verifiedCount: i,
          brokenSequence: event.sequenceNumber,
          error: `Broken link at sequence ${event.sequenceNumber}: expected prevHash ${expectedPrevHash}, got ${event.prevHash}`,
        };
      }

      // Recompute and verify current hash
      const recomputed = this.computeEventHash(
        event.prevHash,
        event.timestampUtc,
        event.tenantId,
        event.userId,
        event.action,
        event.resourceType,
        event.resourceId,
        event.metadataJson
      );

      if (recomputed !== event.eventHash) {
        return {
          valid: false,
          verifiedCount: i,
          brokenSequence: event.sequenceNumber,
          error: `Hash mismatch at sequence ${event.sequenceNumber}: row content has been tampered with`,
        };
      }

      expectedPrevHash = event.eventHash;
    }

    return { valid: true, verifiedCount: events.length };
  }
}
