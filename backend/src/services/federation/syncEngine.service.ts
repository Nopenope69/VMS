import { PrismaClient } from '@prisma/client';

export type SyncStreamType = 'EVENT' | 'AUDIT' | 'ALARM';

export interface SyncBatchItem {
  seq: bigint;
  id: string;
  type: string;
  timestamp: string;
  data: any;
}

export interface SyncBatchPayload {
  streamType: SyncStreamType;
  fromSeq: bigint;
  toSeq: bigint;
  items: SyncBatchItem[];
}

export interface SyncAck {
  streamType: SyncStreamType;
  acknowledgedCursor: bigint;
  status: 'ACCEPTED' | 'GAP_DETECTED' | 'DUPLICATE_IGNORED';
  error?: string;
}

export class SyncEngineService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Retrieves the current acknowledged sync cursor for a given node and stream type
   */
  public async getSyncCursor(nodeUuid: string, streamType: SyncStreamType): Promise<bigint> {
    const node = await this.prisma.federatedNode.findUnique({
      where: { nodeUuid },
    });
    if (!node) {
      throw new Error(`Federated node ${nodeUuid} not found`);
    }

    switch (streamType) {
      case 'EVENT':
        return node.syncCursorEvent;
      case 'AUDIT':
        return node.syncCursorAudit;
      case 'ALARM':
        return node.syncCursorAlarm;
      default:
        throw new Error(`Unknown stream type: ${streamType}`);
    }
  }

  /**
   * Processes an incoming event batch, validating strict monotonic sequence continuity
   */
  public async processSyncBatch(
    nodeUuid: string,
    batch: SyncBatchPayload
  ): Promise<SyncAck> {
    const node = await this.prisma.federatedNode.findUnique({
      where: { nodeUuid },
    });
    if (!node) {
      throw new Error(`Federated node ${nodeUuid} not found`);
    }

    const currentCursor = await this.getSyncCursor(nodeUuid, batch.streamType);

    // 1. Duplicate Check
    if (batch.toSeq <= currentCursor) {
      return {
        streamType: batch.streamType,
        acknowledgedCursor: currentCursor,
        status: 'DUPLICATE_IGNORED',
      };
    }

    // 2. Gap Detection
    // The batch's fromSeq must be exactly currentCursor + 1n
    if (batch.fromSeq > currentCursor + 1n) {
      return {
        streamType: batch.streamType,
        acknowledgedCursor: currentCursor,
        status: 'GAP_DETECTED',
        error: `Expected sequence ${currentCursor + 1n}, but received ${batch.fromSeq}`,
      };
    }

    // Filter items to only process those > currentCursor
    const newItems = batch.items.filter((item) => BigInt(item.seq) > currentCursor);

    // 3. Transactional Ingestion & Cursor Advance
    await this.prisma.$transaction(async (tx) => {
      // Ingest based on stream type
      if (batch.streamType === 'EVENT') {
        for (const item of newItems) {
          await tx.detectionEvent.create({
            data: {
              tenantId: node.tenantId,
              cameraId: item.data.cameraId,
              type: item.data.type || 'MOTION',
              confidence: item.data.confidence ?? 1.0,
              boundingBox: item.data.boundingBox || undefined,
              centroid: item.data.centroid || undefined,
              attributesJson: item.data.attributesJson || undefined,
              timestamp: new Date(item.timestamp),
            },
          });
        }

        // Advance cursor to toSeq
        await tx.federatedNode.update({
          where: { nodeUuid },
          data: {
            syncCursorEvent: batch.toSeq,
          },
        });
      } else if (batch.streamType === 'AUDIT') {
        await tx.federatedNode.update({
          where: { nodeUuid },
          data: {
            syncCursorAudit: batch.toSeq,
          },
        });
      } else if (batch.streamType === 'ALARM') {
        await tx.federatedNode.update({
          where: { nodeUuid },
          data: {
            syncCursorAlarm: batch.toSeq,
          },
        });
      }
    });

    return {
      streamType: batch.streamType,
      acknowledgedCursor: batch.toSeq,
      status: 'ACCEPTED',
    };
  }
}
