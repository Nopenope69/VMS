# VigilOne Commercial Edge-First VMS

VigilOne is an edge-first commercial Video Management System providing autonomous recording, forensic investigations, hardware orchestration, spatial analytics, and multi-tenant surveillance.

## Language

### Recording & Playback

**RecordingCatalog**:
The authoritative module governing discovery, temporal indexing, keyframe mapping, coverage calculation, retention pruning, and evidentiary pinning of video footage.
_Avoid_: RecordingService, SegmentIndexer, RecordingManager

**Segment**:
A contiguous fragment of recorded video on disk or object storage representing a defined slice of media presentation time.
_Avoid_: Clip, Chunk, VideoFile, RecordingPart

**SeekTarget**:
The exact resolved media presentation timestamp (PTS) and nearest preceding keyframe mapped to an authoritative UTC wall-clock time.
_Avoid_: PlaybackPosition, OffsetTarget

**CoverageBlock**:
A contiguous interval of wall-clock time during which recorded segments are continuously available for a camera.
_Avoid_: RecordingSpan, VideoWindow

**RecordingGap**:
An unexpected omission of recorded footage between consecutive segments exceeding an allowable threshold.
_Avoid_: MissingClip, VideoDrop

**StorageAdapter**:
The concrete infrastructure adapter abstracting local filesystem storage and object storage volumes behind the catalog seam.
_Avoid_: VolumeDriver, FileStore

### Evidence & Compliance

**EvidenceArchive**:
The authoritative module managing investigation manifests, Merkle root hash trees, electronic evidence packages, and Section 63 BSA legal compliance.
_Avoid_: EvidenceExporter, ManifestService, ExportManager

**EvidencePin**:
An immutable hold placed on recorded segments that strictly prevents retention pruning or garbage collection during legal or administrative proceedings. Distinguishes persistent `LegalHoldPin` from transient `TemporaryExportPin`.
_Avoid_: Lock, RetainTag, PinnedClip

**EvidenceMerkleRoot**:
The deterministic cryptographic root hash computed over canonical length-prefixed segment leaf payloads in an evidence set.
_Avoid_: MasterEvidenceHash, ArchiveChecksum

**CanonicalManifestDigest**:
The SHA-256 digest of the canonicalized manifest structure (binding time window, camera IDs, version, and Merkle root) signed by the appliance Ed25519 private key.
_Avoid_: FileSignature, RawRootSignature

**CustodyHashChain**:
A tamper-evident, monotonically hashed ledger of custodial actions where each event's hash cryptographically chains to the preceding event's hash.
_Avoid_: AuditTable, ActionList

**BsaCertificatePackage**:
Pre-populated Schedule Part A and Part B documents supporting Section 63 BSA compliance, embedded with technical provenance and appliance digital signatures while leaving statutory declarations to authorized human signatories.
_Avoid_: AutoCertifiedCourtPackage

### Events & Incident Orchestration

**VigilOneEvent**:
A canonical structured domain event emitted by cameras, vision analytics, physical sensors, or system monitors.
_Avoid_: AlertMessage, RawNotification, TriggerPayload

**IncidentOrchestrator**:
The authoritative module evaluating incoming events against rule matrices, driving alarm lifecycle states, executing hardware relay actions, and dispatching notifications.
_Avoid_: EventActionManager, AlarmRouter, WorkflowService

### Spatial Intelligence

**SpatialEngine**:
The authoritative module evaluating spatial state, directional line crossings, dwell hysteresis, exclusion masks, and 2D floorplan FOV projections from tracking observations.
_Avoid_: MotionCalculator, GeometryService, TripwireDetector
