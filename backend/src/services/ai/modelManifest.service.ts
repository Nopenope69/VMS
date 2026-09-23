datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum Role {
  SUPER_ADMIN
  TENANT_ADMIN
  OPERATOR
  VIEWER
}

enum LicenseTier {
  BASIC
  PROFESSIONAL
  ENTERPRISE
}

enum StreamProtocol {
  RTSP
  WHEP
  HLS
}

enum RecordingMode {
  CONTINUOUS
  SCHEDULED
  MOTION
  OFF
}

enum RecorderState {
  STOPPED
  STARTING
  RUNNING
  STOPPING
  ERROR
}

enum VolumeStatus {
  HEALTHY
  DEGRADED
  READ_ONLY
  UNMOUNTED
}

enum RetentionPriority {
  HIGH
  NORMAL
  LOW
}

enum DegradationReason {
  NONE
  STORAGE_PRESSURE_WARNING
  STORAGE_PRESSURE_CRITICAL
  EVIDENCE_PRESERVATION
}

enum SegmentStatus {
  RECORDING
  FINALIZED
  CORRUPTED
  ARCHIVED
  FILE_MISSING
  QUARANTINED
  RECOVERY_FAILED
}

enum JobStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

enum ExportMode {
  STREAM_COPY
  FRAME_ACCURATE
}

enum ExportStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}

enum SigningMode {
  IN_APP_DESIGNATED
  EXTERNAL_PHYSICAL
}

enum EventType {
  MOTION
  CAMERA_ONLINE
  CAMERA_OFFLINE
  RECORDING_GAP
  RECORDING_FAILURE
  CORRUPTED_SEGMENT
  STORAGE_WARNING
  STREAM_DEGRADED
  PTZ_ERROR
  TAMPER
  PERSON_DETECTED
  VEHICLE_DETECTED
  STORAGE_FAILOVER
  STORAGE_DEGRADED_MODE_ACTIVE
  STORAGE_DEGRADED_MODE_CLEARED
  STORAGE_VOLUME_DEGRADED
  STORAGE_VOLUME_READONLY
  STORAGE_EVIDENCE_DEADLOCK_PREVENTION
  STORAGE_CORRUPT_SEGMENT_QUARANTINED
}

enum EventSeverity {
  INFO
  WARNING
  CRITICAL
}

enum ZoneType {
  INCLUSION
  EXCLUSION
}

enum TourState {
  STOPPED
  RUNNING
  PAUSED
  MANUAL_OVERRIDE
}

enum GridLayoutType {
  GRID_1X1
  GRID_2X2
  GRID_3X3
  GRID_1_PLUS_5
  GRID_4X4
}

enum LayoutVisibility {
  PRIVATE
  TENANT_SHARED
}

enum AlarmState {
  ACTIVE
  ACKNOWLEDGED
  RESOLVED
}

enum VehicleCategory {
  TWO_WHEELER
  FOUR_WHEELER
  HEAVY_COMMERCIAL
  EMERGENCY
  UNKNOWN
}

enum WatchlistCategory {
  WHITELIST
  BLACKLIST
  VIP
  SUSPECT
}

enum NotificationChannelType {
  WEBHOOK
  SLACK
  EMAIL
}

enum NotificationJobStatus {
  PENDING
  PROCESSING
  DELIVERED
  DEAD_LETTER
}

enum NodeState {
  PAIRING
  ONLINE
  OFFLINE
  SYNCING
  DEGRADED
}

enum RuleTriggerType {
  MOTION_ZONE
  ANPR_WATCHLIST
  PERSON_DETECTED
  VEHICLE_DETECTED
  TRIPWIRE_CROSS
  LOITERING_DWELL
  CAMERA_OFFLINE
  SCENE_CHANGE
  DIGITAL_INPUT_STATE
}

enum RuleActionType {
  TRIGGER_ALARM
  PTZ_PRESET_GOTO
  DISPATCH_NOTIFICATION
  START_HIGH_RES_RECORDING
  FIRE_DO_RELAY
  BOOKMARK_SEGMENT
}

enum TripwireDirection {
  A_TO_B
  B_TO_A
  BIDIRECTIONAL
}

enum RelayPinDirection {
  INPUT
  OUTPUT
}

enum RelayCommandState {
  COMMAND_SENT
  COMMAND_ACK
  STATE_CONFIRMED
  COMMAND_FAILED
}

enum RelayConfirmationMode {
  ACK_ONLY
  STATE_FEEDBACK
  PULSE_COMPLETION
}

enum ArchiveJobStatus {
  QUEUED
  UPLOADING
  COMPLETED
  FAILED
}

enum IdentityProviderType {
  OIDC
}

enum SessionState {
  ACTIVE
  LOCKED
  REVOKED
  EXPIRED
}

enum PlaybackSessionState {
  STOPPED
  PLAYING
  PAUSED
  SEEKING
  BUFFERING
}

enum RedactionMode {
  FACE
  LICENSE_PLATE
  BYSTANDER
  STATIC_MASK
}

enum RedactionJobStatus {
  QUEUED
  PROCESSING
  COMPLETED
  FAILED
}

model Tenant {
  id          String   @id @default(uuid())
  name        String
  slug        String   @unique
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  users                 User[]
  sites                 Site[]
  cameras               Camera[]
  auditEvents           AuditEvent[]
  exports               EvidenceExport[]
  licenses              License[]
  eventRules            EventRule[]
  layouts               Layout[]
  alarms                Alarm[]
  retentionPolicies     RetentionPolicy[]
  detectionEvents       DetectionEvent[]
  vehicleObservations   VehicleObservation[]
  vehicleWatchlists     VehicleWatchlist[]
  notificationChannels  NotificationChannel[]
  notificationJobs      NotificationJob[]
  notificationLogs      NotificationLog[]
  aiRuntimeDiagnostics  AiRuntimeDiagnostic[]
  federatedNodes        FederatedNode[]
  automationRules       AutomationRule[]
  spatialAnalyticsRules SpatialAnalyticsRule[]
  digitalIoPins         DigitalIoPin[]
  objectStorageConfig   ObjectStorageConfig?
  archiveJobs           ArchiveJob[]
  identityProviders     IdentityProvider[]
  userSessions          UserSession[]
  recordingSegments     RecordingSegment[]
  playbackSessions      PlaybackSession[]
  evidenceManifests     EvidenceManifest[]
  privacyPolicies       PrivacyPolicy[]
  redactionJobs         RedactionJob[]
  floorplans            Floorplan[]
  chainOfCustodyLogs    ChainOfCustodyLog[]
  storageVolumes        StorageVolume[]
  storageEpochs         StorageEpoch[]
  modelManifests        ModelManifest[]
}

model ModelManifest {
  id             String   @id @default(uuid())
  tenantId       String
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  version        String
  sha256         String
  codeLicense    String
  weightLicense  String
  trainingData   String?
  thresholdsJson Json?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  detectionEvents DetectionEvent[]

  @@index([tenantId, version])
  @@unique([tenantId, sha256])
}

model License {
  id               String      @id @default(uuid())
  tenantId         String
  tenant           Tenant      @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  licenseId        String      @unique
  tier             LicenseTier @default(ENTERPRISE)
  maxCameras       Int         @default(16)
  features         String[]    @default(["ANPR", "MULTI_SITE", "ADVANCED_PTZ", "EVIDENCE_EXPORT"])
  issuedAt         DateTime    @default(now())
  expiresAt        DateTime?
  signedPayload    String
  signatureEd25519 String
  installationId   String?
  deviceBinding    String?
  appliedAt        DateTime    @default(now())
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt

  @@index([tenantId])
}

model User {
  id           String     @id @default(uuid())
  tenantId     String
  tenant       Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  email        String     @unique
  passwordHash String
  name         String
  role         Role       @default(OPERATOR)
  active       Boolean    @default(true)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  auditEvents       AuditEvent[]
  exports           EvidenceExport[]   @relation("RequestedExports")
  approvedExports   EvidenceExport[]   @relation("ApprovedExports")
  layouts           Layout[]
  userSessions      UserSession[]
  playbackSessions  PlaybackSession[]
  evidenceManifests EvidenceManifest[]
  redactionJobs     RedactionJob[]
}

model Camera {
  id              String         @id @default(uuid())
  tenantId        String
  tenant          Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  siteId          String
  site            Site           @relation(fields: [siteId], references: [id], onDelete: Cascade)
  name            String
  streamPath      String         @unique
  ipAddress       String
  onvifPort       Int            @default(80)
  rtspPort        Int            @default(554)
  encryptedAuth   String?
  manufacturer    String?
  model           String?
  firmwareVersion String?
  serialNumber    String?
  macAddress      String?
  hasPtz          Boolean        @default(false)
  vendorQuirks    String[]       @default([])
  mainRtspUri           String
  subRtspUri            String?
  recordingMode         RecordingMode  @default(CONTINUOUS)
  effectiveRecordingMode RecordingMode @default(CONTINUOUS)
  degradationReason     DegradationReason @default(NONE)
  degradationSince      DateTime?
  retentionPriority     RetentionPriority @default(NORMAL)
  storageVolumeId       String?
  storageVolume         StorageVolume? @relation(fields: [storageVolumeId], references: [id], onDelete: SetNull)
  recorderState         RecorderState  @default(STOPPED)
  desiredRecorderState  RecorderState  @default(STOPPED)
  observedRecorderState RecorderState  @default(STOPPED)
  lastStateChangeAt     DateTime       @default(now())
  lastReconciledAt      DateTime?
  lastRecorderError     String?
  isOnline              Boolean        @default(false)
  lastSeenAt            DateTime?
  createdAt             DateTime       @default(now())
  updatedAt             DateTime       @updatedAt

  segments              RecordingSegment[]
  storageEpochs         StorageEpoch[]
  retentionPolicy       RetentionPolicy?
  events                Event[]
  exports               EvidenceExport[]
  recordingSchedule     RecordingSchedule?
  detectionZones        DetectionZone[]
  ptzPresets            PtzPreset[]
  ptzTours              PtzTour[]
  ptzLock               PtzLock?
  streamBaseline        StreamProfileBaseline?
  diagnostics           StreamDiagnostic[]
  alarms                Alarm[]
  detectionEvents       DetectionEvent[]
  vehicleObservations   VehicleObservation[]
  spatialAnalyticsRules SpatialAnalyticsRule[]
  spatialPlacement      CameraSpatialPlacement?

  @@index([tenantId, siteId])
  @@index([streamPath])
}

model RecordingSegment {
  id                  String        @id @default(uuid())
  tenantId            String?
  tenant              Tenant?       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId            String
  camera              Camera        @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  filePath            String        @unique
  startTime           DateTime
  endTime             DateTime
  durationMs          Int
  sizeBytes           BigInt
  sha256Hash          String?
  codec               String?       @default("h264")
  width               Int?
  height              Int?
  fps                 Float?
  status              SegmentStatus @default(FINALIZED)
  startPts            BigInt        @default(0)
  endPts              BigInt        @default(0)
  timebaseNumerator   Int           @default(1)
  timebaseDenominator Int           @default(90000)
  keyframeIndexJson   Json?
  storageLocation     String        @default("LOCAL")
  storageVolumeId     String?
  storageVolume       StorageVolume? @relation(fields: [storageVolumeId], references: [id], onDelete: SetNull)
  storageEpochId      String?
  storageEpoch        StorageEpoch?  @relation(fields: [storageEpochId], references: [id], onDelete: SetNull)
  originalSha256      String?
  repairedSha256      String?
  repairedAt          DateTime?
  quarantineReason    String?
  createdAt           DateTime      @default(now())

  evidencePins        EvidencePin[]

  @@index([cameraId, startTime, endTime])
  @@index([status])
  @@index([tenantId, cameraId, startTime])
}

model EvidencePin {
  id          String           @id @default(uuid())
  tenantId    String
  segmentId   String
  segment     RecordingSegment @relation(fields: [segmentId], references: [id], onDelete: Cascade)
  exportJobId String
  reason      String
  pinnedAt    DateTime         @default(now())
  expiresAt   DateTime
  releasedAt  DateTime?
  pinType     String           @default("TEMPORARY_EXPORT")

  @@index([segmentId, expiresAt, releasedAt])
  @@index([tenantId, expiresAt])
}

model SegmentJob {
  id          String    @id @default(uuid())
  tenantId    String
  cameraId    String
  streamPath  String
  segmentPath String
  status      JobStatus @default(PENDING)
  attempts    Int       @default(0)
  maxAttempts Int       @default(3)
  lastError   String?
  createdAt   DateTime  @default(now())
  processedAt DateTime?

  @@unique([tenantId, segmentPath])
  @@index([status, createdAt])
}

model EventRule {
  id             String      @id @default(uuid())
  tenantId       String
  tenant         Tenant      @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name           String
  enabled        Boolean     @default(true)
  triggerType    EventType
  conditionsJson Json?
  actionsJson    Json
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  events         Event[]
  alarms         Alarm[]

  @@index([tenantId, triggerType])
}

model Event {
  id              String        @id @default(uuid())
  cameraId        String?
  camera          Camera?       @relation(fields: [cameraId], references: [id], onDelete: SetNull)
  ruleId          String?
  rule            EventRule?    @relation(fields: [ruleId], references: [id], onDelete: SetNull)

  type            EventType
  severity        EventSeverity @default(INFO)
  title           String
  description     String?
  metadata        Json?

  firstDetectedAt DateTime      @default(now())
  lastDetectedAt  DateTime      @default(now())
  durationSeconds Int           @default(0)
  motionSpikes    Int           @default(1)

  startTime       DateTime      @default(now())
  endTime         DateTime?
  acknowledged    Boolean       @default(false)
  acknowledgedAt  DateTime?
  acknowledgedBy  String?

  alarms          Alarm[]

  @@index([cameraId, startTime])
  @@index([type, severity, acknowledged])
}

model EvidenceExport {
  id             String       @id @default(uuid())
  tenantId       String
  tenant         Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId       String
  camera         Camera       @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  requestedById  String
  requestedBy    User         @relation("RequestedExports", fields: [requestedById], references: [id], onDelete: Restrict)

  startTime      DateTime
  endTime        DateTime
  exportMode     ExportMode   @default(STREAM_COPY)
  status         ExportStatus @default(PENDING)

  outputFilePath String?
  fileSizeBytes  BigInt?
  sha256Hash     String?
  signatureEd25519 String?

  partAPartyName         String?
  partAPartyDesignation  String?
  partBExpertName        String?
  partBExpertDesignation String?
  partBExpertOrganization String?
  partBSigningMode       SigningMode  @default(IN_APP_DESIGNATED)

  manifestJson   Json?
  errorMessage   String?
  createdAt      DateTime     @default(now())
  completedAt    DateTime?

  manifestId          String?
  manifest            EvidenceManifest? @relation(fields: [manifestId], references: [id], onDelete: SetNull)
  parentManifestId    String?
  outputObjectKey     String?
  outputSha256        String?
  format              String?          @default("MP4")
  redactionPolicyId   String?
  approvedByUserId    String?
  approvedByUser      User?            @relation("ApprovedExports", fields: [approvedByUserId], references: [id], onDelete: SetNull)

  @@index([tenantId, cameraId])
  @@index([status])
}

model DetectionEvent {
  id             String        @id @default(uuid())
  tenantId       String
  tenant         Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId       String
  camera         Camera        @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  modelManifestId String?
  modelManifest   ModelManifest? @relation(fields: [modelManifestId], references: [id], onDelete: SetNull)
  trackId        String?
  type           EventType
  confidence     Float         @default(1.0)

  boundingBox    Json?
  centroid       Json?
  attributesJson Json?
  snapshotPath   String?
  timestamp      DateTime      @default(now())

  @@index([tenantId, type, timestamp])
  @@index([cameraId, timestamp])
}

model VehicleObservation {
  id                 String            @id @default(uuid())
  tenantId           String
  tenant             Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId           String
  camera             Camera            @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  trackId            String?

  plateNumber        String
  normalizedPlate    String
  stateCode          String?
  vehicleCategory    VehicleCategory   @default(UNKNOWN)

  firstSeenAt        DateTime          @default(now())
  lastSeenAt         DateTime          @default(now())
  observationCount   Int               @default(1)
  bestConfidence     Float             @default(0.0)
  bestSnapshotPath   String?

  matchedWatchlistId String?
  matchedWatchlist   VehicleWatchlist? @relation(fields: [matchedWatchlistId], references: [id], onDelete: SetNull)

  createdAt          DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  @@index([tenantId, normalizedPlate])
  @@index([cameraId, lastSeenAt])
}

model VehicleWatchlist {
  id              String            @id @default(uuid())
  tenantId        String
  tenant          Tenant            @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  plateNumber     String
  normalizedPlate String            // Uppercase, alphanumeric only
  category        WatchlistCategory @default(BLACKLIST)
  ownerName       String?
  notes           String?
  alertOnMatch    Boolean           @default(true)
  severity        EventSeverity     @default(CRITICAL)
  active          Boolean           @default(true)
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt

  observations    VehicleObservation[]

  @@unique([tenantId, normalizedPlate])
  @@index([tenantId, category, active])
}

model NotificationChannel {
  id          String                  @id @default(uuid())
  tenantId    String
  tenant      Tenant                  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  type        NotificationChannelType @default(WEBHOOK)
  targetUrl   String
  secretToken String?
  configJson  Json?
  minSeverity EventSeverity           @default(WARNING)
  enabled     Boolean                 @default(true)
  createdAt   DateTime                @default(now())
  updatedAt   DateTime                @updatedAt

  jobs        NotificationJob[]
  logs        NotificationLog[]

  @@index([tenantId, enabled])
}

model NotificationJob {
  id             String                @id @default(uuid())
  tenantId       String
  tenant         Tenant                @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  channelId      String
  channel        NotificationChannel   @relation(fields: [channelId], references: [id], onDelete: Cascade)
  alarmId        String
  alarm          Alarm                 @relation(fields: [alarmId], references: [id], onDelete: Cascade)

  idempotencyKey String                @unique
  status         NotificationJobStatus @default(PENDING)
  attempts       Int                   @default(0)
  maxAttempts    Int                   @default(3)
  nextRetryAt    DateTime?
  error          String?
  payloadJson    Json
  createdAt      DateTime              @default(now())
  processedAt    DateTime?

  @@index([tenantId, status, nextRetryAt])
}

model NotificationLog {
  id           String              @id @default(uuid())
  tenantId     String
  tenant       Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  channelId    String
  channel      NotificationChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)
  alarmId      String
  alarm        Alarm               @relation(fields: [alarmId], references: [id], onDelete: Cascade)
  status       String
  responseCode Int?
  latencyMs    Int?
  error        String?
  dispatchedAt DateTime            @default(now())

  @@index([tenantId, dispatchedAt])
  @@index([channelId, status])
}

model AiRuntimeDiagnostic {
  id                  String   @id @default(uuid())
  tenantId            String
  tenant              Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  inferenceFps        Float    @default(0.0)
  processingLatencyMs Float    @default(0.0)
  queueDepth          Int      @default(0)
  droppedFrames       Int      @default(0)
  modelLoadState      String   @default("READY")
  memoryMb            Float    @default(0.0)
  checkedAt           DateTime @default(now())

  @@index([tenantId, checkedAt])
}

model FederatedNode {
  id                     String             @id @default(uuid())
  tenantId               String
  tenant                 Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  nodeUuid               String             @unique
  name                   String
  publicKeyEd25519       String
  certificateFingerprint String
  softwareVersion        String
  protocolVersion        Int                @default(1)
  schemaVersion          String
  capabilitiesJson       Json
  state                  NodeState          @default(PAIRING)
  lastSeenAt             DateTime?
  syncCursorEvent        BigInt             @default(0)
  syncCursorAudit        BigInt             @default(0)
  syncCursorAlarm        BigInt             @default(0)
  configVersionApplied   Int                @default(0)
  configRecords          ConfigSyncRecord[]
  createdAt              DateTime           @default(now())
  updatedAt              DateTime           @updatedAt

  @@index([tenantId, state])
}

model ConfigSyncRecord {
  id             String   @id @default(uuid())
  tenantId       String
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  nodeId         String
  node           FederatedNode @relation(fields: [nodeId], references: [id], onDelete: Cascade)
  type           String
  payloadJson    Json
  syncedAt       DateTime @default(now())

  @@index([tenantId, syncedAt])
}

model AutomationRule {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  enabled     Boolean  @default(true)
  triggerType RuleTriggerType
  actionsJson Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, triggerType])
}

model SpatialAnalyticsRule {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId     String?
  camera       Camera?  @relation(fields: [cameraId], references: [id], onDelete: SetNull)
  name        String
  enabled     Boolean  @default(true)
  threshold   Float?
  metadataJson Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, cameraId])
}

model DigitalIoPin {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  pinNumber   Int
  direction   RelayPinDirection @default(INPUT)
  enabled     Boolean @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, enabled])
}

model ObjectStorageConfig {
  id          String   @id @default(uuid())
  tenantId    String   @unique
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  provider    String
  bucket      String
  region      String?
  accessKey   String?
  secretKey   String?
  endpoint    String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model ArchiveJob {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  status      ArchiveJobStatus @default(QUEUED)
  objectKey   String?
  sha256      String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, status])
}

model IdentityProvider {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  type        IdentityProviderType @default(OIDC)
  issuerUrl   String
  clientId    String
  discoveryJson Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model UserSession {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  state       SessionState @default(ACTIVE)
  refreshTokenHash String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, userId])
}

model PlaybackSession {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  state       PlaybackSessionState @default(STOPPED)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, state])
}

model EvidenceManifest {
  id           String   @id @default(uuid())
  tenantId     String
  tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId     String?
  camera       Camera?  @relation(fields: [cameraId], references: [id], onDelete: SetNull)
  createdByUserId String?
  masterEvidenceHash String?
  manifestJson Json?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([tenantId, cameraId])
}

model PrivacyPolicy {
  id             String   @id @default(uuid())
  tenantId       String
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name           String
  enabled        Boolean  @default(true)
  faceRedaction  Boolean  @default(false)
  plateRedaction Boolean  @default(false)
  bystanderRedaction Boolean @default(false)
  restrictedZonesJson Json?
  defaultExportMode String? @default("STREAM_COPY")
  approvalRequired Boolean @default(false)
  retentionDays Int @default(30)
  version Int @default(1)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId, enabled])
}

model RedactionJob {
  id                 String   @id @default(uuid())
  tenantId           String
  tenant             Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  createdByUserId    String?
  createdBy          User?    @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)
  sourceManifestId   String?
  sourceManifest     EvidenceManifest? @relation(fields: [sourceManifestId], references: [id], onDelete: SetNull)
  privacyPolicyId    String?
  redactionMode      RedactionMode @default(FACE)
  modelVersion       String?
  maskMetadataJson   Json?
  status             RedactionJobStatus @default(QUEUED)
  outputObjectKey    String?
  outputSha256       String?
  errorMessage       String?
  createdAt          DateTime @default(now())
  completedAt        DateTime?

  @@index([tenantId, status])
}

model Floorplan {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  siteId      String?
  site        Site?    @relation(fields: [siteId], references: [id], onDelete: SetNull)
  name        String
  bitmapData  String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, siteId])
}

model ChainOfCustodyLog {
  id           String   @id @default(uuid())
  tenantId     String
  tenant       Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  evidenceId   String
  action       String
  sourceHash   String
  resultHash   String?
  metadataJson Json?
  createdAt    DateTime @default(now())

  @@index([tenantId, evidenceId, createdAt])
}

model StorageVolume {
  id             String   @id @default(uuid())
  tenantId       String
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name           String
  path           String
  status         VolumeStatus @default(HEALTHY)
  capacityBytes  BigInt?
  usedBytes      BigInt?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([tenantId, status])
}

model StorageEpoch {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  epochNumber Int
  startedAt   DateTime @default(now())
  endedAt     DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, epochNumber])
}

model CameraSpatialPlacement {
  id          String   @id @default(uuid())
  cameraId     String   @unique
  camera       Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  x           Float?
  y           Float?
  width       Float?
  height      Float?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model StreamProfileBaseline {
  id                     String   @id @default(uuid())
  cameraId               String   @unique
  camera                 Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  expectedFps            Float    @default(25.0)
  expectedBitrateKbpsMin Int      @default(1500)
  expectedBitrateKbpsMax Int      @default(6000)
  expectedResolution     String   @default("1920x1080")
  expectedGopSeconds     Float    @default(2.0)
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
}

model StreamDiagnostic {
  id             String   @id @default(uuid())
  tenantId       String
  tenant         Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId       String
  camera         Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  fps            Float
  bitrateKbps    Int
  resolution     String
  videoCodec     String
  audioCodec     String?
  gopInterval    Float?
  deviationScore Float    @default(0.0)
  isDegraded     Boolean  @default(false)
  degradedReason String?
  checkedAt      DateTime @default(now())

  @@index([cameraId, checkedAt])
  @@index([tenantId, isDegraded])
}

model Alarm {
  id               String        @id @default(uuid())
  tenantId         String
  tenant           Tenant        @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  cameraId         String?
  camera           Camera?       @relation(fields: [cameraId], references: [id], onDelete: SetNull)
  eventId          String?
  event            Event?        @relation(fields: [eventId], references: [id], onDelete: SetNull)
  ruleId           String?
  rule             EventRule?    @relation(fields: [ruleId], references: [id], onDelete: SetNull)

  title            String
  description      String?
  severity         EventSeverity @default(WARNING)
  state            AlarmState    @default(ACTIVE)
  metadataJson     Json?

  triggeredAt      DateTime      @default(now())
  acknowledgedAt   DateTime?
  acknowledgedById String?
  resolvedAt       DateTime?
  resolvedById     String?
  resolutionNotes  String?

  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  notificationJobs NotificationJob[]
  notificationLogs NotificationLog[]

  @@index([tenantId, state, severity])
  @@index([cameraId, triggeredAt])
}

model DetectionZone {
  id                 String   @id @default(uuid())
  tenantId           String
  cameraId           String
  camera             Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  name               String
  type               ZoneType @default(INCLUSION)
  priority           Int      @default(0)
  enabled            Boolean  @default(true)
  polygonCoordinates Json
  version            Int      @default(1)
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@index([tenantId, cameraId])
}

model PtzPreset {
  id          String   @id @default(uuid())
  tenantId    String
  cameraId    String
  camera      Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  name        String
  presetToken String
  pan         Float?
  tilt        Float?
  zoom        Float?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([cameraId, name])
  @@unique([cameraId, presetToken])
  @@index([tenantId, cameraId])
}

model PtzTour {
  id          String    @id @default(uuid())
  tenantId    String
  cameraId    String
  camera      Camera    @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  name        String
  state       TourState @default(STOPPED)
  stepsJson   Json
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  @@index([tenantId, cameraId])
}

model PtzLock {
  id         String   @id @default(uuid())
  cameraId   String   @unique
  camera     Camera   @relation(fields: [cameraId], references: [id], onDelete: Cascade)
  userId     String
  acquiredAt DateTime @default(now())
  expiresAt  DateTime

  @@index([cameraId, expiresAt])
}

model Layout {
  id          String           @id @default(uuid())
  tenantId    String
  tenant      Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  userId      String?
  user        User?            @relation(fields: [userId], references: [id], onDelete: SetNull)
  name        String
  gridType    GridLayoutType   @default(GRID_2X2)
  visibility  LayoutVisibility @default(PRIVATE)
  isDefault   Boolean          @default(false)
  slotsJson   Json
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt

  @@index([tenantId, userId])
}

model EventActionRule {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  enabled     Boolean  @default(true)
  triggerType RuleTriggerType
  actionType  RuleActionType
  configJson  Json
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tenantId, triggerType])
}

model FaceWatchlist {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  notes       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model OidcProvider {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  issuer      String
  clientId    String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

model ClusterNode {
  id          String   @id @default(uuid())
  tenantId    String
  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name        String
  state       String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
