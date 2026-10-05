# RecordingCatalog crash-safety and time audit (5 Oct 2026)

Scope: how `RecordingCatalog` (ADR 0001) indexes and prunes footage, compared with the crash-safety and time ideas read in
Moonfire NVR (GPL, design only) and MediaMTX (MIT) in `docs/strategy/vigilone-oss-reference-study-2026-10-05.md`.
This started as an audit with failing tests and no behaviour change. **Fix 1 (F3, F4, and two related findings F9, F10) is now done**; the other fixes are separate pieces of work, in the order at the end. Status of each finding is in the table below.

Evidence: `backend/src/__tests__/recordingCatalogAudit.test.ts` (real database, real files, real ffmpeg). Each finding
marked "test" is an `it.failing`: it states the correct behaviour and currently fails, so the suite stays green while the
defect exists and breaks the moment someone fixes it, which is the signal to turn it into a plain `it`.

What was read, not run on real hardware: nothing here has met a real camera or a real MediaMTX segment. Findings about
what MediaMTX does come from `mediamtx.yml` and the MediaMTX source, not from a live recorder.

## Status

| Finding | State |
| --- | --- |
| F1 invented keyframe index | Open (test `it.failing`) |
| F2 crawl re-reads every file | Open (test `it.failing`) |
| F3 file still being written indexed as FINALIZED | **Fixed (Fix 1)** |
| F4 unreadable file indexed as FINALIZED with invented details | **Fixed (Fix 1)** |
| F5 completion notice | Corrected below; open as a small item |
| F6 time assumptions | Open |
| F7 integrity only at boot | Open |
| F8 orphan after crash during retention | Known, no change |
| F9 coverage, seek and listing ignored segment status | **Found and fixed with Fix 1** |
| F10 the crawler pulled quarantined files out of `.quarantine` | **Found and fixed with Fix 1** |

## What is already right

| Behaviour | Where | Why it matters |
| --- | --- | --- |
| Retention deletes the database row first, with the evidence-pin veto in the same statement, and unlinks the file only after the row is gone | `retentionPolicy.ts` (`DELETE ... WHERE NOT EXISTS (pin)`) | Same order as Moonfire's delete-through-a-garbage-table. A crash leaves an orphan file, never a row that claims footage that is gone |
| `RecordingSegment` is one row per file path and registration is idempotent | `segmentRepository.upsertSegment` | Test "indexes a finished, readable file once" |
| Segment times come from the file name read as UTC | `utils/segmentPath.ts` | Test "parses the file name as UTC" (millisecond precision kept) |
| Boot-time recovery sorts files into valid, partial, truncated, corrupt or missing, honours the active-write grace, and confirms size and hash | `crashRecovery.service.ts` (`recoverStorage`) | This is the safe path. The findings below are mostly that the 5-minute crawler does not use it |

## Findings

### F1. The keyframe index is invented, not read from the file (test)
`FfprobeMediaAdapter` builds the index as "one keyframe every 2 seconds" from the clip's duration
(`mediaProbeAdapter.ts`, comment: "synthetic keyframe entries for standard GOP"). Real cameras use other GOP lengths and
change them (smart-codec modes). Test: a clip with a keyframe every second has 6 keyframes; the catalog stores 3.
Consequence: `findSeekTarget` and frame stepping can name a keyframe that is not in the file. The product promises exact
PTS and forensic shuttle (AGENTS.md), and the stored values look measured. Impact on what an operator sees is not
measured; a player falls back to the real keyframe before the target, so the likely effect is a wrong "nearest keyframe"
and wrong frame-step distances, not a failed seek. Treat as a correctness risk for forensic claims until measured.
Moonfire stores the real per-frame index (about 2 bytes a frame).

### F2. The 5-minute crawl re-reads every known file (test)
`reconcileFilesystem` calls `registerSegment` for every file it finds. With no duration, codec or hash supplied, each call
runs `ffprobe` and hashes the whole file again. Test: two crawls over 3 unchanged files make 6 probe calls (3 expected).
At 32 cameras with 10-minute segments, 30 days of retention is about 138,000 files; each crawl would re-hash all of them
on the same disks that are recording. Recording must stay independent of indexing load (AGENTS.md). Moonfire's fsck
separates three levels: file present (seconds), size (minutes), content hash (hours), and does the cheap one routinely.

### F3. A file MediaMTX is still writing is indexed as FINALIZED (fixed)
The crawler skips the active-write grace for files it indexes (it uses it only before quarantining an unmapped file), and
the repository sets `status: FINALIZED` by default. Test: a file modified just now is indexed FINALIZED. The size, duration
and SHA-256 recorded are those of a half-written file. The next crawl refreshes some fields (the upsert update branch
changes `endTime`, `sizeBytes`, `sha256Hash`) but `startPts` and the status are never revisited. This is the backlog item
"`registerSegment` may index a segment that is still being written". Boot recovery already has the right rule; the
crawler does not use it, so there are two sets of rules for the same question, against ADR 0001's one-authority aim.

### F4. A file that cannot be read gets invented metadata and counts as footage (fixed)
When `ffprobe` returns nothing, `registerSegment` falls back to 1000 ms duration, 1920x1080, 25 fps, h264, and stores the
row FINALIZED with the hash of whatever bytes are there. Test: 4 KB of random bytes become a valid one-second segment.
Coverage and gap detection then treat the interval as recorded. This is the "never replace a missing result with a made-up
one" rule (AGENTS.md). The status enum already has CORRUPTED, RECOVERY_FAILED and QUARANTINED for this.

### F5. The completion notice is one curl, but a durable job sits behind it (corrected; no test)
`mediamtx.yml` sends the notice with a single `curl --max-time 3` and no retry. This audit first said a lost notice meant
the file was found only by the crawl. That was incomplete: when the notice arrives, `handleSegmentComplete` stores a durable
`SegmentJob` and `segmentJobWorker` indexes it, and that worker already refuses a file it cannot probe (it throws, so the
job fails instead of indexing). A lost notice (backend restarting) is still caught only by the crawl, which is why Fix 1
mattered. Left over: the worker is a third indexing implementation with its own rules, and it still falls back to 1920x1080,
25 fps and h264 when the probe omits them. Folding it into `registerSegment` is the clean follow-up.

### F6. Time rests on two assumptions that are not stated anywhere a test can hold (no test)
1. The file name's time is MediaMTX's own wall clock, parsed as UTC. The compose file does not set a time zone for the
   MediaMTX container; the official image defaults to UTC, but a custom image or a changed default would shift every
   segment by the zone offset with no error. Cheap guard: set `TZ=UTC` on the container and log a warning at start if a
   segment's start is more than the segment length from the file's modification time.
2. `startPts` is always 0 and `endPts` is derived from the probed duration, so a segment's PTS is relative to the file, and
   the wall-clock mapping is name time plus offset. MediaMTX estimates the NTP time of each packet from RTCP sender
   reports (`internal/ntpestimator`, with a 5 s cap); VigilOne does not use it, and the camera clock check has 1 s
   resolution (backlog). Exact multi-camera sync is therefore bounded by the appliance clock, not the camera's. State this
   in the evidence documentation before claiming sub-frame sync across cameras.

### F7. Integrity is checked at boot and on request, not while running (confirmed by reading callers, no test)
`recoverStorage` finds missing files (`FILE_MISSING`) and size or hash mismatches. Its only callers are the startup
reconciler, disaster recovery and a manual admin route in `storage.routes.ts`; nothing schedules it. The recording watchdog
runs on a timer but checks that new footage is arriving, not that old footage is still intact. A file deleted or corrupted
while the appliance stays up can keep appearing in coverage until the next restart or a manual run. The cheap tier (is the
file still there, is the size unchanged) is worth running with each crawl once F2 makes the crawl cheap.

### F8. Orphan after a crash during retention (low)
A crash after the row is deleted and before the file is unlinked leaves a file with no row. The crawler then indexes it again
(F3's rules apply), and retention prunes it on a later pass. Harmless but wasteful, and the footage reappears in coverage for
a while. Worth knowing; no change proposed.

### F9. Coverage, seek and listing ignored a segment's status (found while fixing F4; fixed)
`findSegments`, `findContainingSegment` and `findNearestSegment` did not filter on status, so every consumer (coverage and
gap detection, seek, playback listing, export) counted corrupt, quarantined, missing and pruned files as footage. Boot recovery
produces exactly those statuses, so this already happened after a recovery run. Fixed: only FINALIZED counts.

### F10. The crawler pulled files out of quarantine (found while fixing F4; fixed)
`LocalStorageAdapter.scanDirectory` descended into `.quarantine`. Files there did not map to a camera, so the crawler's
"unmappable file" branch moved them again, into `.quarantine/.quarantine`, on every pass. Confirmed by running the test against
the old walk: the quarantined file was gone from its place. Boot recovery already skipped that folder. Fixed in the walk.

## Fix 1 (done): the crawler follows boot recovery's rules

* The crawler skips a file modified inside the active-write grace (default 120 s, the value boot recovery uses) and indexes
  it on a later pass.
* A file that is missing, empty or unreadable becomes a row with status FILE_MISSING or CORRUPTED and a reason
  (`FILE_NOT_FOUND_AT_REGISTRATION`, `ZERO_BYTE`, `UNREADABLE_MEDIA`). It keeps its real size and hash, has duration 0, and
  no codec, picture size or frame rate (null, not defaults). It is not moved, repaired or deleted: those stay with boot
  recovery, because the crawler runs while recording.
* The same row goes back to FINALIZED with the real details when the file becomes readable on a later pass.
* A duration supplied by the caller (the recorder's own figure) keeps a file with a failed probe usable; the picture
  details stay null.
* Segment width, height, frame rate and codec are now stored as unknown (null) instead of 1920, 1080, 25 and h264 when
  nothing measured them. Seek and frame stepping still report 25 fps and h264 for a null (their own read-time fallback,
  unchanged); that is a remaining gap, small once F1 is fixed.
* Evidence of the change: the audit tests F3 and F4 are plain tests now, with seven more in the same file; the full backend
  suite passes.

## Recommended fixes, in order

Each is its own small change with its own tests, starting by turning the matching `it.failing` into `it`.

1. ~~**F4 then F3**~~ done (Fix 1 above).
2. **F2:** skip a file whose row exists with the same size and modification time; run hashing as a separate low-priority
   verification job (Moonfire's three tiers), not in the crawl.
3. **F1:** read the real keyframes (`ffprobe -skip_frame nokey`, or the fMP4 `moof` boxes) and record where the index came
   from. If that is too slow at registration, label the stored index as assumed and have the seek result say so, so nothing
   presents an assumption as a measurement. Measure the cost on a 10-minute 1080p segment first.
4. **F6:** set `TZ=UTC` on the MediaMTX container and add the start-time versus file-time warning; write the clock-bound
   statement into `docs/operations/EVIDENCE_VERIFICATION.md`.
5. **F5, F7:** fold the segment job worker into `registerSegment`; retry the completion notice; run the cheap integrity tier
   (file still present, size unchanged) on a schedule.

## Not covered
Retention quotas and pruning order beyond the delete ordering above; object-storage archive; the playback API; behaviour under a
real disk-full or a real MediaMTX crash. Those need the clean-VM and bench runs in the field track.
