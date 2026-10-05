# Recording integrity checks

While the appliance runs, it keeps checking that recorded footage is still what was recorded. This is separate from the
check at start-up (crash recovery) and from evidence verification (`vigilone-verify`, see `EVIDENCE_VERIFICATION.md`).

## What runs

Every `INTEGRITY_CHECK_INTERVAL_SECONDS` (default 300; 0 turns all of it off), two checks run on finalized, local segments:

| Check | What it does | Cost |
| --- | --- | --- |
| Presence and size | Is the file still there, and does it have the size recorded? Goes round all segments in batches of `INTEGRITY_PRESENCE_BATCH` (default 2000), least recently checked first | A file-system look per segment, no reading |
| Content hash | Reads the file again and compares its SHA-256 with the one recorded when it was indexed (or after a repair, the repaired file's hash). Re-reads at most `INTEGRITY_HASH_MB_PER_RUN` megabytes per run (default 512; 0 turns this check off) | Disk reads, limited by the budget |

Order of the hash check: evidence under a hold first, but only when it is due (never verified, or not verified in the last 24
hours), so held evidence is re-verified daily and everything else still gets its turn. At the default budget, a site with
about 138,000 ten-minute segments takes many months to hash every file once; raise the budget on appliances with spare disk
bandwidth, or accept that the hash check samples. The presence and size check covers every segment far faster.

Files modified in the last `CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS` (default 120) are skipped: they may still be recording.
Segments in object storage (not local) and segments already marked bad are skipped.

## What a failure means

| Reason (on the segment) | Meaning |
| --- | --- |
| `FILE_MISSING_DURING_RUN` (status FILE_MISSING) | The file was removed or its disk went away while the appliance was running |
| `SIZE_CHANGED` (status CORRUPTED) | A finalized file has a different size than recorded |
| `HASH_MISMATCH` (status CORRUPTED) | Same size or not, the content no longer matches the recorded hash |

A failed segment stops counting as footage: it is left out of coverage, playback, seek and export, and the timeline shows a gap.

Every failure writes an entry in the audit chain (`SEGMENT_INTEGRITY_FAILURE`) and a `RECORDING_FAILURE` event. A failure on
footage under an **evidence hold** is `CRITICAL` and also raises a CRITICAL alarm: do not export that footage; restore from
backup and review the chain of custody.

## What it never does

It only reads. It does not delete, move, repair or re-index a file, and it does not record a hash for a segment that has none
(that would bless whatever is on disk; such segments are counted and left alone). Repair and quarantine stay with start-up
recovery, and decisions about evidence stay with people.

## Not measured

The cost of the hash check on a real appliance's disks, and how often a healthy disk reports a false failure, are not measured;
this has run only on test files. Check the first week of audit entries on a pilot site.
