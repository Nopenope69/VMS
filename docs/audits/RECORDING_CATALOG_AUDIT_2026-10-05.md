# RecordingCatalog crash-safety and time audit (5 Oct 2026)

Scope: how `RecordingCatalog` (ADR 0001) indexes and prunes footage, compared with the crash-safety and time ideas read in
Moonfire NVR (GPL, design only) and MediaMTX (MIT) in `docs/strategy/vigilone-oss-reference-study-2026-10-05.md`.
This is an audit with failing tests. **No behaviour was changed.** Fixes are separate pieces of work, in the order at the end.

Evidence: `backend/src/__tests__/recordingCatalogAudit.test.ts` (real database, real files, real ffmpeg). Each finding
marked "test" is an `it.failing`: it states the correct behaviour and currently fails, so the suite stays green while the
defect exists and breaks the moment someone fixes it, which is the signal to turn it into a plain `it`.

What was read, not run on real hardware: nothing here has met a real camera or a real MediaMTX segment. Findings about
what MediaMTX does come from `mediamtx.yml` and the MediaMTX source, not from a live recorder.

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

### F3. A file MediaMTX is still writing is indexed as FINALIZED (test)
The crawler skips the active-write grace for files it indexes (it uses it only before quarantining an unmapped file), and
the repository sets `status: FINALIZED` by default. Test: a file modified just now is indexed FINALIZED. The size, duration
and SHA-256 recorded are those of a half-written file. The next crawl refreshes some fields (the upsert update branch
changes `endTime`, `sizeBytes`, `sha256Hash`) but `startPts` and the status are never revisited. This is the backlog item
"`registerSegment` may index a segment that is still being written". Boot recovery already has the right rule; the
crawler does not use it, so there are two sets of rules for the same question, against ADR 0001's one-authority aim.

### F4. A file that cannot be read gets invented metadata and counts as footage (test)
When `ffprobe` returns nothing, `registerSegment` falls back to 1000 ms duration, 1920x1080, 25 fps, h264, and stores the
row FINALIZED with the hash of whatever bytes are there. Test: 4 KB of random bytes become a valid one-second segment.
Coverage and gap detection then treat the interval as recorded. This is the "never replace a missing result with a made-up
one" rule (AGENTS.md). The status enum already has CORRUPTED, RECOVERY_FAILED and QUARANTINED for this.

### F5. One-shot completion notice, and the safety net is the expensive crawl (no test)
`mediamtx.yml` tells the backend a segment is complete with a single `curl --max-time 3` and no retry. If the backend is
restarting or busy, the notice is lost and the file is found only by the next crawl (up to 5 minutes later). That crawl is
F2 and F3. Fixing F2 and F3 is what makes this design safe; adding a retry or a durable queue is a smaller second step.

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

## Recommended fixes, in order

Each is its own small change with its own tests, starting by turning the matching `it.failing` into `it`.

1. **F4 then F3 (one change):** the crawler uses the same classification and active-write grace as boot recovery. Unreadable
   files become CORRUPTED or RECOVERY_FAILED, never FINALIZED with defaults; files inside the grace are skipped and indexed
   on the next pass or the completion notice. Smallest change with the biggest effect on what coverage claims.
2. **F2:** skip a file whose row exists with the same size and modification time; run hashing as a separate low-priority
   verification job (Moonfire's three tiers), not in the crawl.
3. **F1:** read the real keyframes (`ffprobe -skip_frame nokey`, or the fMP4 `moof` boxes) and record where the index came
   from. If that is too slow at registration, label the stored index as assumed and have the seek result say so, so nothing
   presents an assumption as a measurement. Measure the cost on a 10-minute 1080p segment first.
4. **F6:** set `TZ=UTC` on the MediaMTX container and add the start-time versus file-time warning; write the clock-bound
   statement into `docs/operations/EVIDENCE_VERIFICATION.md`.
5. **F5, F7:** a retry or durable queue for the completion notice, and the cheap integrity tier on a schedule.

## Not covered
Retention quotas and pruning order beyond the delete ordering above; object-storage archive; the playback API; behaviour under a
real disk-full or a real MediaMTX crash. Those need the clean-VM and bench runs in the field track.
