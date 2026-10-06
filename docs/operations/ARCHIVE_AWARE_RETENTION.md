# Archive-aware retention

Applies to `RetentionPolicyEngine` (`backend/src/services/recording/catalog/retentionPolicy.ts`) for tenants with an
**enabled object-storage archive** (`ObjectStorageConfig.enabled`, flag `OBJECT_STORAGE_ARCHIVE`). Tenants without one
behave exactly as before.

## Why

When footage must be freed to meet a storage quota, deleting the oldest segment first can destroy a segment that was
never copied to the archive, for example during an archive outage or backlog. Silent loss of that kind is what this
prevents.

## Behaviour

A segment counts as **archived** only when its `ArchiveJob` (matched on tenant and file path) is `COMPLETED`, which
the archive worker sets after the store reports the expected size and SHA-256. A segment with no job, or a queued,
uploading or failed one, is **unarchived**.

1. **Quota pressure** (per-camera quota, tenant quota): archived segments are deleted first, each group oldest first.
   An unarchived segment is deleted only when no archived one is left to free. Recording must keep going, so this is a
   last resort, not a refusal.
2. **Every unarchived deletion is reported**, whatever freed it (quota or age): counted in the prune report
   (`unarchivedPurgedCount`, `unarchivedPurgedBytes`), added to the Prometheus counter
   `vigilone_retention_unarchived_segments_deleted_total`, and raised as one CRITICAL alarm
   `STORAGE_UNARCHIVED_FOOTAGE_DROPPED` (camera, segment count, bytes, time range). While that alarm is open, further
   drops are counted but no second alarm is created.
3. **Pinned evidence is never deleted**, archived or not. Unchanged.
4. If the archive jobs cannot be read for an archive-enabled tenant, every segment is treated as unarchived: quota is
   still enforced and any deletion is reported.

## Limits

- **Age expiry is not held back.** A segment past its retention days is deleted even if unarchived (and reported). Holding
  it could fill the disk; an archive backlog longer than the retention period is exactly what the alarm is for.
- The tenant-level quota path works on the oldest 500 segments per run, so archived-first ordering applies within that batch.
- If the archive configuration itself cannot be read, retention order is unchanged and nothing is reported as unarchived.
- No live archive store was involved. Tests use database doubles (`archiveAwareRetention.test.ts`).
