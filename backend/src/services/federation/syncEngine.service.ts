/**
 * Headquarters side of site sync (Phase 6). A site sends its hash-chained record log (streamType LOG, see
 * recordLog.ts); every accepted record is stored as a FederatedRecord of that node, apart from headquarters'
 * own events, alarms and audit, and the node's cursor and last hash move in the same transaction.
 *
 * The earlier EVENT/AUDIT/ALARM streams are refused: EVENT wrote site events into headquarters' own
 * DetectionEvent table under a camera id the site supplied (nothing checked the camera belonged to the node's
 * tenant), and AUDIT and ALARM advanced the cursor while storing nothing. No site client ever used them.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { chainProblem, LogRecord } from './recordLog';

export type SyncStreamType = 'LOG';
export const MAX_BATCH_RECORDS = 500;

export interface SyncAck {
  streamType: SyncStreamType;
  /** The last seq headquarters holds for this node (decimal string). */
  acknowledgedCursor: string;
  acknowledgedHash: string;
  status: 'ACCEPTED' | 'DUPLICATE_IGNORED' | 'OUT_OF_SEQUENCE';
  accepted: number;
  error?: string;
}

export class SyncError extends Error {
  constructor(public readonly code: 'NODE_UNKNOWN' | 'NODE_DEPROVISIONED' | 'STREAM_RETIRED' | 'BATCH_INVALID' | 'CHAIN_BROKEN', message: string, public readonly status = 400) {
    super(message);
  }
}

export class SyncEngineService {
  constructor(private readonly prisma: PrismaClient) {}

  async getSyncCursor(nodeUuid: string): Promise<{ seq: bigint; hash: string }> {
    const node = await this.prisma.federatedNode.findUnique({ where: { nodeUuid }, select: { syncCursorLog: true, lastLogHash: true } });
    if (!node) throw new SyncError('NODE_UNKNOWN', `Federated node ${nodeUuid} not found`, 404);
    return { seq: node.syncCursorLog, hash: node.lastLogHash };
  }

  /**
   * Accepts a batch that continues this node's chain. `afterSeq`/`afterHash` state what the site believes
   * headquarters holds; a mismatch is OUT_OF_SEQUENCE with headquarters' cursor, so the site resends from there.
   * Records at or below the cursor are ignored as duplicates (a resend after a lost acknowledgement).
   */
  async processSyncBatch(nodeUuid: string, body: { streamType?: string; afterSeq?: string; afterHash?: string; records?: LogRecord[] }): Promise<SyncAck> {
    if (body.streamType !== 'LOG') {
      throw new SyncError('STREAM_RETIRED', `streamType '${String(body.streamType)}' is not accepted; sites send the hash-chained LOG stream`);
    }
    const records = body.records;
    if (!Array.isArray(records) || records.length === 0 || records.length > MAX_BATCH_RECORDS) {
      throw new SyncError('BATCH_INVALID', `records must be 1 to ${MAX_BATCH_RECORDS} log records`);
    }
    if (typeof body.afterSeq !== 'string' || !/^\d{1,19}$/.test(body.afterSeq) || typeof body.afterHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.afterHash)) {
      throw new SyncError('BATCH_INVALID', 'afterSeq (decimal) and afterHash (SHA-256) are required');
    }

    return this.prisma.$transaction(
      async (tx) => {
        // Lock the node row so two batches from the same node cannot interleave.
        const locked = await tx.$queryRaw<Array<{ id: string; tenantId: string; syncCursorLog: bigint; lastLogHash: string; deprovisionedAt: Date | null }>>(
          Prisma.sql`SELECT "id", "tenantId", "syncCursorLog", "lastLogHash", "deprovisionedAt" FROM "FederatedNode" WHERE "nodeUuid" = ${nodeUuid} FOR UPDATE`
        );
        const node = locked[0];
        if (!node) throw new SyncError('NODE_UNKNOWN', `Federated node ${nodeUuid} not found`, 404);
        if (node.deprovisionedAt) throw new SyncError('NODE_DEPROVISIONED', `node ${nodeUuid} was deprovisioned`, 403);
        const cursor = node.syncCursorLog;
        const base = { streamType: 'LOG' as const, acknowledgedCursor: cursor.toString(), acknowledgedHash: node.lastLogHash };

        // Drop what headquarters already holds (a resend); what is left must continue the chain exactly.
        const fresh = records.filter((r) => typeof r?.seq === 'string' && /^\d{1,19}$/.test(r.seq) && BigInt(r.seq) > cursor);
        if (fresh.length === 0) return { ...base, status: 'DUPLICATE_IGNORED' as const, accepted: 0 };
        const firstFresh = records.indexOf(fresh[0]);
        const startSeq = firstFresh === 0 ? BigInt(body.afterSeq!) : BigInt(records[firstFresh - 1].seq);
        const startHash = firstFresh === 0 ? body.afterHash! : records[firstFresh - 1].hash;
        if (startSeq !== cursor || startHash !== node.lastLogHash) {
          return { ...base, status: 'OUT_OF_SEQUENCE' as const, accepted: 0, error: `headquarters holds seq ${cursor}; the batch continues from ${startSeq}` };
        }
        const problem = chainProblem(fresh, cursor, node.lastLogHash);
        if (problem) throw new SyncError('CHAIN_BROKEN', problem);

        await tx.federatedRecord.createMany({
          data: fresh.map((r) => ({
            tenantId: node.tenantId,
            nodeId: node.id,
            seq: BigInt(r.seq),
            kind: r.kind,
            sourceId: r.sourceId,
            occurredAt: new Date(r.occurredAt),
            dataJson: (r.data ?? null) as Prisma.InputJsonValue,
            prevHash: r.prevHash,
            hash: r.hash,
          })),
        });
        const last = fresh[fresh.length - 1];
        await tx.federatedNode.update({ where: { id: node.id }, data: { syncCursorLog: BigInt(last.seq), lastLogHash: last.hash, lastSeenAt: new Date() } });
        return { streamType: 'LOG' as const, acknowledgedCursor: last.seq, acknowledgedHash: last.hash, status: 'ACCEPTED' as const, accepted: fresh.length };
      },
      { timeout: 30000 }
    );
  }
}
