/**
 * recording-index.v1: the shape of one indexed recording segment as exchanged between the
 * recorder, catalogue, playback, evidence export and (later) federation/archive.
 * Spec: docs/contracts/recording-index.v1.md. Wraps the Prisma RecordingSegment row; no schema
 * change (P0.7: document and wrap).
 */
import { z } from 'zod';
import type { RecordingSegment } from '@prisma/client';
import { NonEmptyId, Sha256Hex, UtcTimestamp } from './common';

export const RECORDING_INDEX_CONTRACT = 'recording-index.v1' as const;

export const SEGMENT_STATUSES_V1 = [
  'RECORDING',
  'FINALIZED',
  'CORRUPTED',
  'ARCHIVED',
  'FILE_MISSING',
  'QUARANTINED',
  'RECOVERY_FAILED',
] as const;

/** BigInt-safe decimal string for byte counts and PTS values. */
const DecimalString = z.string().regex(/^\d+$/, 'must be a non-negative integer as a decimal string');

export const RecordingIndexRecordV1 = z
  .object({
    contract: z.literal(RECORDING_INDEX_CONTRACT),
    segmentId: NonEmptyId,
    tenantId: NonEmptyId.nullable(),
    cameraId: NonEmptyId,
    startUtc: UtcTimestamp,
    endUtc: UtcTimestamp,
    durationMs: z.number().int().nonnegative(),
    sizeBytes: DecimalString,
    container: z.literal('fmp4'),
    codec: z.string().min(1).nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    fps: z.number().positive().nullable(),
    status: z.enum(SEGMENT_STATUSES_V1),
    integrity: z.discriminatedUnion('state', [
      z.object({ state: z.literal('HASHED'), sha256: Sha256Hex }).strict(),
      z.object({ state: z.literal('PENDING') }).strict(),
      z.object({ state: z.literal('REPAIRED'), originalSha256: Sha256Hex.nullable(), repairedSha256: Sha256Hex, repairedAtUtc: UtcTimestamp }).strict(),
    ]),
    pts: z
      .object({
        start: DecimalString,
        end: DecimalString,
        timebase: z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }).strict(),
      })
      .strict(),
    storage: z
      .object({
        location: z.string().min(1),
        volumeId: NonEmptyId.nullable(),
        epochId: NonEmptyId.nullable(),
      })
      .strict(),
    evidencePinned: z.boolean(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (Date.parse(r.endUtc) < Date.parse(r.startUtc)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endUtc'], message: 'endUtc must not precede startUtc' });
    }
    if (BigInt(r.pts.end) < BigInt(r.pts.start)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pts', 'end'], message: 'pts.end must not precede pts.start' });
    }
    if (r.status === 'RECORDING' && r.integrity.state === 'HASHED') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['integrity'], message: 'a segment still recording cannot have a final hash' });
    }
  });

export type RecordingIndexRecordV1 = z.infer<typeof RecordingIndexRecordV1>;

/** Maps a Prisma RecordingSegment row (plus its active-pin state) onto recording-index.v1. */
export function toRecordingIndexRecordV1(segment: RecordingSegment, evidencePinned: boolean): RecordingIndexRecordV1 {
  let integrity: RecordingIndexRecordV1['integrity'];
  if (segment.repairedSha256 && segment.repairedAt) {
    integrity = {
      state: 'REPAIRED',
      originalSha256: segment.originalSha256 ?? null,
      repairedSha256: segment.repairedSha256,
      repairedAtUtc: segment.repairedAt.toISOString(),
    };
  } else if (segment.sha256Hash) {
    integrity = { state: 'HASHED', sha256: segment.sha256Hash };
  } else {
    integrity = { state: 'PENDING' };
  }
  return RecordingIndexRecordV1.parse({
    contract: RECORDING_INDEX_CONTRACT,
    segmentId: segment.id,
    tenantId: segment.tenantId ?? null,
    cameraId: segment.cameraId,
    startUtc: segment.startTime.toISOString(),
    endUtc: segment.endTime.toISOString(),
    durationMs: segment.durationMs,
    sizeBytes: segment.sizeBytes.toString(),
    container: 'fmp4',
    codec: segment.codec ?? null,
    width: segment.width ?? null,
    height: segment.height ?? null,
    fps: segment.fps ?? null,
    status: segment.status,
    integrity,
    pts: {
      start: segment.startPts.toString(),
      end: segment.endPts.toString(),
      timebase: { numerator: segment.timebaseNumerator, denominator: segment.timebaseDenominator },
    },
    storage: {
      location: segment.storageLocation,
      volumeId: segment.storageVolumeId ?? null,
      epochId: segment.storageEpochId ?? null,
    },
    evidencePinned,
  });
}
