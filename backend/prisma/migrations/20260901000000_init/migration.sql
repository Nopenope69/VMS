-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'TENANT_ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "LicenseTier" AS ENUM ('BASIC', 'PROFESSIONAL', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "StreamProtocol" AS ENUM ('RTSP', 'WHEP', 'HLS');

-- CreateEnum
CREATE TYPE "RecordingMode" AS ENUM ('CONTINUOUS', 'SCHEDULED', 'MOTION', 'OFF');

-- CreateEnum
CREATE TYPE "RecorderState" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR');

-- CreateEnum
CREATE TYPE "VolumeStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'READ_ONLY', 'UNMOUNTED');

-- CreateEnum
CREATE TYPE "RetentionPriority" AS ENUM ('HIGH', 'NORMAL', 'LOW');

-- CreateEnum
CREATE TYPE "DegradationReason" AS ENUM ('NONE', 'STORAGE_PRESSURE_WARNING', 'STORAGE_PRESSURE_CRITICAL', 'EVIDENCE_PRESERVATION');

-- CreateEnum
CREATE TYPE "SegmentStatus" AS ENUM ('RECORDING', 'FINALIZED', 'CORRUPTED', 'ARCHIVED', 'FILE_MISSING', 'QUARANTINED', 'RECOVERY_FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportMode" AS ENUM ('STREAM_COPY', 'FRAME_ACCURATE');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SigningMode" AS ENUM ('IN_APP_DESIGNATED', 'EXTERNAL_PHYSICAL');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('MOTION', 'CAMERA_ONLINE', 'CAMERA_OFFLINE', 'RECORDING_GAP', 'RECORDING_FAILURE', 'CORRUPTED_SEGMENT', 'STORAGE_WARNING', 'STREAM_DEGRADED', 'PTZ_ERROR', 'TAMPER', 'PERSON_DETECTED', 'VEHICLE_DETECTED', 'STORAGE_FAILOVER', 'STORAGE_DEGRADED_MODE_ACTIVE', 'STORAGE_DEGRADED_MODE_CLEARED', 'STORAGE_VOLUME_DEGRADED', 'STORAGE_VOLUME_READONLY', 'STORAGE_EVIDENCE_DEADLOCK_PREVENTION', 'STORAGE_CORRUPT_SEGMENT_QUARANTINED');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('INCLUSION', 'EXCLUSION');

-- CreateEnum
CREATE TYPE "TourState" AS ENUM ('STOPPED', 'RUNNING', 'PAUSED', 'MANUAL_OVERRIDE');

-- CreateEnum
CREATE TYPE "GridLayoutType" AS ENUM ('GRID_1X1', 'GRID_2X2', 'GRID_3X3', 'GRID_1_PLUS_5', 'GRID_4X4');

-- CreateEnum
CREATE TYPE "LayoutVisibility" AS ENUM ('PRIVATE', 'TENANT_SHARED');

-- CreateEnum
CREATE TYPE "AlarmState" AS ENUM ('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "VehicleCategory" AS ENUM ('TWO_WHEELER', 'FOUR_WHEELER', 'HEAVY_COMMERCIAL', 'EMERGENCY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WatchlistCategory" AS ENUM ('WHITELIST', 'BLACKLIST', 'VIP', 'SUSPECT');

-- CreateEnum
CREATE TYPE "NotificationChannelType" AS ENUM ('WEBHOOK', 'SLACK', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DELIVERED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "NodeState" AS ENUM ('PAIRING', 'ONLINE', 'OFFLINE', 'SYNCING', 'DEGRADED');

-- CreateEnum
CREATE TYPE "RuleTriggerType" AS ENUM ('MOTION_ZONE', 'ANPR_WATCHLIST', 'PERSON_DETECTED', 'VEHICLE_DETECTED', 'TRIPWIRE_CROSS', 'LOITERING_DWELL', 'CAMERA_OFFLINE', 'SCENE_CHANGE', 'DIGITAL_INPUT_STATE');

-- CreateEnum
CREATE TYPE "RuleActionType" AS ENUM ('TRIGGER_ALARM', 'PTZ_PRESET_GOTO', 'DISPATCH_NOTIFICATION', 'START_HIGH_RES_RECORDING', 'FIRE_DO_RELAY', 'BOOKMARK_SEGMENT');

-- CreateEnum
CREATE TYPE "TripwireDirection" AS ENUM ('A_TO_B', 'B_TO_A', 'BIDIRECTIONAL');

-- CreateEnum
CREATE TYPE "RelayPinDirection" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "RelayCommandState" AS ENUM ('COMMAND_SENT', 'COMMAND_ACK', 'STATE_CONFIRMED', 'COMMAND_FAILED');

-- CreateEnum
CREATE TYPE "RelayConfirmationMode" AS ENUM ('ACK_ONLY', 'STATE_FEEDBACK', 'PULSE_COMPLETION');

-- CreateEnum
CREATE TYPE "ArchiveJobStatus" AS ENUM ('QUEUED', 'UPLOADING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "IdentityProviderType" AS ENUM ('OIDC');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('ACTIVE', 'LOCKED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PlaybackSessionState" AS ENUM ('STOPPED', 'PLAYING', 'PAUSED', 'SEEKING', 'BUFFERING');

-- CreateEnum
CREATE TYPE "RedactionMode" AS ENUM ('FACE', 'LICENSE_PLATE', 'BYSTANDER', 'STATIC_MASK');

-- CreateEnum
CREATE TYPE "RedactionJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "licenseId" TEXT NOT NULL,
    "tier" "LicenseTier" NOT NULL DEFAULT 'ENTERPRISE',
    "maxCameras" INTEGER NOT NULL DEFAULT 16,
    "features" TEXT[] DEFAULT ARRAY['ANPR', 'MULTI_SITE', 'ADVANCED_PTZ', 'EVIDENCE_EXPORT']::TEXT[],
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "signedPayload" TEXT NOT NULL,
    "signatureEd25519" TEXT NOT NULL,
    "installationId" TEXT,
    "deviceBinding" TEXT,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "License_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Camera" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "streamPath" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "onvifPort" INTEGER NOT NULL DEFAULT 80,
    "rtspPort" INTEGER NOT NULL DEFAULT 554,
    "encryptedAuth" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "firmwareVersion" TEXT,
    "serialNumber" TEXT,
    "macAddress" TEXT,
    "hasPtz" BOOLEAN NOT NULL DEFAULT false,
    "vendorQuirks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mainRtspUri" TEXT NOT NULL,
    "subRtspUri" TEXT,
    "recordingMode" "RecordingMode" NOT NULL DEFAULT 'CONTINUOUS',
    "effectiveRecordingMode" "RecordingMode" NOT NULL DEFAULT 'CONTINUOUS',
    "degradationReason" "DegradationReason" NOT NULL DEFAULT 'NONE',
    "degradationSince" TIMESTAMP(3),
    "retentionPriority" "RetentionPriority" NOT NULL DEFAULT 'NORMAL',
    "storageVolumeId" TEXT,
    "recorderState" "RecorderState" NOT NULL DEFAULT 'STOPPED',
    "desiredRecorderState" "RecorderState" NOT NULL DEFAULT 'STOPPED',
    "observedRecorderState" "RecorderState" NOT NULL DEFAULT 'STOPPED',
    "lastStateChangeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReconciledAt" TIMESTAMP(3),
    "lastRecorderError" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Camera_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingSegment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "cameraId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256Hash" TEXT,
    "codec" TEXT DEFAULT 'h264',
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "status" "SegmentStatus" NOT NULL DEFAULT 'FINALIZED',
    "startPts" BIGINT NOT NULL DEFAULT 0,
    "endPts" BIGINT NOT NULL DEFAULT 0,
    "timebaseNumerator" INTEGER NOT NULL DEFAULT 1,
    "timebaseDenominator" INTEGER NOT NULL DEFAULT 90000,
    "keyframeIndexJson" JSONB,
    "storageLocation" TEXT NOT NULL DEFAULT 'LOCAL',
    "storageVolumeId" TEXT,
    "storageEpochId" TEXT,
    "originalSha256" TEXT,
    "repairedSha256" TEXT,
    "repairedAt" TIMESTAMP(3),
    "quarantineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecordingSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePin" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "exportJobId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "pinType" TEXT NOT NULL DEFAULT 'TEMPORARY_EXPORT',

    CONSTRAINT "EvidencePin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "streamPath" TEXT NOT NULL,
    "segmentPath" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "SegmentJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" "EventType" NOT NULL,
    "conditionsJson" JSONB,
    "actionsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT,
    "ruleId" TEXT,
    "type" "EventType" NOT NULL,
    "severity" "EventSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "motionSpikes" INTEGER NOT NULL DEFAULT 1,
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceExport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "exportMode" "ExportMode" NOT NULL DEFAULT 'STREAM_COPY',
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "outputFilePath" TEXT,
    "fileSizeBytes" BIGINT,
    "sha256Hash" TEXT,
    "signatureEd25519" TEXT,
    "partAPartyName" TEXT,
    "partAPartyDesignation" TEXT,
    "partBExpertName" TEXT,
    "partBExpertDesignation" TEXT,
    "partBExpertOrganization" TEXT,
    "partBSigningMode" "SigningMode" NOT NULL DEFAULT 'IN_APP_DESIGNATED',
    "manifestJson" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "manifestId" TEXT,
    "parentManifestId" TEXT,
    "outputObjectKey" TEXT,
    "outputSha256" TEXT,
    "format" TEXT DEFAULT 'MP4',
    "redactionPolicyId" TEXT,
    "approvedByUserId" TEXT,

    CONSTRAINT "EvidenceExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "sequenceNumber" BIGSERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "timestampUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "metadataJson" JSONB,
    "prevHash" TEXT NOT NULL,
    "eventHash" TEXT NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT,
    "continuousDays" INTEGER NOT NULL DEFAULT 30,
    "motionDays" INTEGER NOT NULL DEFAULT 90,
    "maxStorageGigabytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RetentionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordingSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "weeklyMatrixJson" JSONB NOT NULL,
    "lastAppliedMode" "RecordingMode",
    "lastAppliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectionZone" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ZoneType" NOT NULL DEFAULT 'INCLUSION',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "polygonCoordinates" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DetectionZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtzPreset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "presetToken" TEXT NOT NULL,
    "pan" DOUBLE PRECISION,
    "tilt" DOUBLE PRECISION,
    "zoom" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PtzPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtzTour" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" "TourState" NOT NULL DEFAULT 'STOPPED',
    "stepsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PtzTour_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PtzLock" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PtzLock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Layout" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "gridType" "GridLayoutType" NOT NULL DEFAULT 'GRID_2X2',
    "visibility" "LayoutVisibility" NOT NULL DEFAULT 'PRIVATE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "slotsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Layout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamProfileBaseline" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "expectedFps" DOUBLE PRECISION NOT NULL DEFAULT 25.0,
    "expectedBitrateKbpsMin" INTEGER NOT NULL DEFAULT 1500,
    "expectedBitrateKbpsMax" INTEGER NOT NULL DEFAULT 6000,
    "expectedResolution" TEXT NOT NULL DEFAULT '1920x1080',
    "expectedGopSeconds" DOUBLE PRECISION NOT NULL DEFAULT 2.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StreamProfileBaseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreamDiagnostic" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "fps" DOUBLE PRECISION NOT NULL,
    "bitrateKbps" INTEGER NOT NULL,
    "resolution" TEXT NOT NULL,
    "videoCodec" TEXT NOT NULL,
    "audioCodec" TEXT,
    "gopInterval" DOUBLE PRECISION,
    "deviationScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isDegraded" BOOLEAN NOT NULL DEFAULT false,
    "degradedReason" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreamDiagnostic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alarm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT,
    "eventId" TEXT,
    "ruleId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "EventSeverity" NOT NULL DEFAULT 'WARNING',
    "state" "AlarmState" NOT NULL DEFAULT 'ACTIVE',
    "metadataJson" JSONB,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolutionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alarm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectionEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "trackId" TEXT,
    "type" "EventType" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "boundingBox" JSONB,
    "centroid" JSONB,
    "attributesJson" JSONB,
    "snapshotPath" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleObservation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "trackId" TEXT,
    "plateNumber" TEXT NOT NULL,
    "normalizedPlate" TEXT NOT NULL,
    "stateCode" TEXT,
    "vehicleCategory" "VehicleCategory" NOT NULL DEFAULT 'UNKNOWN',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationCount" INTEGER NOT NULL DEFAULT 1,
    "bestConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "bestSnapshotPath" TEXT,
    "matchedWatchlistId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleWatchlist" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "normalizedPlate" TEXT NOT NULL,
    "category" "WatchlistCategory" NOT NULL DEFAULT 'BLACKLIST',
    "ownerName" TEXT,
    "notes" TEXT,
    "alertOnMatch" BOOLEAN NOT NULL DEFAULT true,
    "severity" "EventSeverity" NOT NULL DEFAULT 'CRITICAL',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleWatchlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "NotificationChannelType" NOT NULL DEFAULT 'WEBHOOK',
    "targetUrl" TEXT NOT NULL,
    "secretToken" TEXT,
    "configJson" JSONB,
    "minSeverity" "EventSeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "NotificationJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3),
    "error" TEXT,
    "payloadJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "NotificationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "alarmId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "responseCode" INTEGER,
    "latencyMs" INTEGER,
    "error" TEXT,
    "dispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiRuntimeDiagnostic" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "inferenceFps" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "processingLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "droppedFrames" INTEGER NOT NULL DEFAULT 0,
    "modelLoadState" TEXT NOT NULL DEFAULT 'READY',
    "memoryMb" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiRuntimeDiagnostic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederatedNode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nodeUuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "publicKeyEd25519" TEXT NOT NULL,
    "certificateFingerprint" TEXT NOT NULL,
    "softwareVersion" TEXT NOT NULL,
    "protocolVersion" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" TEXT NOT NULL,
    "capabilitiesJson" JSONB NOT NULL,
    "state" "NodeState" NOT NULL DEFAULT 'PAIRING',
    "lastSeenAt" TIMESTAMP(3),
    "syncCursorEvent" BIGINT NOT NULL DEFAULT 0,
    "syncCursorAudit" BIGINT NOT NULL DEFAULT 0,
    "syncCursorAlarm" BIGINT NOT NULL DEFAULT 0,
    "configVersionApplied" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FederatedNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigSyncRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "desiredVersion" INTEGER NOT NULL,
    "appliedVersion" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "errorMessage" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigSyncRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 30,
    "lastTriggeredAt" TIMESTAMP(3),
    "triggerType" "RuleTriggerType" NOT NULL,
    "triggerConfigJson" JSONB NOT NULL,
    "conditionsJson" JSONB NOT NULL,
    "actionsJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleExecutionRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "triggerEventId" TEXT,
    "correlationId" TEXT,
    "rootEventId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "overallStatus" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RuleExecutionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionExecutionRecord" (
    "id" TEXT NOT NULL,
    "ruleExecutionId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "actionType" "RuleActionType" NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "resultJson" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionExecutionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpatialAnalyticsRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "direction" "TripwireDirection" NOT NULL DEFAULT 'BIDIRECTIONAL',
    "lineCoordinatesJson" JSONB,
    "polygonCoordinatesJson" JSONB,
    "dwellThresholdSeconds" INTEGER DEFAULT 30,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpatialAnalyticsRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigitalIoPin" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "pinNumber" INTEGER NOT NULL,
    "direction" "RelayPinDirection" NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'LOW',
    "activeLow" BOOLEAN NOT NULL DEFAULT false,
    "confirmationMode" "RelayConfirmationMode" NOT NULL DEFAULT 'STATE_FEEDBACK',
    "timeoutMs" INTEGER NOT NULL DEFAULT 3000,
    "pulseDurationMs" INTEGER NOT NULL DEFAULT 3000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DigitalIoPin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelayCommandLog" (
    "id" TEXT NOT NULL,
    "pinId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "targetState" TEXT NOT NULL,
    "lifecycleState" "RelayCommandState" NOT NULL DEFAULT 'COMMAND_SENT',
    "issuedBy" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "RelayCommandLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectStorageConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'S3_COMPATIBLE',
    "endpoint" TEXT,
    "bucket" TEXT NOT NULL,
    "region" TEXT NOT NULL DEFAULT 'us-east-1',
    "accessKeyEncrypted" TEXT NOT NULL,
    "secretKeyEncrypted" TEXT NOT NULL,
    "offPeakStartUtc" TEXT NOT NULL DEFAULT '01:00',
    "offPeakEndUtc" TEXT NOT NULL DEFAULT '05:00',
    "bandwidthLimitKbps" INTEGER NOT NULL DEFAULT 2048,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObjectStorageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchiveJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segmentPath" TEXT NOT NULL,
    "sha256Checksum" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "status" "ArchiveJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "error" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedAt" TIMESTAMP(3),

    CONSTRAINT "ArchiveJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityProvider" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "IdentityProviderType" NOT NULL DEFAULT 'OIDC',
    "issuerUrl" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretEncrypted" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['openid', 'profile', 'email']::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "state" "SessionState" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybackSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cameraIdsJson" JSONB NOT NULL,
    "masterTimeUtc" TIMESTAMP(3) NOT NULL,
    "playbackRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "state" "PlaybackSessionState" NOT NULL DEFAULT 'STOPPED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaybackSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceManifest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startUtc" TIMESTAMP(3) NOT NULL,
    "endUtc" TIMESTAMP(3) NOT NULL,
    "cameraIdsJson" JSONB NOT NULL,
    "masterEvidenceHash" TEXT NOT NULL,
    "evidenceMerkleRoot" TEXT,
    "applianceSignature" TEXT,
    "canonicalManifestJson" JSONB,
    "manifestVersion" INTEGER NOT NULL DEFAULT 1,
    "hashAlgorithm" TEXT NOT NULL DEFAULT 'SHA-256',
    "sourceMetadataJson" JSONB NOT NULL,
    "segmentManifestJson" JSONB NOT NULL,
    "certificateDataJson" JSONB,
    "chainOfCustodyJson" JSONB,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EvidenceManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyPolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "faceRedaction" BOOLEAN NOT NULL DEFAULT false,
    "plateRedaction" BOOLEAN NOT NULL DEFAULT false,
    "bystanderRedaction" BOOLEAN NOT NULL DEFAULT false,
    "restrictedZonesJson" JSONB,
    "defaultExportMode" TEXT NOT NULL DEFAULT 'STREAM_COPY',
    "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedactionJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sourceManifestId" TEXT NOT NULL,
    "privacyPolicyId" TEXT,
    "status" "RedactionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "redactionMode" "RedactionMode" NOT NULL DEFAULT 'FACE',
    "modelVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "maskMetadataJson" JSONB,
    "outputObjectKey" TEXT,
    "outputSha256" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "RedactionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Floorplan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "name" TEXT NOT NULL,
    "imageObjectKey" TEXT NOT NULL,
    "geoAnchorLat" DOUBLE PRECISION,
    "geoAnchorLng" DOUBLE PRECISION,
    "rotationDegrees" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "scalePixelsPerMeter" DOUBLE PRECISION NOT NULL DEFAULT 20.0,
    "coordinateSystem" TEXT NOT NULL DEFAULT 'LOCAL_PIXEL',
    "floorLevel" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Floorplan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CameraSpatialPlacement" (
    "id" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "floorplanId" TEXT NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "mountHeightMeters" DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    "headingDegrees" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "pitchDegrees" DOUBLE PRECISION NOT NULL DEFAULT 30.0,
    "fovHorizontalDegrees" DOUBLE PRECISION NOT NULL DEFAULT 85.0,
    "fovVerticalDegrees" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    "zoom" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CameraSpatialPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainOfCustodyLog" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "timestampUtc" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "resultHash" TEXT,
    "previousEventHash" TEXT,
    "eventHash" TEXT,
    "sequenceNumber" INTEGER NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "ChainOfCustodyLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageVolume" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "deviceIdentifier" TEXT,
    "mountSource" TEXT,
    "filesystemType" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isReadOnly" BOOLEAN NOT NULL DEFAULT false,
    "maxBytes" BIGINT,
    "status" "VolumeStatus" NOT NULL DEFAULT 'HEALTHY',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHealthyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFailureAt" TIMESTAMP(3),
    "healthReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageVolume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageEpoch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "cameraId" TEXT NOT NULL,
    "epochNumber" INTEGER NOT NULL,
    "storageVolumeId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "transitionReason" TEXT,
    "prevEpochHash" TEXT,
    "epochHash" TEXT,
    "metadataJson" JSONB,

    CONSTRAINT "StorageEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplianceState" (
    "id" TEXT NOT NULL DEFAULT 'SINGLETON',
    "isBootstrapped" BOOLEAN NOT NULL DEFAULT false,
    "bootstrappedAt" TIMESTAMP(3),
    "initializationVersion" TEXT DEFAULT '1.0.0',
    "applianceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplianceState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "License_licenseId_key" ON "License"("licenseId");

-- CreateIndex
CREATE INDEX "License_tenantId_idx" ON "License"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Site_tenantId_idx" ON "Site"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Camera_streamPath_key" ON "Camera"("streamPath");

-- CreateIndex
CREATE INDEX "Camera_tenantId_siteId_idx" ON "Camera"("tenantId", "siteId");

-- CreateIndex
CREATE INDEX "Camera_streamPath_idx" ON "Camera"("streamPath");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingSegment_filePath_key" ON "RecordingSegment"("filePath");

-- CreateIndex
CREATE INDEX "RecordingSegment_cameraId_startTime_endTime_idx" ON "RecordingSegment"("cameraId", "startTime", "endTime");

-- CreateIndex
CREATE INDEX "RecordingSegment_status_idx" ON "RecordingSegment"("status");

-- CreateIndex
CREATE INDEX "RecordingSegment_tenantId_cameraId_startTime_idx" ON "RecordingSegment"("tenantId", "cameraId", "startTime");

-- CreateIndex
CREATE INDEX "EvidencePin_segmentId_expiresAt_releasedAt_idx" ON "EvidencePin"("segmentId", "expiresAt", "releasedAt");

-- CreateIndex
CREATE INDEX "EvidencePin_tenantId_expiresAt_idx" ON "EvidencePin"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "SegmentJob_status_createdAt_idx" ON "SegmentJob"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SegmentJob_tenantId_segmentPath_key" ON "SegmentJob"("tenantId", "segmentPath");

-- CreateIndex
CREATE INDEX "EventRule_tenantId_triggerType_idx" ON "EventRule"("tenantId", "triggerType");

-- CreateIndex
CREATE INDEX "Event_cameraId_startTime_idx" ON "Event"("cameraId", "startTime");

-- CreateIndex
CREATE INDEX "Event_type_severity_acknowledged_idx" ON "Event"("type", "severity", "acknowledged");

-- CreateIndex
CREATE INDEX "EvidenceExport_tenantId_cameraId_idx" ON "EvidenceExport"("tenantId", "cameraId");

-- CreateIndex
CREATE INDEX "EvidenceExport_status_idx" ON "EvidenceExport"("status");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_sequenceNumber_idx" ON "AuditEvent"("tenantId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_action_timestampUtc_idx" ON "AuditEvent"("tenantId", "action", "timestampUtc");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_tenantId_sequenceNumber_key" ON "AuditEvent"("tenantId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionPolicy_cameraId_key" ON "RetentionPolicy"("cameraId");

-- CreateIndex
CREATE INDEX "RetentionPolicy_tenantId_idx" ON "RetentionPolicy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecordingSchedule_cameraId_key" ON "RecordingSchedule"("cameraId");

-- CreateIndex
CREATE INDEX "RecordingSchedule_tenantId_cameraId_idx" ON "RecordingSchedule"("tenantId", "cameraId");

-- CreateIndex
CREATE INDEX "DetectionZone_tenantId_cameraId_idx" ON "DetectionZone"("tenantId", "cameraId");

-- CreateIndex
CREATE INDEX "PtzPreset_tenantId_cameraId_idx" ON "PtzPreset"("tenantId", "cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "PtzPreset_cameraId_name_key" ON "PtzPreset"("cameraId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PtzPreset_cameraId_presetToken_key" ON "PtzPreset"("cameraId", "presetToken");

-- CreateIndex
CREATE INDEX "PtzTour_tenantId_cameraId_idx" ON "PtzTour"("tenantId", "cameraId");

-- CreateIndex
CREATE UNIQUE INDEX "PtzLock_cameraId_key" ON "PtzLock"("cameraId");

-- CreateIndex
CREATE INDEX "PtzLock_cameraId_expiresAt_idx" ON "PtzLock"("cameraId", "expiresAt");

-- CreateIndex
CREATE INDEX "Layout_tenantId_userId_idx" ON "Layout"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "StreamProfileBaseline_cameraId_key" ON "StreamProfileBaseline"("cameraId");

-- CreateIndex
CREATE INDEX "StreamDiagnostic_cameraId_checkedAt_idx" ON "StreamDiagnostic"("cameraId", "checkedAt");

-- CreateIndex
CREATE INDEX "StreamDiagnostic_tenantId_isDegraded_idx" ON "StreamDiagnostic"("tenantId", "isDegraded");

-- CreateIndex
CREATE INDEX "Alarm_tenantId_state_severity_idx" ON "Alarm"("tenantId", "state", "severity");

-- CreateIndex
CREATE INDEX "Alarm_cameraId_triggeredAt_idx" ON "Alarm"("cameraId", "triggeredAt");

-- CreateIndex
CREATE INDEX "DetectionEvent_tenantId_type_timestamp_idx" ON "DetectionEvent"("tenantId", "type", "timestamp");

-- CreateIndex
CREATE INDEX "DetectionEvent_cameraId_timestamp_idx" ON "DetectionEvent"("cameraId", "timestamp");

-- CreateIndex
CREATE INDEX "VehicleObservation_tenantId_normalizedPlate_idx" ON "VehicleObservation"("tenantId", "normalizedPlate");

-- CreateIndex
CREATE INDEX "VehicleObservation_cameraId_lastSeenAt_idx" ON "VehicleObservation"("cameraId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "VehicleWatchlist_tenantId_category_active_idx" ON "VehicleWatchlist"("tenantId", "category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "VehicleWatchlist_tenantId_normalizedPlate_key" ON "VehicleWatchlist"("tenantId", "normalizedPlate");

-- CreateIndex
CREATE INDEX "NotificationChannel_tenantId_enabled_idx" ON "NotificationChannel"("tenantId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationJob_idempotencyKey_key" ON "NotificationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "NotificationJob_tenantId_status_nextRetryAt_idx" ON "NotificationJob"("tenantId", "status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "NotificationLog_tenantId_dispatchedAt_idx" ON "NotificationLog"("tenantId", "dispatchedAt");

-- CreateIndex
CREATE INDEX "NotificationLog_channelId_status_idx" ON "NotificationLog"("channelId", "status");

-- CreateIndex
CREATE INDEX "AiRuntimeDiagnostic_tenantId_checkedAt_idx" ON "AiRuntimeDiagnostic"("tenantId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedNode_nodeUuid_key" ON "FederatedNode"("nodeUuid");

-- CreateIndex
CREATE INDEX "FederatedNode_tenantId_state_idx" ON "FederatedNode"("tenantId", "state");

-- CreateIndex
CREATE INDEX "ConfigSyncRecord_nodeId_status_idx" ON "ConfigSyncRecord"("nodeId", "status");

-- CreateIndex
CREATE INDEX "AutomationRule_tenantId_enabled_triggerType_idx" ON "AutomationRule"("tenantId", "enabled", "triggerType");

-- CreateIndex
CREATE INDEX "RuleExecutionRecord_tenantId_startedAt_idx" ON "RuleExecutionRecord"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "RuleExecutionRecord_ruleId_overallStatus_idx" ON "RuleExecutionRecord"("ruleId", "overallStatus");

-- CreateIndex
CREATE INDEX "RuleExecutionRecord_correlationId_idx" ON "RuleExecutionRecord"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleExecutionRecord_ruleId_triggerEventId_key" ON "RuleExecutionRecord"("ruleId", "triggerEventId");

-- CreateIndex
CREATE INDEX "ActionExecutionRecord_ruleExecutionId_status_idx" ON "ActionExecutionRecord"("ruleExecutionId", "status");

-- CreateIndex
CREATE INDEX "ActionExecutionRecord_status_startedAt_idx" ON "ActionExecutionRecord"("status", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActionExecutionRecord_ruleExecutionId_actionId_key" ON "ActionExecutionRecord"("ruleExecutionId", "actionId");

-- CreateIndex
CREATE INDEX "SpatialAnalyticsRule_cameraId_type_enabled_idx" ON "SpatialAnalyticsRule"("cameraId", "type", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "DigitalIoPin_tenantId_pinNumber_key" ON "DigitalIoPin"("tenantId", "pinNumber");

-- CreateIndex
CREATE INDEX "RelayCommandLog_pinId_lifecycleState_idx" ON "RelayCommandLog"("pinId", "lifecycleState");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectStorageConfig_tenantId_key" ON "ObjectStorageConfig"("tenantId");

-- CreateIndex
CREATE INDEX "ArchiveJob_tenantId_status_priority_idx" ON "ArchiveJob"("tenantId", "status", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ArchiveJob_tenantId_segmentPath_key" ON "ArchiveJob"("tenantId", "segmentPath");

-- CreateIndex
CREATE INDEX "IdentityProvider_tenantId_idx" ON "IdentityProvider"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityProvider_tenantId_name_key" ON "IdentityProvider"("tenantId", "name");

-- CreateIndex
CREATE INDEX "UserSession_tenantId_userId_state_idx" ON "UserSession"("tenantId", "userId", "state");

-- CreateIndex
CREATE INDEX "PlaybackSession_tenantId_userId_idx" ON "PlaybackSession"("tenantId", "userId");

-- CreateIndex
CREATE INDEX "EvidenceManifest_tenantId_createdAt_idx" ON "EvidenceManifest"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PrivacyPolicy_tenantId_idx" ON "PrivacyPolicy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacyPolicy_tenantId_name_key" ON "PrivacyPolicy"("tenantId", "name");

-- CreateIndex
CREATE INDEX "RedactionJob_tenantId_status_idx" ON "RedactionJob"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Floorplan_tenantId_siteId_idx" ON "Floorplan"("tenantId", "siteId");

-- CreateIndex
CREATE UNIQUE INDEX "CameraSpatialPlacement_cameraId_key" ON "CameraSpatialPlacement"("cameraId");

-- CreateIndex
CREATE INDEX "CameraSpatialPlacement_floorplanId_idx" ON "CameraSpatialPlacement"("floorplanId");

-- CreateIndex
CREATE INDEX "ChainOfCustodyLog_tenantId_evidenceId_idx" ON "ChainOfCustodyLog"("tenantId", "evidenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChainOfCustodyLog_tenantId_evidenceId_sequenceNumber_key" ON "ChainOfCustodyLog"("tenantId", "evidenceId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StorageVolume_path_key" ON "StorageVolume"("path");

-- CreateIndex
CREATE INDEX "StorageVolume_tenantId_status_idx" ON "StorageVolume"("tenantId", "status");

-- CreateIndex
CREATE INDEX "StorageEpoch_tenantId_cameraId_epochNumber_idx" ON "StorageEpoch"("tenantId", "cameraId", "epochNumber");

-- CreateIndex
CREATE UNIQUE INDEX "StorageEpoch_cameraId_epochNumber_key" ON "StorageEpoch"("cameraId", "epochNumber");

-- AddForeignKey
ALTER TABLE "License" ADD CONSTRAINT "License_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Camera" ADD CONSTRAINT "Camera_storageVolumeId_fkey" FOREIGN KEY ("storageVolumeId") REFERENCES "StorageVolume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_storageVolumeId_fkey" FOREIGN KEY ("storageVolumeId") REFERENCES "StorageVolume"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSegment" ADD CONSTRAINT "RecordingSegment_storageEpochId_fkey" FOREIGN KEY ("storageEpochId") REFERENCES "StorageEpoch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidencePin" ADD CONSTRAINT "EvidencePin_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "RecordingSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRule" ADD CONSTRAINT "EventRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EventRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceExport" ADD CONSTRAINT "EvidenceExport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceExport" ADD CONSTRAINT "EvidenceExport_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceExport" ADD CONSTRAINT "EvidenceExport_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceExport" ADD CONSTRAINT "EvidenceExport_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "EvidenceManifest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceExport" ADD CONSTRAINT "EvidenceExport_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetentionPolicy" ADD CONSTRAINT "RetentionPolicy_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordingSchedule" ADD CONSTRAINT "RecordingSchedule_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectionZone" ADD CONSTRAINT "DetectionZone_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtzPreset" ADD CONSTRAINT "PtzPreset_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtzTour" ADD CONSTRAINT "PtzTour_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PtzLock" ADD CONSTRAINT "PtzLock_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layout" ADD CONSTRAINT "Layout_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Layout" ADD CONSTRAINT "Layout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamProfileBaseline" ADD CONSTRAINT "StreamProfileBaseline_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreamDiagnostic" ADD CONSTRAINT "StreamDiagnostic_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "EventRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectionEvent" ADD CONSTRAINT "DetectionEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetectionEvent" ADD CONSTRAINT "DetectionEvent_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleObservation" ADD CONSTRAINT "VehicleObservation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleObservation" ADD CONSTRAINT "VehicleObservation_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleObservation" ADD CONSTRAINT "VehicleObservation_matchedWatchlistId_fkey" FOREIGN KEY ("matchedWatchlistId") REFERENCES "VehicleWatchlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleWatchlist" ADD CONSTRAINT "VehicleWatchlist_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationJob" ADD CONSTRAINT "NotificationJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationJob" ADD CONSTRAINT "NotificationJob_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationJob" ADD CONSTRAINT "NotificationJob_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "NotificationChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_alarmId_fkey" FOREIGN KEY ("alarmId") REFERENCES "Alarm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiRuntimeDiagnostic" ADD CONSTRAINT "AiRuntimeDiagnostic_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FederatedNode" ADD CONSTRAINT "FederatedNode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigSyncRecord" ADD CONSTRAINT "ConfigSyncRecord_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "FederatedNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleExecutionRecord" ADD CONSTRAINT "RuleExecutionRecord_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecutionRecord" ADD CONSTRAINT "ActionExecutionRecord_ruleExecutionId_fkey" FOREIGN KEY ("ruleExecutionId") REFERENCES "RuleExecutionRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpatialAnalyticsRule" ADD CONSTRAINT "SpatialAnalyticsRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpatialAnalyticsRule" ADD CONSTRAINT "SpatialAnalyticsRule_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigitalIoPin" ADD CONSTRAINT "DigitalIoPin_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayCommandLog" ADD CONSTRAINT "RelayCommandLog_pinId_fkey" FOREIGN KEY ("pinId") REFERENCES "DigitalIoPin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectStorageConfig" ADD CONSTRAINT "ObjectStorageConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveJob" ADD CONSTRAINT "ArchiveJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdentityProvider" ADD CONSTRAINT "IdentityProvider_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybackSession" ADD CONSTRAINT "PlaybackSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybackSession" ADD CONSTRAINT "PlaybackSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceManifest" ADD CONSTRAINT "EvidenceManifest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceManifest" ADD CONSTRAINT "EvidenceManifest_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyPolicy" ADD CONSTRAINT "PrivacyPolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_sourceManifestId_fkey" FOREIGN KEY ("sourceManifestId") REFERENCES "EvidenceManifest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_privacyPolicyId_fkey" FOREIGN KEY ("privacyPolicyId") REFERENCES "PrivacyPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedactionJob" ADD CONSTRAINT "RedactionJob_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floorplan" ADD CONSTRAINT "Floorplan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floorplan" ADD CONSTRAINT "Floorplan_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraSpatialPlacement" ADD CONSTRAINT "CameraSpatialPlacement_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CameraSpatialPlacement" ADD CONSTRAINT "CameraSpatialPlacement_floorplanId_fkey" FOREIGN KEY ("floorplanId") REFERENCES "Floorplan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChainOfCustodyLog" ADD CONSTRAINT "ChainOfCustodyLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageVolume" ADD CONSTRAINT "StorageVolume_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEpoch" ADD CONSTRAINT "StorageEpoch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEpoch" ADD CONSTRAINT "StorageEpoch_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageEpoch" ADD CONSTRAINT "StorageEpoch_storageVolumeId_fkey" FOREIGN KEY ("storageVolumeId") REFERENCES "StorageVolume"("id") ON DELETE CASCADE ON UPDATE CASCADE;

