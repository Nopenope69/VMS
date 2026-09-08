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
  | 'SYSTEM_ALERT';

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

export type VigilOneEventPayload =
  | MotionEventPayload
  | TripwireEventPayload
  | LoiteringEventPayload
  | AnprEventPayload
  | CameraOfflinePayload
  | StreamDegradedPayload
  | DigitalIoPayload
  | SceneChangePayload
  | SystemAlertPayload;

export type EventSource =
  | 'VISION_AI'
  | 'ANPR'
  | 'SPATIAL_ANALYTICS'
  | 'WATCHDOG'
  | 'HARDWARE_IO'
  | 'ALARM'
  | 'MANUAL'
  | 'SYSTEM';

export interface VigilOneEvent<T extends VigilOneEventPayload = VigilOneEventPayload> {
  id: string;                      // Canonical deduplication ID
  tenantId: string;
  cameraId?: string;
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
}

export interface AlarmFilter {
  state?: AlarmState;
  severity?: EventSeverity;
  cameraId?: string;
  limit?: number;
  offset?: number;
}

export { RelayConfirmationMode };
