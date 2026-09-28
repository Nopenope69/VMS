/**
 * Maps the internal VigilOneEvent union (incident orchestrator) onto events.v1.
 * Table and rationale: docs/contracts/events.v1.md#mapping-from-vigiloneevent.
 *
 * AI-derived events (tripwire, loitering, ANPR, AI objects) need the provenance of the inference
 * that produced them: from the event itself (Phase 2: events from the AI worker carry it) or from
 * the caller. Without it the mapping fails with AI_PROVENANCE_REQUIRED; it never invents a model.
 */
import { VigilOneEvent, EventSource } from '../services/incident/orchestrator/types';
import { AiProvenanceV1, EventEnvelopeV1, EVENTS_CONTRACT_VERSION } from './events.v1';
import { DETECTION_CLASS_TO_EVENT_V1 } from './aiAdapter.v1';

export class EventMappingError extends Error {
  constructor(public readonly code: 'AI_PROVENANCE_REQUIRED' | 'UNMAPPABLE_EVENT' | 'INVALID_ENVELOPE', message: string) {
    super(`${code}: ${message}`);
  }
}

export const VIGILONE_EVENT_TO_V1: Record<VigilOneEvent['type'], string> = {
  MOTION: 'motion.detected',
  TRIPWIRE_CROSS: 'ai.line_crossing',
  LOITERING_DWELL: 'ai.loitering',
  ANPR_MATCH: 'ai.plate_detected',
  CAMERA_OFFLINE: 'camera.offline',
  STREAM_DEGRADED: 'camera.degraded',
  DI_TRIGGER: 'system.digital_input',
  SCENE_CHANGE: 'camera.degraded',
  SYSTEM_ALERT: 'system.alert',
  // Resolved per object class in toEventV1 (ai.person_detected / ai.vehicle_detected).
  AI_OBJECT_DETECTED: 'ai.object_detected',
  // Analytics computed by the camera: VigilOne has no provenance for them, so never ai.*.
  CAMERA_ANALYTIC: 'system.camera_analytic',
};

const SOURCE_KIND: Record<EventSource, EventEnvelopeV1['source']['kind']> = {
  VISION_AI: 'ai',
  ANPR: 'ai',
  SPATIAL_ANALYTICS: 'analytics',
  WATCHDOG: 'system',
  HARDWARE_IO: 'io',
  ALARM: 'alarm_panel',
  MANUAL: 'operator',
  SYSTEM: 'system',
  MOTION_DETECTOR: 'motion',
  CAMERA_ANALYTICS: 'camera',
};

export interface MappingContext {
  /** Provenance of the inference behind an AI-derived event. Required for ai.* targets. */
  provenance?: AiProvenanceV1;
  siteId?: string | null;
  sourceId?: string;
}

const toIso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

function mapPayload(ev: VigilOneEvent): Record<string, unknown> {
  const p: any = ev.payload;
  switch (p.kind) {
    case 'MOTION': {
      const out: Record<string, unknown> = { score: p.score, method: 'SCENE_DIFF' };
      // The internal bbox tuple has no declared coordinate space; only carry it when normalized.
      if (Array.isArray(p.bbox) && p.bbox.every((n: number) => n >= 0 && n <= 1)) {
        const [x, y, width, height] = p.bbox;
        if (width > 0 && height > 0) out.bbox = { x, y, width, height };
      }
      if (ev.spatialRef?.zoneId) out.zoneId = ev.spatialRef.zoneId;
      return out;
    }
    case 'TRIPWIRE_CROSS':
      return {
        ruleId: p.tripwireId,
        trackId: p.trackId,
        direction: p.direction === 'FORWARD' ? 'A_TO_B' : p.direction === 'BACKWARD' ? 'B_TO_A' : 'UNSPECIFIED',
      };
    case 'LOITERING_DWELL':
      return {
        zoneId: p.zoneId,
        trackId: p.trackId,
        dwellSeconds: p.dwellTimeSeconds,
        thresholdSeconds: p.thresholdSeconds,
      };
    case 'ANPR_MATCH': {
      const out: Record<string, unknown> = { plateText: p.plateText, confidence: p.confidence };
      if (p.matchedWatchlistId) out.watchlistMatchId = p.matchedWatchlistId;
      if (p.watchlistCategory) out.watchlistCategory = p.watchlistCategory;
      if (p.vehicleColor) out.vehicleColor = p.vehicleColor;
      return out;
    }
    case 'CAMERA_OFFLINE': {
      const out: Record<string, unknown> = { lastSeenUtc: toIso(p.lastSeenUtc) };
      if (p.reason) out.reason = p.reason;
      return out;
    }
    case 'STREAM_DEGRADED': {
      const out: Record<string, unknown> = { reason: 'STREAM_DEGRADED', fps: p.fps, expectedFps: p.expectedFps };
      if (p.packetLossPercent !== undefined) out.packetLossPercent = p.packetLossPercent;
      return out;
    }
    case 'SCENE_CHANGE':
      return { reason: `TAMPER_${p.changeType}` };
    case 'DI_TRIGGER':
      return {
        code: `DI_${p.state}`,
        message: `Digital input ${p.pinNumber} changed to ${p.state}`,
        subsystem: 'io',
        details: { pinNumber: p.pinNumber, state: p.state, previousState: p.previousState ?? null },
      };
    case 'AI_OBJECT_DETECTED':
      return { objectClass: p.objectClass, confidence: p.confidence, bbox: p.bbox, trackId: p.trackId };
    case 'CAMERA_ANALYTIC': {
      const details: Record<string, unknown> = { protocol: p.protocol, analyticType: p.analyticType, state: p.state, vendorTopic: p.vendorTopic };
      if (p.ruleName) details.ruleName = p.ruleName;
      if (p.objectType) details.objectType = p.objectType;
      if (p.channel !== undefined) details.channel = p.channel;
      return {
        code: `CAMERA_${p.analyticType}`,
        message: `Camera analytic ${p.analyticType}${p.state === true ? ' started' : p.state === false ? ' stopped' : ''}`,
        subsystem: 'camera_analytics',
        details,
      };
    }
    case 'SYSTEM_ALERT':
      return {
        code: p.alertCode,
        message: p.message,
        subsystem: p.subsystem,
        ...(p.details ? { details: p.details } : {}),
      };
    default:
      throw new EventMappingError('UNMAPPABLE_EVENT', `no events.v1 mapping for payload kind '${p?.kind}'`);
  }
}

export function toEventV1(ev: VigilOneEvent, ctx: MappingContext = {}): EventEnvelopeV1 {
  let type = VIGILONE_EVENT_TO_V1[ev.type];
  if (ev.payload.kind === 'AI_OBJECT_DETECTED') {
    type = DETECTION_CLASS_TO_EVENT_V1[ev.payload.objectClass];
    if (!type) {
      throw new EventMappingError('UNMAPPABLE_EVENT', `object class '${ev.payload.objectClass}' has no events.v1 type`);
    }
  }
  // Events that carry their own provenance (AI worker output) need no caller-supplied context.
  if (!ctx.provenance && ev.provenance) ctx = { ...ctx, provenance: ev.provenance };
  if (!type) {
    throw new EventMappingError('UNMAPPABLE_EVENT', `no events.v1 mapping for '${ev.type}'`);
  }
  const isAi = type.startsWith('ai.');
  if (isAi && !ctx.provenance) {
    throw new EventMappingError(
      'AI_PROVENANCE_REQUIRED',
      `${ev.type} maps to ${type}, which requires the provenance of the inference that produced it`
    );
  }
  const candidate = {
    id: ev.id,
    type,
    version: EVENTS_CONTRACT_VERSION,
    tenantId: ev.tenantId,
    siteId: ctx.siteId ?? ev.siteId ?? null,
    cameraId: ev.cameraId ?? null,
    timestampUtc: toIso(ev.timestampUtc),
    source: { kind: SOURCE_KIND[ev.source], id: ctx.sourceId || ev.cameraId || ev.source.toLowerCase() },
    correlationId: ev.correlationId,
    severity: ev.severity,
    payload: mapPayload(ev),
    provenance: isAi ? ctx.provenance! : null,
  };
  const parsed = EventEnvelopeV1.safeParse(candidate);
  if (!parsed.success) {
    throw new EventMappingError('INVALID_ENVELOPE', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}
