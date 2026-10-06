import crypto from 'crypto';
import { EventSeverity } from '@prisma/client';
import {
  VigilOneEvent,
  VigilOneEventType,
  VigilOneEventPayload,
  MotionEventPayload,
  TripwireEventPayload,
  LoiteringEventPayload,
  UnattendedObjectPayload,
  WrongWayPayload,
  PersonDownPayload,
  FenceClimbPayload,
  AnprEventPayload,
  CameraOfflinePayload,
  StreamDegradedPayload,
  DigitalIoPayload,
  SceneChangePayload,
  SystemAlertPayload,
  SpatialRef,
  EvidenceRef,
  EventSource,
  AiProvenance,
  AiObjectDetectedPayload,
} from './types';

export interface BaseEventParams {
  id?: string;
  tenantId: string;
  cameraId?: string;
  source?: EventSource;
  severity?: EventSeverity;
  correlationId?: string;
  rootEventId?: string;
  depth?: number;
  trackId?: string;
  evidenceRef?: EvidenceRef;
  spatialRef?: SpatialRef;
  title?: string;
  description?: string;
  provenance?: AiProvenance;
}

export function createVigilOneEvent<T extends VigilOneEventPayload>(
  params: BaseEventParams & { type: VigilOneEventType; payload: T }
): VigilOneEvent<T> {
  const id = params.id || `ev_${crypto.randomUUID()}`;
  const correlationId = params.correlationId || `corr_${crypto.randomUUID()}`;
  const rootEventId = params.rootEventId || id;
  const depth = params.depth ?? 0;

  return {
    id,
    tenantId: params.tenantId,
    provenance: params.provenance,
    cameraId: params.cameraId,
    source: params.source || 'SYSTEM',
    type: params.type,
    timestampUtc: new Date(),
    severity: params.severity || EventSeverity.INFO,
    correlationId,
    rootEventId,
    depth,
    trackId: params.trackId,
    evidenceRef: params.evidenceRef,
    spatialRef: params.spatialRef,
    title: params.title,
    description: params.description,
    payload: params.payload,
  };
}

export function deriveChildEvent<T extends VigilOneEventPayload>(
  parentEvent: VigilOneEvent,
  params: {
    id?: string;
    source: EventSource;
    type: VigilOneEventType;
    severity?: EventSeverity;
    cameraId?: string;
    trackId?: string;
    evidenceRef?: EvidenceRef;
    spatialRef?: SpatialRef;
    title?: string;
    description?: string;
    payload: T;
  }
): VigilOneEvent<T> {
  const nextDepth = (parentEvent.depth ?? 0) + 1;
  const rootEventId = parentEvent.rootEventId || parentEvent.id;

  return createVigilOneEvent<T>({
    id: params.id,
    tenantId: parentEvent.tenantId,
    cameraId: params.cameraId || parentEvent.cameraId,
    source: params.source,
    type: params.type,
    severity: params.severity || parentEvent.severity,
    correlationId: parentEvent.correlationId,
    rootEventId,
    depth: nextDepth,
    trackId: params.trackId || parentEvent.trackId,
    evidenceRef: params.evidenceRef || parentEvent.evidenceRef,
    spatialRef: params.spatialRef || parentEvent.spatialRef,
    title: params.title,
    description: params.description,
    payload: params.payload,
  });
}

export function fromMotionEvent(
  params: BaseEventParams & {
    score: number;
    bbox?: [number, number, number, number];
    label?: string;
  }
): VigilOneEvent<MotionEventPayload> {
  return createVigilOneEvent<MotionEventPayload>({
    ...params,
    // Today's motion producer is the classical ffmpeg scene detector, not an AI model.
    source: params.source || 'MOTION_DETECTOR',
    type: 'MOTION',
    title: params.title || `Motion Detected (${Math.round(params.score * 100)}%)`,
    payload: {
      kind: 'MOTION',
      score: params.score,
      bbox: params.bbox,
      label: params.label,
    },
  });
}

export function fromTripwireCrossing(
  params: BaseEventParams & {
    tripwireId: string;
    zoneId?: string;
    trackId: string;
    direction: 'FORWARD' | 'BACKWARD' | 'BIDIRECTIONAL';
    velocity?: number;
  }
): VigilOneEvent<TripwireEventPayload> {
  return createVigilOneEvent<TripwireEventPayload>({
    ...params,
    source: params.source || 'SPATIAL_ANALYTICS',
    type: 'TRIPWIRE_CROSS',
    severity: params.severity || EventSeverity.WARNING,
    title: params.title || `Tripwire Crossing: ${params.tripwireId}`,
    payload: {
      kind: 'TRIPWIRE_CROSS',
      tripwireId: params.tripwireId,
      zoneId: params.zoneId,
      trackId: params.trackId,
      direction: params.direction,
      velocity: params.velocity,
    },
  });
}

export function fromLoiteringResult(
  params: BaseEventParams & {
    zoneId: string;
    trackId: string;
    dwellTimeSeconds: number;
    thresholdSeconds: number;
  }
): VigilOneEvent<LoiteringEventPayload> {
  return createVigilOneEvent<LoiteringEventPayload>({
    ...params,
    source: params.source || 'SPATIAL_ANALYTICS',
    type: 'LOITERING_DWELL',
    severity: params.severity || EventSeverity.WARNING,
    title: params.title || `Loitering In Zone ${params.zoneId} (${params.dwellTimeSeconds}s)`,
    payload: {
      kind: 'LOITERING_DWELL',
      zoneId: params.zoneId,
      trackId: params.trackId,
      dwellTimeSeconds: params.dwellTimeSeconds,
      thresholdSeconds: params.thresholdSeconds,
    },
  });
}

export function fromUnattendedObject(
  params: BaseEventParams & { zoneId: string; trackId: string; objectClass: string; unattendedSeconds: number; thresholdSeconds: number }
): VigilOneEvent<UnattendedObjectPayload> {
  return createVigilOneEvent<UnattendedObjectPayload>({
    ...params,
    source: params.source || 'SPATIAL_ANALYTICS',
    type: 'UNATTENDED_OBJECT',
    severity: params.severity || EventSeverity.CRITICAL,
    title: params.title || `Unattended ${params.objectClass} (${params.unattendedSeconds}s)`,
    payload: {
      kind: 'UNATTENDED_OBJECT',
      zoneId: params.zoneId,
      trackId: params.trackId,
      objectClass: params.objectClass,
      unattendedSeconds: params.unattendedSeconds,
      thresholdSeconds: params.thresholdSeconds,
    },
  });
}

export function fromWrongWay(
  params: BaseEventParams & { zoneId: string; trackId: string; objectClass?: string; angleDegrees: number; travel: number }
): VigilOneEvent<WrongWayPayload> {
  return createVigilOneEvent<WrongWayPayload>({
    ...params,
    source: params.source || 'SPATIAL_ANALYTICS',
    type: 'WRONG_WAY',
    severity: params.severity || EventSeverity.WARNING,
    title: params.title || `Wrong way in zone ${params.zoneId}`,
    payload: {
      kind: 'WRONG_WAY',
      zoneId: params.zoneId,
      trackId: params.trackId,
      objectClass: params.objectClass,
      angleDegrees: params.angleDegrees,
      travel: params.travel,
    },
  });
}

export function fromPersonDown(
  params: BaseEventParams & { zoneId: string; trackId: string; downKind: 'FALL' | 'LYING_STILL'; lyingSeconds: number; thresholdSeconds: number; basis: 'pose' | 'box' }
): VigilOneEvent<PersonDownPayload> {
  return createVigilOneEvent<PersonDownPayload>({
    ...params,
    source: params.source || 'SPATIAL_ANALYTICS',
    type: 'PERSON_DOWN',
    // A seen fall is the stronger signal; someone found lying is weaker.
    severity: params.severity || (params.downKind === 'FALL' ? EventSeverity.CRITICAL : EventSeverity.WARNING),
    title: params.title || (params.downKind === 'FALL' ? `Person down in zone ${params.zoneId}` : `Person lying still in zone ${params.zoneId}`),
    payload: {
      kind: 'PERSON_DOWN',
      zoneId: params.zoneId,
      trackId: params.trackId,
      downKind: params.downKind,
      lyingSeconds: params.lyingSeconds,
      thresholdSeconds: params.thresholdSeconds,
      basis: params.basis,
    },
  });
}

export function fromFenceClimb(
  params: BaseEventParams & { zoneId: string; trackId: string; stage: 'CLIMBING' | 'CROSSED'; climbSeconds: number }
): VigilOneEvent<FenceClimbPayload> {
  return createVigilOneEvent<FenceClimbPayload>({
    ...params,
    source: params.source || 'SPATIAL_ANALYTICS',
    type: 'FENCE_CLIMB',
    severity: params.severity || (params.stage === 'CROSSED' ? EventSeverity.CRITICAL : EventSeverity.WARNING),
    title: params.title || (params.stage === 'CROSSED' ? `Fence crossed in zone ${params.zoneId}` : `Fence climbing in zone ${params.zoneId}`),
    payload: {
      kind: 'FENCE_CLIMB',
      zoneId: params.zoneId,
      trackId: params.trackId,
      stage: params.stage,
      climbSeconds: params.climbSeconds,
    },
  });
}

export function fromAnprObservation(
  params: BaseEventParams & {
    plateText: string;
    confidence: number;
    watchlistCategory?: string;
    matchedWatchlistId?: string;
    vehicleColor?: string;
  }
): VigilOneEvent<AnprEventPayload> {
  const isMatch = Boolean(params.watchlistCategory);
  return createVigilOneEvent<AnprEventPayload>({
    ...params,
    source: params.source || 'ANPR',
    type: 'ANPR_MATCH',
    severity: isMatch ? EventSeverity.WARNING : EventSeverity.INFO,
    title: isMatch ? `Watchlist Vehicle Match: ${params.plateText}` : `Plate Read: ${params.plateText}`,
    payload: {
      kind: 'ANPR_MATCH',
      plateText: params.plateText,
      confidence: params.confidence,
      watchlistCategory: params.watchlistCategory,
      matchedWatchlistId: params.matchedWatchlistId,
      vehicleColor: params.vehicleColor,
    },
  });
}

export function fromCameraOffline(
  params: BaseEventParams & {
    cameraId: string;
    lastSeenUtc: Date | string;
    reason?: string;
  }
): VigilOneEvent<CameraOfflinePayload> {
  return createVigilOneEvent<CameraOfflinePayload>({
    ...params,
    source: params.source || 'WATCHDOG',
    type: 'CAMERA_OFFLINE',
    severity: params.severity || EventSeverity.CRITICAL,
    title: params.title || `Camera Offline: ${params.cameraId}`,
    payload: {
      kind: 'CAMERA_OFFLINE',
      cameraId: params.cameraId,
      lastSeenUtc: params.lastSeenUtc,
      reason: params.reason,
    },
  });
}

export function fromStreamDegraded(
  params: BaseEventParams & {
    cameraId: string;
    fps: number;
    expectedFps: number;
    packetLossPercent?: number;
  }
): VigilOneEvent<StreamDegradedPayload> {
  return createVigilOneEvent<StreamDegradedPayload>({
    ...params,
    source: params.source || 'WATCHDOG',
    type: 'STREAM_DEGRADED',
    severity: params.severity || EventSeverity.WARNING,
    title: params.title || `Stream Degraded: ${params.cameraId} (${params.fps} FPS)`,
    payload: {
      kind: 'STREAM_DEGRADED',
      cameraId: params.cameraId,
      fps: params.fps,
      expectedFps: params.expectedFps,
      packetLossPercent: params.packetLossPercent,
    },
  });
}

export function fromDigitalInput(
  params: BaseEventParams & {
    pinNumber: number;
    state: 'HIGH' | 'LOW';
    previousState?: 'HIGH' | 'LOW';
    voltage?: number;
  }
): VigilOneEvent<DigitalIoPayload> {
  return createVigilOneEvent<DigitalIoPayload>({
    ...params,
    source: params.source || 'HARDWARE_IO',
    type: 'DI_TRIGGER',
    severity: params.severity || EventSeverity.INFO,
    title: params.title || `Digital Input Pin ${params.pinNumber} State Changed to ${params.state}`,
    payload: {
      kind: 'DI_TRIGGER',
      pinNumber: params.pinNumber,
      state: params.state,
      previousState: params.previousState,
      voltage: params.voltage,
    },
  });
}

export function fromSceneChange(
  params: BaseEventParams & {
    score: number;
    threshold: number;
    changeType: 'OCCLUSION' | 'DEFOCUS' | 'DISPLACEMENT';
  }
): VigilOneEvent<SceneChangePayload> {
  return createVigilOneEvent<SceneChangePayload>({
    ...params,
    source: params.source || 'VISION_AI',
    type: 'SCENE_CHANGE',
    severity: params.severity || EventSeverity.WARNING,
    title: params.title || `Scene Tampering / Change (${params.changeType})`,
    payload: {
      kind: 'SCENE_CHANGE',
      score: params.score,
      threshold: params.threshold,
      changeType: params.changeType,
    },
  });
}

export function fromSystemAlert(
  params: BaseEventParams & {
    subsystem: string;
    alertCode: string;
    message: string;
    details?: Record<string, any>;
  }
): VigilOneEvent<SystemAlertPayload> {
  return createVigilOneEvent<SystemAlertPayload>({
    ...params,
    source: params.source || 'SYSTEM',
    type: 'SYSTEM_ALERT',
    severity: params.severity || EventSeverity.CRITICAL,
    title: params.title || `System Alert: ${params.subsystem} [${params.alertCode}]`,
    payload: {
      kind: 'SYSTEM_ALERT',
      subsystem: params.subsystem,
      alertCode: params.alertCode,
      message: params.message,
      details: params.details,
    },
  });
}

/**
 * A confirmed track of a v1 class, from the AI worker. Deterministic id per camera, track and
 * stage, so re-submitted detections never produce a second event for the same milestone.
 */
export function fromAiObjectDetection(params: {
  tenantId: string;
  cameraId: string;
  objectClass: string;
  confidence: number;
  bbox: { x: number; y: number; width: number; height: number };
  trackId: string;
  dwellSeconds: number;
  stage: 'confirmed' | 'dwell';
  stageSeconds: number;
  timestampUtc: Date;
  provenance: AiProvenance;
}): VigilOneEvent<AiObjectDetectedPayload> {
  const id =
    params.stage === 'confirmed'
      ? `ev_aiobj_${params.cameraId}_${params.trackId}_confirmed`
      : `ev_aiobj_${params.cameraId}_${params.trackId}_dwell${params.stageSeconds}`;
  const ev = createVigilOneEvent<AiObjectDetectedPayload>({
    id,
    tenantId: params.tenantId,
    cameraId: params.cameraId,
    source: 'VISION_AI',
    type: 'AI_OBJECT_DETECTED',
    severity: EventSeverity.INFO,
    trackId: params.trackId,
    provenance: params.provenance,
    title: `${params.objectClass} detected`,
    payload: {
      kind: 'AI_OBJECT_DETECTED',
      objectClass: params.objectClass,
      confidence: params.confidence,
      bbox: params.bbox,
      trackId: params.trackId,
      dwellSeconds: params.dwellSeconds,
      stage: params.stage,
      stageSeconds: params.stageSeconds,
    },
  });
  ev.timestampUtc = params.timestampUtc;
  return ev;
}
