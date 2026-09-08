# 0001: Consolidate Authoritative Recording State into RecordingCatalog

## Status
Accepted

## Context
Video recording state was fractured across two disconnected database models (`RecordingSegment` from Bucket 1 and `RecordingSegmentIndex` from Bucket 6) and several shallow services (`recordingIndexer`, `recordingIndex`, `recordingWatchdog`, `retention`, `evidencePin`). This created duplicate authority where subsystems could disagree on whether footage exists, where segments start and end, whether gaps exist, and whether segments are eligible for retention pruning or evidentiary hold.

## Decision
We consolidate all recording discovery, temporal/PTS indexing, keyframe indexing, coverage calculation, retention pruning, and evidentiary pinning into a single deep module: `RecordingCatalog` (`src/services/recording/catalog/`). 

1. **Schema Authority**: We unify schema authority onto `RecordingSegment` by adding temporal presentation columns (`startPts`, `endPts`, `timebaseNumerator`, `timebaseDenominator`, `keyframeIndexJson`, `storageLocation`). We migrate existing foreign keys and decommission `RecordingSegmentIndex`.
2. **Ingestion Seam**: Fast-path ingestion uses MediaMTX segment-completion webhooks (`registerSegment()`, strictly idempotent). A low-frequency (5-minute) filesystem crawler operates purely as a crash-resilient self-healing fallback.
3. **Coverage & Gap Seam**: `RecordingCatalog.getCoverage()` computes wall-clock availability (`CoverageBlock[]` with `startUtc`, `endUtc`, `segmentIds`) and explicit `RecordingGap[]` behind the seam. Media PTS mapping remains the distinct responsibility of the segment/seek interface (`findSeekTarget()`).
4. **Evidence Pin Precedence**: Active `EvidencePin`s form an absolute veto against automatic retention pruning. When pinned evidence prevents quota reclamation, the system triggers `STORAGE_QUOTA_PINNED_EXHAUSTION` rather than silently deleting protected footage.
5. **Internal Decomposition**: `RecordingCatalog` presents a small, deep facade (`recordingCatalog.service.ts`) while decomposing internally into cohesive subcomponents (`segmentRepository.ts`, `segmentIndexer.ts`, `coverageIndex.ts`, `retentionPolicy.ts`, `evidencePinRegistry.ts`, and `storageAdapter.ts`).
