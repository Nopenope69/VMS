# recording-index.v1

Status: v1. Schema and mapper: `backend/src/contracts/recordingIndex.v1.ts`
(`toRecordingIndexRecordV1(segment, evidencePinned)` maps a Prisma `RecordingSegment` row).

## Record

| Field | Type | Notes |
| --- | --- | --- |
| `segmentId`, `tenantId`, `cameraId` | string (`tenantId` nullable) | |
| `startUtc`, `endUtc` | UTC timestamp | `endUtc >= startUtc` |
| `durationMs` | integer | |
| `sizeBytes` | decimal string | 64-bit safe |
| `container` | `fmp4` | Only fragmented MP4 is recorded. |
| `codec`, `width`, `height`, `fps` | nullable | As probed; `null` if unknown, never guessed. |
| `status` | `RECORDING`, `FINALIZED`, `CORRUPTED`, `ARCHIVED`, `FILE_MISSING`, `QUARANTINED`, `RECOVERY_FAILED` | |
| `integrity` | `{state: HASHED, sha256}` \| `{state: PENDING}` \| `{state: REPAIRED, originalSha256, repairedSha256, repairedAtUtc}` | A segment still `RECORDING` cannot be `HASHED`. |
| `pts` | `{start, end, timebase: {numerator, denominator}}` | decimal strings; `end >= start` |
| `storage` | `{location, volumeId, epochId}` | |
| `evidencePinned` | boolean | True while an active EvidencePin holds the segment; pinned segments are never pruned. |

## Invariants

- Hashes are computed from the bytes on disk; `PENDING` is reported until then. A hash is never
  invented to fill the field.
- Original recordings are never modified; a repaired derivative keeps both hashes.
- The contract test round-trips real rows through Postgres (Prisma) and validates the output.
