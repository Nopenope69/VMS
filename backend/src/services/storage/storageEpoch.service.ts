import crypto from 'crypto';
import { PrismaClient, StorageEpoch } from '@prisma/client';

export class StorageEpochService {
  /** prevEpochHash marker for a detected chain break (never a valid 64-hex SHA-256). */
  public static readonly CHAIN_BREAK_PREFIX = 'CHAIN_BREAK:';

  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Computes deterministic cryptographic hash of a storage epoch
   */
  public static calculateEpochHash(
    prevEpochHash: string,
    cameraId: string,
    epochNumber: number,
    storageVolumeId: string,
    transitionReason: string,
    startedAt: Date
  ): string {
    const payload = [
      prevEpochHash,
      cameraId,
      epochNumber.toString(),
      storageVolumeId,
      transitionReason,
      startedAt.toISOString(),
    ].join('|');

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Retrieves active storage epoch for a camera or initializes epoch 1
   */
  async getOrCreateActiveEpoch(
    tenantId: string,
    cameraId: string,
    storageVolumeId: string
  ): Promise<StorageEpoch> {
    const active = await this.prisma.storageEpoch.findFirst({
      where: {
        cameraId,
        endedAt: null,
      },
      orderBy: { epochNumber: 'desc' },
    });

    if (active) {
      if (active.storageVolumeId === storageVolumeId) {
        return active;
      }
      // Active epoch was on a different volume -> transition to new epoch
      return this.transitionEpoch({
        tenantId,
        cameraId,
        toVolumeId: storageVolumeId,
        reason: 'VOLUME_SWITCH',
      });
    }

    // Initialize Genesis Epoch (Epoch 1)
    const genesisPrevHash = '0'.repeat(64);
    const now = new Date();
    const epochHash = StorageEpochService.calculateEpochHash(
      genesisPrevHash,
      cameraId,
      1,
      storageVolumeId,
      'GENESIS_PROVISION',
      now
    );

    return this.prisma.storageEpoch.create({
      data: {
        tenantId,
        cameraId,
        epochNumber: 1,
        storageVolumeId,
        startedAt: now,
        transitionReason: 'GENESIS_PROVISION',
        prevEpochHash: genesisPrevHash,
        epochHash,
        endedAt: null,
      },
    });
  }

  /**
   * Executes an explicit, cryptographically chained storage failover/transition.
   * Closes the previous epoch and opens a new one linked via previous hash.
   * Dispatches an auditable event with full failover provenance.
   */
  async transitionEpoch(input: {
    tenantId: string;
    cameraId: string;
    toVolumeId: string;
    reason: string;
    metadata?: any;
  }): Promise<StorageEpoch> {
    const now = new Date();

    // 1. Find and close current active epoch
    const currentEpoch = await this.prisma.storageEpoch.findFirst({
      where: { cameraId: input.cameraId, endedAt: null },
      orderBy: { epochNumber: 'desc' },
    });

    let nextEpochNumber = 1;
    let prevEpochHash = '0'.repeat(64);

    if (currentEpoch) {
      await this.prisma.storageEpoch.update({
        where: { id: currentEpoch.id },
        data: { endedAt: now },
      });

      nextEpochNumber = currentEpoch.epochNumber + 1;
      if (currentEpoch.epochHash) {
        prevEpochHash = currentEpoch.epochHash;
      } else {
        // Both create paths always set epochHash, so this is corruption. Do not re-anchor to genesis
        // (that would hide the break) and do not block the volume transition (recording must go on):
        // record an explicit, non-hash marker that any chain verifier will reject.
        prevEpochHash = `${StorageEpochService.CHAIN_BREAK_PREFIX}${currentEpoch.id}`;
        console.error(
          `[StorageEpoch] Epoch ${currentEpoch.id} (camera ${input.cameraId}) has no epochHash; recording chain break`
        );
      }
    }

    // 2. Compute cryptographic epoch hash
    const epochHash = StorageEpochService.calculateEpochHash(
      prevEpochHash,
      input.cameraId,
      nextEpochNumber,
      input.toVolumeId,
      input.reason,
      now
    );

    // 3. Create new epoch
    const newEpoch = await this.prisma.storageEpoch.create({
      data: {
        tenantId: input.tenantId,
        cameraId: input.cameraId,
        epochNumber: nextEpochNumber,
        storageVolumeId: input.toVolumeId,
        startedAt: now,
        transitionReason: input.reason,
        prevEpochHash,
        epochHash,
        endedAt: null,
        metadataJson: input.metadata || null,
      },
    });

    // 4. Record audit event for evidential continuity
    try {
      await this.prisma.event.create({
        data: {
          cameraId: input.cameraId,
          type: 'STORAGE_FAILOVER',
          severity: 'WARNING',
          title: 'Storage Volume Failover',
          description: `Camera ${input.cameraId} transitioned to storage epoch ${nextEpochNumber} on volume ${input.toVolumeId}. Reason: ${input.reason}`,
          metadata: {
            cameraId: input.cameraId,
            fromVolumeId: currentEpoch?.storageVolumeId || null,
            toVolumeId: input.toVolumeId,
            prevEpochNumber: currentEpoch?.epochNumber || null,
            newEpochNumber: nextEpochNumber,
            reason: input.reason,
            prevEpochHash,
            epochHash,
            failoverTimestamp: now.toISOString(),
          },
        },
      });
    } catch (err: any) {
      console.error('[StorageEpochService] Failed to record failover event:', err.message);
    }

    return newEpoch;
  }
}

export default StorageEpochService;
