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
import { EVENT_KINDS, v1PayloadOf, v1TypeOf } from '../services/incident/orchestrator/eventKinds';

export class EventMappingError extends Error {
  constructor(public readonly code: 'AI_PROVENANCE_REQUIRED' | 'UNMAPPABLE_EVENT' | 'INVALID_ENVELOPE', message: string) {
    super(`${code}: ${message}`);
  }
}

/** The default events.v1 type per kind; AI objects and door events are refined per event (eventKinds.ts). */
export const VIGILONE_EVENT_TO_V1 = Object.fromEntries(
  Object.entries(EVENT_KINDS).map(([kind, def]) => [kind, def.v1.type])
) as Record<VigilOneEvent['type'], string>;

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

function mapPayload(ev: VigilOneEvent): Record<string, unknown> {
  const out = v1PayloadOf(ev);
  if (!out) throw new EventMappingError('UNMAPPABLE_EVENT', `no events.v1 mapping for payload kind '${(ev.payload as any)?.kind}'`);
  return out;
}

const toIso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

export function toEventV1(ev: VigilOneEvent, ctx: MappingContext = {}): EventEnvelopeV1 {
  const type = v1TypeOf(ev);
  if (!type && ev.payload.kind === 'AI_OBJECT_DETECTED') {
    throw new EventMappingError('UNMAPPABLE_EVENT', `object class '${ev.payload.objectClass}' has no events.v1 type`);
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
