import { EventSeverity, AlarmState, RuleActionType, RelayConfirmationMode } from '@prisma/client';

export type VigilOneEventType =
  | 'MOTION'
  | 'TRIPWIRE_CROSS'
  | 'LOITERING_DWELL'
  | 'ANPR_MATCH'
  | 'CAMERA_OFFLINE'
  | 'STREAM_DEGRADED'
  | 'DI_TRIGGER'
  | 'SCENE_CHANGE'
  | 'SYSTEM_ALERT'
  | 'AI_OBJECT_DETECTED';

export interface SpatialRef {
  zoneId?: string;
  floorplanId?: string;
  x?: number;
  y?: number;
  normalized?: boolean;
}

export interface EvidenceRef {
  segmentId?: string;
  manifestId?: string;
  snapshotPath?: string;
}

export interface MotionEventPayload {
  kind: 'MOTION';
  score: number;
  bbox?: [number, number, number, number];
  label?: string;
}

export interface TripwireEventPayload {
  kind: 'TRIPWIRE_CROSS';
  tripwireId: string;
  zoneId?: string;
  trackId: string;
  direction: 'FORWARD' | 'BACKWARD' | 'BIDIRECTIONAL';
  velocity?: number;
}

export interface LoiteringEventPayload {
  kind: 'LOITERING_DWELL';
  zoneId: string;
  trackId: string;
  dwellTimeSeconds: number;
  thresholdSeconds: number;
}

export interface AnprEventPayload {
  kind: 'ANPR_MATCH';
  plateText: string;
  confidence: number;
  watchlistCategory?: string;
  matchedWatchlistId?: string;
  vehicleColor?: string;
}

export interface CameraOfflinePayload {
  kind: 'CAMERA_OFFLINE';
  cameraId: string;
  lastSeenUtc: Date | string;
  reason?: string;
}

export interface StreamDegradedPayload {
  kind: 'STREAM_DEGRADED';
  cameraId: string;
  fps: number;
  expectedFps: number;
  packetLossPercent?: number;
}

export interface DigitalIoPayload {
  kind: 'DI_TRIGGER';
  pinNumber: number;
  state: 'HIGH' | 'LOW';
  previousState?: 'HIGH' | 'LOW';
  voltage?: number;
}

export interface SceneChangePayload {
  kind: 'SCENE_CHANGE';
  score: number;
  threshold: number;
  changeType: 'OCCLUSION' | 'DEFOCUS' | 'DISPLACEMENT';
}

export interface SystemAlertPayload {
  kind: 'SYSTEM_ALERT';
  subsystem: string;
  alertCode: string;
  message: string;
  details?: Record<string, any>;
}

/**
 * A tracked object of a v1 class (person, bicycle, motorcycle, car, bus, truck) reported by the
 * AI worker. Emitted once per track when it is first confirmed (stage 'confirmed'), and once per
 * minimum-dwell milestone used by an enabled rule (stage 'dwell', stageSeconds = the milestone).
 */
export interface AiObjectDetectedPayload {
  kind: 'AI_OBJECT_DETECTED';
  objectClass: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  trackId: string;
  dwellSeconds: number;
  stage: 'confirmed' | 'dwell';
  stageSeconds: number;
}

/** Per-inference provenance (events.v1 AiProvenanceV1). Mandatory on AI-derived events. */
export interface AiProvenance {
  adapterId: string;
  adapterVersion: string;
  modelId: string;
  modelName: string;
  modelVersion: string;
  modelSha256: string;
  runtime: string;
  executionProvider?: string;
  inferenceId: string;
  frameTimestampUtc: string;
}

export type VigilOneEventPayload =
  | MotionEventPayload
  | TripwireEventPayload
  | LoiteringEventPayload
  | AnprEventPayload
  | CameraOfflinePayload
  | StreamDegradedPayload
  | DigitalIoPayload
  | SceneChangePayload
  | SystemAlertPayload
  | AiObjectDetectedPayload;

export type EventSource =
  | 'VISION_AI'
  | 'ANPR'
  | 'SPATIAL_ANALYTICS'
  | 'WATCHDOG'
  | 'HARDWARE_IO'
  | 'ALARM'
  | 'MANUAL'
  | 'SYSTEM'
  | 'MOTION_DETECTOR';

export interface VigilOneEvent<T extends VigilOneEventPayload = VigilOneEventPayload> {
  id: string;                      // Canonical deduplication ID
  tenantId: string;
  cameraId?: string;
  siteId?: string;
  dedupKey?: string;
  source: EventSource;
  type: VigilOneEventType;
  timestampUtc: Date;
  severity: EventSeverity;         // INFO | WARNING | CRITICAL
  correlationId: string;           // Tracks end-to-end incident trees
  rootEventId?: string;            // Origin event that initiated the cascade
  depth?: number;                  // Cascade recursion depth (default 0)
  trackId?: string;
  evidenceRef?: EvidenceRef;
  spatialRef?: SpatialRef;
  title?: string;
  description?: string;
  payload: T;
  /** Provenance of the inference behind an AI-derived event; never invented. */
  provenance?: AiProvenance;
}

export interface CommandContext {
  tenantId: string;
  actorUserId?: string;
  correlationId?: string;
  permissions?: string[];
  clientIp?: string;
  userAgent?: string;
}

export interface RuleTriggerConfig {
  cameraId?: string;
  zoneId?: string;
  pinNumber?: number;
  targetState?: string;
  watchlistCategories?: string[];
  minConfidence?: number;
  /** AI_OBJECT_DETECTED: only these v1 classes (empty/absent = any). */
  objectClasses?: string[];
  /** AI_OBJECT_DETECTED: fire only once the object has been tracked this long (P3.7). */
  minDwellSeconds?: number;
  /** TRIPWIRE_CROSS / LOITERING_DWELL: only this spatial rule. */
  spatialRuleId?: string;
}

export interface RuleCondition {
  type: 'TIME_SCHEDULE' | 'CAMERA_TAG' | 'SEVERITY_THRESHOLD';
  operator: 'EQUALS' | 'IN' | 'BETWEEN';
  value: any;
}

export interface RuleActionConfig {
  id: string;
  type: RuleActionType;
  config: Record<string, any>;
  timeoutMs?: number;
  retryPolicy?: { maxRetries: number; backoffMs: number };
  continueOnFailure?: boolean;
}

export interface IngestResult {
  eventId: string;
  correlationId: string;
  rulesEvaluated: number;
  rulesTriggered: number;
  actionsQueued: number;
  ruleExecutionIds: string[];
  cascadeTerminated?: boolean;
  alarmCreated?: boolean;
  alarmId?: string;
  /** The event id had already been processed; nothing was evaluated again. */
  duplicate?: boolean;
}

export interface AlarmFilter {
  state?: AlarmState;
  severity?: EventSeverity;
  cameraId?: string;
  limit?: number;
  offset?: number;
}

export { RelayConfirmationMode };
