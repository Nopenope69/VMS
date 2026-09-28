/**
 * Maps the internal VigilOneEvent union (incident orchestrator) onto events.v1.
 * Table and rationale: docs/contracts/events.v1.md#mapping-from-vigiloneevent.
 *
 * The internal union carries no model provenance, so AI-derived events (tripwire, loitering,
 * ANPR) can only be mapped when the caller supplies the provenance of the inference that produced
 * them. Without it the mapping fails with AI_PROVENANCE_REQUIRED; it never invents a model.
 */
import { VigilOneEvent, EventSource } from '../services/incident/orchestrator/types';
import { AiProvenanceV1, EventEnvelopeV1, EVENTS_CONTRACT_VERSION } from './events.v1';

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
  const type = VIGILONE_EVENT_TO_V1[ev.type];
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
