import crypto from 'crypto';
import { EventSeverity, EventType, PrismaClient, RecordingSegment, SegmentSeal, SegmentStatus } from '@prisma/client';
import { canonicalizeJson } from '../../../utils/license';
import { getOrCreateApplianceEd25519Keys } from '../../../utils/crypto';
import { AuditChainService, GENESIS_HASH } from '../../audit/auditChain.service';

/**
 * Segment seals (ADR 0018): a signed record of each recorded segment, made when it is registered, chained per camera.
 *
 * The seal body is canonical JSON; sealHash is its SHA-256 and the signature is Ed25519 over the same text with the
 * appliance key. tools/vigilone-verify carries its own copy of this format (sealBodyV1 there); the parity test in
 * segmentSeal.test.ts fails if the two drift.
 */
export const SEAL_SCHEMA_V1 = 'vigilone.segment-seal.v1';
/** The first seal of a camera links to the same all-zero genesis hash as the audit chain. */
export const SEAL_GENESIS = GENESIS_HASH;
export const SEAL_ANCHOR_ACTION = 'SEGMENT_SEAL_ANCHOR';
export const SEALS_DOCUMENT_SCHEMA = 'vigilone.segment-seals.v1';

export interface SealFields {
  cameraId: string;
  sequence: number;
  segmentId: string;
  startUtc: Date;
  endUtc: Date;
  sizeBytes: bigint;
  mediaSha256: string;
  prevSealHash: string;
  sealedAt: Date;
  keyFingerprint: string;
}

export function sealBodyV1(f: SealFields): Record<string, unknown> {
  return {
    schema: SEAL_SCHEMA_V1,
    cameraId: f.cameraId,
    sequence: f.sequence,
    segmentId: f.segmentId,
    startUtc: f.startUtc.toISOString(),
    endUtc: f.endUtc.toISOString(),
    sizeBytes: f.sizeBytes.toString(),
    mediaSha256: f.mediaSha256,
    prevSealHash: f.prevSealHash,
    sealedAtUtc: f.sealedAt.toISOString(),
    keyFingerprint: f.keyFingerprint,
  };
}

export const sealText = (f: SealFields): string => canonicalizeJson(sealBodyV1(f));
export const sealHashOf = (f: SealFields): string => crypto.createHash('sha256').update(sealText(f), 'utf8').digest('hex');

/** SHA-256 of the public key's SPKI DER: the same fingerprint vigilone-verify prints for a package key. */
export function keyFingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

export type SealOutcome =
  | { outcome: 'SEALED'; seal: SegmentSeal }
  | { outcome: 'ALREADY_SEALED'; seal: SegmentSeal }
  /** The segment was sealed earlier with a different hash. Never resealed; the caller reports it. */
  | { outcome: 'DIFFERS_FROM_SEAL'; seal: SegmentSeal }
  | { outcome: 'NOT_SEALABLE'; reason: 'NOT_FINALIZED' | 'NO_HASH' };

export interface ChainProblem {
  sequence: number | null;
  segmentId: string | null;
  problem:
    | 'SEQUENCE_GAP'
    | 'BROKEN_LINK'
    | 'SEAL_HASH_MISMATCH'
    | 'BAD_SIGNATURE'
    | 'STORED_HASH_DIFFERS'
    | 'ANCHOR_MISMATCH'
    | 'ANCHORED_SEAL_MISSING';
  detail: string;
}

export interface ChainReport {
  cameraId: string;
  sealCount: number;
  headSequence: number | null;
  headSealHash: string | null;
  /** Signed by the current appliance key and checked. */
  signaturesChecked: number;
  /** Signed by another key (an earlier appliance key): not checkable here, listed by fingerprint. */
  otherKeys: Array<{ keyFingerprint: string; count: number }>;
  /** Seals whose segment row no longer exists (retention, or deletion). Not a failure by itself. */
  segmentsGone: number;
  lastAnchor: { sequence: number; sealHash: string; at: string } | null;
  /** Seals made after the last anchor: a cut tail here would not be visible. */
  unanchoredSeals: number;
  valid: boolean;
  problems: ChainProblem[];
}

const PAGE = 1000;
const MAX_PROBLEMS = 200;
const SEAL_FAILURE_TITLE = 'Recorded segment could not be sealed';

type Db = PrismaClient | any;

export class SegmentSealer {
  private keys: { publicKeyPem: string; privateKeyPem: string; fingerprint: string } | null = null;

  constructor(
    private prisma: Db,
    private loadKeys: () => { publicKeyPem: string; privateKeyPem: string } = getOrCreateApplianceEd25519Keys,
  ) {}

  private applianceKeys() {
    if (!this.keys) {
      const k = this.loadKeys();
      this.keys = { ...k, fingerprint: keyFingerprint(k.publicKeyPem) };
    }
    return this.keys;
  }

  /**
   * Seals a registered segment once. Takes a per-camera advisory lock so the completion hook and the crawler cannot fork
   * the chain. Throws on a database or key error; callers on the recording path use sealQuietly().
   */
  async sealSegment(segment: Pick<RecordingSegment, 'id' | 'tenantId' | 'cameraId' | 'startTime' | 'endTime' | 'sizeBytes' | 'sha256Hash' | 'status'>): Promise<SealOutcome> {
    if (segment.status !== SegmentStatus.FINALIZED) return { outcome: 'NOT_SEALABLE', reason: 'NOT_FINALIZED' };
    if (!segment.sha256Hash || !/^[0-9a-f]{64}$/.test(segment.sha256Hash)) return { outcome: 'NOT_SEALABLE', reason: 'NO_HASH' };
    const keys = this.applianceKeys();
    const mediaSha256 = segment.sha256Hash;

    return this.prisma.$transaction(async (tx: any) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('segment_seal'), hashtext(${segment.cameraId}))`;
      const existing: SegmentSeal | null = await tx.segmentSeal.findUnique({ where: { segmentId: segment.id } });
      if (existing) return { outcome: existing.mediaSha256 === mediaSha256 ? 'ALREADY_SEALED' : 'DIFFERS_FROM_SEAL', seal: existing } as SealOutcome;

      const last = await tx.segmentSeal.findFirst({ where: { cameraId: segment.cameraId }, orderBy: { sequence: 'desc' }, select: { sequence: true, sealHash: true } });
      const fields: SealFields = {
        cameraId: segment.cameraId,
        sequence: last ? last.sequence + 1 : 1,
        segmentId: segment.id,
        startUtc: segment.startTime,
        endUtc: segment.endTime,
        sizeBytes: segment.sizeBytes,
        mediaSha256,
        prevSealHash: last ? last.sealHash : SEAL_GENESIS,
        sealedAt: new Date(),
        keyFingerprint: keys.fingerprint,
      };
      const text = sealText(fields);
      const seal: SegmentSeal = await tx.segmentSeal.create({
        data: {
          ...fields,
          tenantId: segment.tenantId ?? null,
          sealHash: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
          signature: crypto.sign(null, Buffer.from(text, 'utf8'), keys.privateKeyPem).toString('base64'),
        },
      });
      return { outcome: 'SEALED', seal } as SealOutcome;
    });
  }

  /**
   * The recording path's entry: never throws. A failure is logged and raised as a RECORDING_FAILURE warning, at most
   * one per camera per hour; the segment stays registered and is not sealed later (ADR 0018).
   */
  async sealQuietly(segment: Parameters<SegmentSealer['sealSegment']>[0]): Promise<SealOutcome | null> {
    try {
      return await this.sealSegment(segment);
    } catch (err: any) {
      console.error(`[SegmentSeal] segment ${segment.id} of camera ${segment.cameraId} could not be sealed: ${err.message}`);
      try {
        const recent = await this.prisma.event.findFirst({
          where: { cameraId: segment.cameraId, type: EventType.RECORDING_FAILURE, title: SEAL_FAILURE_TITLE, firstDetectedAt: { gte: new Date(Date.now() - 3600_000) } },
          select: { id: true },
        });
        if (!recent) {
          await this.prisma.event.create({
            data: {
              cameraId: segment.cameraId,
              type: EventType.RECORDING_FAILURE,
              severity: EventSeverity.WARNING,
              title: SEAL_FAILURE_TITLE,
              description: `Segment ${segment.id} was recorded and registered but no seal was written (${err.message}). It is still footage; it will not carry a seal in evidence exports. Check the appliance key in /etc/vigilone and the database.`,
              metadata: { segmentId: segment.id, error: err.message } as any,
            },
          });
        }
      } catch (reportErr: any) {
        console.error('[SegmentSeal] could not raise the warning:', reportErr.message);
      }
      return null;
    }
  }

  /** Walks a camera's whole chain. Reads only. */
  async verifyCameraChain(cameraId: string): Promise<ChainReport> {
    const keys = this.applianceKeys();
    const report: ChainReport = {
      cameraId,
      sealCount: 0,
      headSequence: null,
      headSealHash: null,
      signaturesChecked: 0,
      otherKeys: [],
      segmentsGone: 0,
      lastAnchor: null,
      unanchoredSeals: 0,
      valid: true,
      problems: [],
    };
    const problem = (p: ChainProblem) => {
      report.valid = false;
      if (report.problems.length < MAX_PROBLEMS) report.problems.push(p);
    };
    const otherKeys = new Map<string, number>();
    let prevHash = SEAL_GENESIS;
    let expectSeq = 1;
    let after = 0;

    for (;;) {
      const page: SegmentSeal[] = await this.prisma.segmentSeal.findMany({ where: { cameraId, sequence: { gt: after } }, orderBy: { sequence: 'asc' }, take: PAGE });
      if (page.length === 0) break;
      const rows = await this.prisma.recordingSegment.findMany({ where: { id: { in: page.map((s) => s.segmentId) } }, select: { id: true, sha256Hash: true, repairedSha256: true } });
      const stored = new Map<string, { sha256Hash: string | null; repairedSha256: string | null }>(rows.map((r: any) => [r.id, r]));

      for (const s of page) {
        report.sealCount++;
        if (s.sequence !== expectSeq) {
          problem({ sequence: s.sequence, segmentId: s.segmentId, problem: 'SEQUENCE_GAP', detail: `expected seal ${expectSeq}, found ${s.sequence}: seal(s) removed` });
        } else if (s.prevSealHash !== prevHash) {
          problem({ sequence: s.sequence, segmentId: s.segmentId, problem: 'BROKEN_LINK', detail: 'does not link to the previous seal' });
        }
        const text = sealText(s as SealFields);
        const recomputed = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
        if (recomputed !== s.sealHash) {
          problem({ sequence: s.sequence, segmentId: s.segmentId, problem: 'SEAL_HASH_MISMATCH', detail: 'the seal row was changed after it was written' });
        }
        if (s.keyFingerprint === keys.fingerprint) {
          let ok = false;
          try {
            ok = crypto.verify(null, Buffer.from(text, 'utf8'), keys.publicKeyPem, Buffer.from(s.signature, 'base64'));
          } catch {
            ok = false;
          }
          report.signaturesChecked++;
          if (!ok) problem({ sequence: s.sequence, segmentId: s.segmentId, problem: 'BAD_SIGNATURE', detail: 'signature does not verify with the appliance key' });
        } else {
          otherKeys.set(s.keyFingerprint, (otherKeys.get(s.keyFingerprint) ?? 0) + 1);
        }
        const seg = stored.get(s.segmentId);
        if (!seg) report.segmentsGone++;
        else if (!seg.repairedSha256 && seg.sha256Hash !== s.mediaSha256) {
          problem({ sequence: s.sequence, segmentId: s.segmentId, problem: 'STORED_HASH_DIFFERS', detail: `stored hash ${seg.sha256Hash ?? 'none'} differs from the sealed ${s.mediaSha256}` });
        }
        prevHash = s.sealHash;
        expectSeq = s.sequence + 1;
        report.headSequence = s.sequence;
        report.headSealHash = s.sealHash;
      }
      after = page[page.length - 1].sequence;
    }
    report.otherKeys = [...otherKeys].map(([keyFingerprint, count]) => ({ keyFingerprint, count }));

    const anchor = await this.lastAnchor(cameraId);
    if (anchor) {
      report.lastAnchor = anchor;
      report.unanchoredSeals = Math.max(0, (report.headSequence ?? 0) - anchor.sequence);
      const atAnchor = (await this.prisma.segmentSeal.findUnique({ where: { cameraId_sequence: { cameraId, sequence: anchor.sequence } }, select: { sealHash: true } }))?.sealHash;
      if (!atAnchor) {
        problem({ sequence: anchor.sequence, segmentId: null, problem: 'ANCHORED_SEAL_MISSING', detail: `the audit chain anchored seal ${anchor.sequence} on ${anchor.at}; it is no longer in the chain` });
      } else if (atAnchor !== anchor.sealHash) {
        problem({ sequence: anchor.sequence, segmentId: null, problem: 'ANCHOR_MISMATCH', detail: 'the seal at the anchored position is not the one the audit chain recorded' });
      }
    } else {
      report.unanchoredSeals = report.headSequence ?? 0;
    }
    return report;
  }

  private async lastAnchor(cameraId: string): Promise<{ sequence: number; sealHash: string; at: string } | null> {
    const ev = await this.prisma.auditEvent.findFirst({
      where: { action: SEAL_ANCHOR_ACTION, resourceType: 'Camera', resourceId: cameraId },
      orderBy: { sequenceNumber: 'desc' },
      select: { metadataJson: true, timestampUtc: true },
    });
    const m = ev?.metadataJson as any;
    if (!m || typeof m.sequence !== 'number' || typeof m.sealHash !== 'string') return null;
    return { sequence: m.sequence, sealHash: m.sealHash, at: ev.timestampUtc.toISOString() };
  }

  /**
   * Writes one audit-chain entry per camera whose chain moved since its last anchor (ADR 0018). Returns the number of
   * anchors written. Seals without a tenant (no camera tenant known) cannot go into a tenant's audit chain and are skipped.
   */
  async anchorAll(): Promise<number> {
    const heads: Array<{ cameraId: string; sequence: number }> = await this.prisma.segmentSeal.groupBy({ by: ['cameraId'], _max: { sequence: true } }).then((g: any[]) =>
      g.map((r) => ({ cameraId: r.cameraId, sequence: r._max.sequence })),
    );
    let written = 0;
    for (const h of heads) {
      const anchor = await this.lastAnchor(h.cameraId);
      if (anchor && anchor.sequence >= h.sequence) continue;
      const head: SegmentSeal | null = await this.prisma.segmentSeal.findUnique({ where: { cameraId_sequence: { cameraId: h.cameraId, sequence: h.sequence } } });
      if (!head) continue;
      const tenantId = head.tenantId ?? (await this.prisma.camera.findUnique({ where: { id: h.cameraId }, select: { tenantId: true } }))?.tenantId;
      if (!tenantId) continue;
      await AuditChainService.record(this.prisma, {
        tenantId,
        userId: null,
        action: SEAL_ANCHOR_ACTION,
        resourceType: 'Camera',
        resourceId: h.cameraId,
        ipAddress: '127.0.0.1',
        userAgent: null,
        metadata: { sequence: head.sequence, sealHash: head.sealHash, keyFingerprint: head.keyFingerprint },
      });
      written++;
    }
    return written;
  }

  /**
   * The seals for an evidence package: every seal of the exported segments, plus all seals between the lowest and the
   * highest of them in the camera's chain, so the run of seals can be shown unbroken. Empty when none is sealed.
   */
  async sealsForExport(cameraId: string, segmentIds: string[]): Promise<SegmentSeal[]> {
    if (segmentIds.length === 0) return [];
    const own: SegmentSeal[] = await this.prisma.segmentSeal.findMany({ where: { cameraId, segmentId: { in: segmentIds } }, select: { sequence: true } });
    if (own.length === 0) return [];
    const seqs = own.map((s) => s.sequence);
    return this.prisma.segmentSeal.findMany({
      where: { cameraId, sequence: { gte: Math.min(...seqs), lte: Math.max(...seqs) } },
      orderBy: { sequence: 'asc' },
    });
  }
}

/** The package document: seal bodies as signed, with their hashes and signatures. */
export function buildSegmentSealsDocument(input: { cameraId: string; exportedSegmentIds: string[]; seals: SegmentSeal[]; publicKeyFingerprint: string }) {
  return {
    schema: SEALS_DOCUMENT_SCHEMA,
    sealSchema: SEAL_SCHEMA_V1,
    cameraId: input.cameraId,
    applianceKeyFingerprint: input.publicKeyFingerprint,
    exportedSegmentIds: [...input.exportedSegmentIds].sort(),
    seals: input.seals.map((s) => ({ body: sealBodyV1(s as SealFields), sealHash: s.sealHash, signature: s.signature })),
  };
}

/** Anchors seal chain heads into the audit chain (ADR 0018). Started only with FOOTAGE_SEALING. */
export class SegmentSealAnchor {
  static readonly INTERVAL_MS = 15 * 60_000;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private sealer: SegmentSealer) {}

  start(intervalMs: number = SegmentSealAnchor.INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.sealer.anchorAll();
    } catch (err: any) {
      console.error(`[SegmentSealAnchor] anchoring failed: ${err.message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
