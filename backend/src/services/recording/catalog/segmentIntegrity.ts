import { AlarmState, EventSeverity, EventType, PrismaClient, SegmentStatus } from '@prisma/client';
import { AuditChainService } from '../../audit/auditChain.service';
import { computeFileSha256 } from '../../../utils/crypto';
import { isWithinActiveWriteGrace } from '../../reconciliation/crashRecovery.service';
import { LocalStorageAdapter, StorageAdapter } from './storageAdapter';

/**
 * Periodic integrity check of recorded segments while the appliance runs (audit finding F7). Boot recovery looks at
 * footage at start; this keeps looking, in two tiers that mirror what Moonfire NVR's fsck separates:
 *
 *  1. presence and size, cheap, goes round all segments in batches, least recently checked first;
 *  2. content hash, expensive, limited by a byte budget per run, evidence-pinned segments first.
 *
 * It only reads. A failure marks the row (FILE_MISSING or CORRUPTED with a reason), writes an audit-chain entry and a
 * RECORDING_FAILURE event, and for evidence under a hold also raises a CRITICAL alarm. It never deletes, moves or
 * repairs a file: those decisions belong to boot recovery and to people.
 */

/** Evidence under a hold is hashed again when its last check is older than this. */
const PINNED_RECHECK_MS = 24 * 3600_000;

export interface IntegrityRunOptions {
  presenceBatch: number;
  /** Bytes of footage the hash tier may re-read this run. 0 turns the tier off. At least one file is hashed when above 0. */
  hashBudgetBytes: number;
}

export interface IntegrityReport {
  presenceChecked: number;
  missing: number;
  sizeChanged: number;
  skippedActive: number;
  hashChecked: number;
  hashBytes: number;
  hashMismatch: number;
  /** Segments with no recorded hash: not baselined here, because that would bless whatever is on disk. */
  hashNoBaseline: number;
}

type SegmentRow = {
  id: string;
  tenantId: string | null;
  cameraId: string;
  filePath: string;
  sizeBytes: bigint;
  sha256Hash: string | null;
  repairedAt: Date | null;
  repairedSha256: string | null;
  camera: { tenantId: string } | null;
};

const SELECT = {
  id: true,
  tenantId: true,
  cameraId: true,
  filePath: true,
  sizeBytes: true,
  sha256Hash: true,
  repairedAt: true,
  repairedSha256: true,
  camera: { select: { tenantId: true } },
} as const;

export class SegmentIntegrityVerifier {
  private running = false;

  constructor(private prisma: PrismaClient, private storage: StorageAdapter = new LocalStorageAdapter()) {}

  async runCycle(opts: IntegrityRunOptions): Promise<IntegrityReport> {
    const report: IntegrityReport = { presenceChecked: 0, missing: 0, sizeChanged: 0, skippedActive: 0, hashChecked: 0, hashBytes: 0, hashMismatch: 0, hashNoBaseline: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      await this.presenceTier(opts.presenceBatch, report);
      if (opts.hashBudgetBytes > 0) await this.hashTier(opts.hashBudgetBytes, report);
    } finally {
      this.running = false;
    }
    return report;
  }

  private async presenceTier(batch: number, report: IntegrityReport): Promise<void> {
    const rows = (await this.prisma.recordingSegment.findMany({
      where: { status: SegmentStatus.FINALIZED, storageLocation: 'LOCAL' },
      orderBy: { integrityCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: batch,
      select: SELECT,
    })) as SegmentRow[];

    const healthy: string[] = [];
    for (const seg of rows) {
      const st = await this.storage.stat(seg.filePath);
      if (st.exists && isWithinActiveWriteGrace(st.mtime.getTime())) {
        report.skippedActive++;
        continue;
      }
      report.presenceChecked++;
      if (!st.exists) {
        report.missing++;
        await this.fail(seg, SegmentStatus.FILE_MISSING, 'FILE_MISSING_DURING_RUN');
      } else if (!seg.repairedAt && BigInt(st.size) !== seg.sizeBytes) {
        // A repaired file legitimately differs in size from the original row; only an untouched one must match.
        report.sizeChanged++;
        await this.fail(seg, SegmentStatus.CORRUPTED, 'SIZE_CHANGED', { expectedBytes: seg.sizeBytes.toString(), foundBytes: st.size });
      } else {
        healthy.push(seg.id);
      }
    }
    if (healthy.length > 0) {
      await this.prisma.recordingSegment.updateMany({ where: { id: { in: healthy } }, data: { integrityCheckedAt: new Date() } });
    }
  }

  private async hashTier(budgetBytes: number, report: IntegrityReport): Promise<void> {
    const now = new Date();
    const activePin = { some: { releasedAt: null, expiresAt: { gt: now } } };
    const seen: string[] = [];
    let spent = 0;

    while (spent < budgetBytes) {
      const base = { status: SegmentStatus.FINALIZED, storageLocation: 'LOCAL', id: { notIn: seen } };
      const order = { hashVerifiedAt: { sort: 'asc' as const, nulls: 'first' as const } };
      // Held evidence first, but only while it is due (never verified, or not within PINNED_RECHECK_MS); otherwise it
      // would use the whole budget every run and nothing else would ever be checked.
      let rows = (await this.prisma.recordingSegment.findMany({
        where: { ...base, evidencePins: activePin, OR: [{ hashVerifiedAt: null }, { hashVerifiedAt: { lt: new Date(now.getTime() - PINNED_RECHECK_MS) } }] },
        orderBy: order,
        take: 10,
        select: SELECT,
      })) as SegmentRow[];
      let pinned: boolean | undefined = true;
      if (rows.length === 0) {
        pinned = undefined; // not known: fail() looks it up if a mismatch is found
        rows = (await this.prisma.recordingSegment.findMany({ where: base, orderBy: order, take: 10, select: SELECT })) as SegmentRow[];
      }
      if (rows.length === 0) return;

      for (const seg of rows) {
        if (spent >= budgetBytes) return;
        seen.push(seg.id);
        const st = await this.storage.stat(seg.filePath);
        if (!st.exists || isWithinActiveWriteGrace(st.mtime.getTime())) continue; // the presence tier reports a missing file
        const expected = seg.repairedSha256 ?? seg.sha256Hash;
        if (!expected) {
          report.hashNoBaseline++;
          await this.prisma.recordingSegment.update({ where: { id: seg.id }, data: { hashVerifiedAt: new Date() } });
          continue;
        }
        let actual: string;
        try {
          actual = await computeFileSha256(seg.filePath);
        } catch {
          continue; // unreadable right now: try again next run, say nothing on a transient read error
        }
        spent += st.size;
        report.hashChecked++;
        report.hashBytes += st.size;
        if (actual === expected) {
          await this.prisma.recordingSegment.update({ where: { id: seg.id }, data: { hashVerifiedAt: new Date() } });
        } else {
          report.hashMismatch++;
          await this.fail(seg, SegmentStatus.CORRUPTED, 'HASH_MISMATCH', { expectedSha256: expected, foundSha256: actual }, pinned);
        }
      }
    }
  }

  /** Marks the segment, audits it, and reports it. Never touches the file. */
  private async fail(seg: SegmentRow, status: SegmentStatus, reason: string, detail: Record<string, unknown> = {}, knownPinned?: boolean): Promise<void> {
    const tenantId = seg.tenantId ?? seg.camera?.tenantId ?? null;
    await this.prisma.$transaction(async (tx) => {
      await tx.recordingSegment.update({ where: { id: seg.id }, data: { status, quarantineReason: reason, integrityCheckedAt: new Date() } });
      if (tenantId) {
        await AuditChainService.record(tx, {
          tenantId,
          userId: null,
          action: 'SEGMENT_INTEGRITY_FAILURE',
          resourceType: 'RecordingSegment',
          resourceId: seg.id,
          ipAddress: '127.0.0.1',
          userAgent: null,
          metadata: { reason, newStatus: status, filePath: seg.filePath, cameraId: seg.cameraId, ...detail },
        });
      }
    });

    const pinned =
      knownPinned ??
      (await this.prisma.evidencePin.count({ where: { segmentId: seg.id, releasedAt: null, expiresAt: { gt: new Date() } } })) > 0;
    try {
      await this.prisma.event.create({
        data: {
          cameraId: seg.cameraId,
          type: EventType.RECORDING_FAILURE,
          severity: pinned ? EventSeverity.CRITICAL : EventSeverity.WARNING,
          title: pinned ? 'Evidence file failed its integrity check' : 'Recording file failed its integrity check',
          description: `Segment ${seg.id}: ${reason}. ${seg.filePath}`,
          metadata: { segmentId: seg.id, filePath: seg.filePath, reason, pinned, ...detail } as any,
        },
      });
      if (pinned && tenantId) {
        await this.prisma.alarm.create({
          data: {
            tenantId,
            cameraId: seg.cameraId,
            title: 'Evidence file failed its integrity check',
            description: `Footage under an evidence hold no longer matches what was recorded (${reason}). Do not export it; restore from backup and review the chain of custody.`,
            severity: EventSeverity.CRITICAL,
            state: AlarmState.ACTIVE,
            metadataJson: { segmentId: seg.id, filePath: seg.filePath, reason, ...detail } as any,
          },
        });
      }
    } catch (err: any) {
      console.error('[SegmentIntegrity] could not raise the event or alarm:', err.message);
    }
  }
}
