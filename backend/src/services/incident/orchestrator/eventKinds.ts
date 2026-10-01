/**
 * One entry per VigilOneEvent kind: everything the system knows about that kind, in one place.
 *
 *   - which rule trigger types it feeds, and the zod schema of each trigger's config;
 *   - how a rule's trigger config is matched against its payload;
 *   - its events.v1 type and payload.
 *
 * The rule engine, the rule schema, the rule preview, the automation dry run and the events.v1 mapping all
 * read this table. Adding a kind means adding one entry here; the compiler refuses a kind without one, and the
 * load-time check below refuses a RuleTriggerType that no kind feeds.
 */
import { z } from 'zod';
import { RuleTriggerType } from '@prisma/client';
import { DETECTION_CLASS_TO_EVENT_V1 } from '../../../contracts/aiAdapter.v1';
import { RuleTriggerConfig, VigilOneEvent, VigilOneEventPayload, VigilOneEventType } from './types';

type PayloadOf<K extends VigilOneEventType> = Extract<VigilOneEventPayload, { kind: K }>;

export interface EventKind<K extends VigilOneEventType> {
  /** Rule trigger types this kind can fire, with the schema a rule's triggerConfig must satisfy. */
  triggers: Partial<Record<RuleTriggerType, z.ZodTypeAny>>;
  /** The trigger type one event fires. Default: the only key of `triggers`, or none. */
  triggerTypeFor?: (p: PayloadOf<K>) => RuleTriggerType | null;
  /** Kind-specific part of the trigger-config match (cameraId and zoneId are checked for every kind). */
  matches: (config: RuleTriggerConfig, p: PayloadOf<K>) => boolean;
  /** TRIPWIRE_CROSS / LOITERING_DWELL: the spatial rule a `spatialRuleId` config is compared with. */
  spatialRuleRef?: (p: PayloadOf<K>) => string | undefined;
  v1: {
    /** The events.v1 type; `resolveType` refines it per event when the kind maps to several. */
    type: string;
    resolveType?: (p: PayloadOf<K>) => string | undefined;
    payload: (p: PayloadOf<K>, ev: VigilOneEvent) => Record<string, unknown>;
  };
}

const AI_CLASSES = Object.keys(DETECTION_CLASS_TO_EVENT_V1);
const VEHICLE_CLASSES = AI_CLASSES.filter((c) => DETECTION_CLASS_TO_EVENT_V1[c] === 'ai.vehicle_detected');

const base = {
  cameraId: z.string().uuid().optional(),
  zoneId: z.string().min(1).optional(),
};
const confidence = z.number().min(0).max(1).optional();
const minDwellSeconds = z.number().int().min(1).max(3600).optional();

const toIso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** A minConfidence floor for kinds whose payload has no confidence semantics of its own. */
const genericConfidence = (config: RuleTriggerConfig, p: unknown): boolean => {
  if (config.minConfidence === undefined) return true;
  const conf = (p as { confidence?: unknown }).confidence;
  return !(typeof conf === 'number' && conf < config.minConfidence);
};

export const EVENT_KINDS: { [K in VigilOneEventType]: EventKind<K> } = {
  MOTION: {
    triggers: { MOTION_ZONE: z.object({ ...base, minConfidence: confidence }).strict() },
    matches: genericConfidence,
    v1: {
      type: 'motion.detected',
      payload: (p, ev) => {
        const out: Record<string, unknown> = { score: p.score, method: 'SCENE_DIFF' };
        // The internal bbox tuple has no declared coordinate space; only carry it when normalized.
        if (Array.isArray(p.bbox) && p.bbox.every((n: number) => n >= 0 && n <= 1)) {
          const [x, y, width, height] = p.bbox;
          if (width > 0 && height > 0) out.bbox = { x, y, width, height };
        }
        if (ev.spatialRef?.zoneId) out.zoneId = ev.spatialRef.zoneId;
        return out;
      },
    },
  },

  TRIPWIRE_CROSS: {
    triggers: { TRIPWIRE_CROSS: z.object({ ...base, spatialRuleId: z.string().uuid().optional(), minConfidence: confidence }).strict() },
    matches: genericConfidence,
    spatialRuleRef: (p) => p.tripwireId,
    v1: {
      type: 'ai.line_crossing',
      payload: (p) => ({
        ruleId: p.tripwireId,
        trackId: p.trackId,
        direction: p.direction === 'FORWARD' ? 'A_TO_B' : p.direction === 'BACKWARD' ? 'B_TO_A' : 'UNSPECIFIED',
      }),
    },
  },

  LOITERING_DWELL: {
    triggers: { LOITERING_DWELL: z.object({ ...base, spatialRuleId: z.string().uuid().optional(), minConfidence: confidence }).strict() },
    matches: genericConfidence,
    spatialRuleRef: (p) => p.zoneId,
    v1: {
      type: 'ai.loitering',
      payload: (p) => ({ zoneId: p.zoneId, trackId: p.trackId, dwellSeconds: p.dwellTimeSeconds, thresholdSeconds: p.thresholdSeconds }),
    },
  },

  ANPR_MATCH: {
    triggers: { ANPR_WATCHLIST: z.object({ ...base, watchlistCategories: z.array(z.string().min(1)).max(20).optional(), minConfidence: confidence }).strict() },
    matches: (config, p) => {
      if (config.watchlistCategories && config.watchlistCategories.length > 0 && (!p.watchlistCategory || !config.watchlistCategories.includes(p.watchlistCategory))) {
        return false;
      }
      return !(config.minConfidence && p.confidence < config.minConfidence);
    },
    v1: {
      type: 'ai.plate_detected',
      payload: (p) => {
        const out: Record<string, unknown> = { plateText: p.plateText, confidence: p.confidence };
        if (p.matchedWatchlistId) out.watchlistMatchId = p.matchedWatchlistId;
        if (p.watchlistCategory) out.watchlistCategory = p.watchlistCategory;
        if (p.vehicleColor) out.vehicleColor = p.vehicleColor;
        return out;
      },
    },
  },

  CAMERA_OFFLINE: {
    triggers: { CAMERA_OFFLINE: z.object({ ...base }).strict() },
    matches: genericConfidence,
    v1: {
      type: 'camera.offline',
      payload: (p) => {
        const out: Record<string, unknown> = { lastSeenUtc: toIso(p.lastSeenUtc) };
        if (p.reason) out.reason = p.reason;
        return out;
      },
    },
  },

  STREAM_DEGRADED: {
    triggers: {},
    matches: genericConfidence,
    v1: {
      type: 'camera.degraded',
      payload: (p) => {
        const out: Record<string, unknown> = { reason: 'STREAM_DEGRADED', fps: p.fps, expectedFps: p.expectedFps };
        if (p.packetLossPercent !== undefined) out.packetLossPercent = p.packetLossPercent;
        return out;
      },
    },
  },

  DI_TRIGGER: {
    triggers: { DIGITAL_INPUT_STATE: z.object({ ...base, pinNumber: z.number().int().min(0).max(255).optional(), targetState: z.string().min(1).optional() }).strict() },
    matches: (config, p) => {
      if (config.pinNumber !== undefined && config.pinNumber !== p.pinNumber) return false;
      if (config.targetState && config.targetState !== p.state) return false;
      return genericConfidence(config, p);
    },
    v1: {
      type: 'system.digital_input',
      payload: (p) => ({
        code: `DI_${p.state}`,
        message: `Digital input ${p.pinNumber} changed to ${p.state}`,
        subsystem: 'io',
        details: { pinNumber: p.pinNumber, state: p.state, previousState: p.previousState ?? null },
      }),
    },
  },

  SCENE_CHANGE: {
    triggers: { SCENE_CHANGE: z.object({ ...base }).strict() },
    matches: genericConfidence,
    v1: { type: 'camera.degraded', payload: (p) => ({ reason: `TAMPER_${p.changeType}` }) },
  },

  SYSTEM_ALERT: {
    triggers: {},
    matches: genericConfidence,
    v1: {
      type: 'system.alert',
      payload: (p) => ({ code: p.alertCode, message: p.message, subsystem: p.subsystem, ...(p.details ? { details: p.details } : {}) }),
    },
  },

  // A rule without a minimum dwell fires on the track's 'confirmed' event; a rule with minDwellSeconds = N only on
  // the 'dwell' event for milestone N. Either way, at most once per track (P3.5 / P3.7).
  AI_OBJECT_DETECTED: {
    triggers: {
      PERSON_DETECTED: z.object({ ...base, objectClasses: z.array(z.literal('person')).max(1).optional(), minConfidence: confidence, minDwellSeconds }).strict(),
      VEHICLE_DETECTED: z
        .object({
          ...base,
          objectClasses: z.array(z.string().refine((c) => VEHICLE_CLASSES.includes(c), `vehicle classes are ${VEHICLE_CLASSES.join(', ')}`)).max(10).optional(),
          minConfidence: confidence,
          minDwellSeconds,
        })
        .strict(),
    },
    triggerTypeFor: (p) => (!p.objectClass ? null : p.objectClass === 'person' ? RuleTriggerType.PERSON_DETECTED : RuleTriggerType.VEHICLE_DETECTED),
    matches: (config, p) => {
      if (config.objectClasses && config.objectClasses.length > 0 && !config.objectClasses.includes(p.objectClass)) return false;
      if (config.minConfidence !== undefined && p.confidence < config.minConfidence) return false;
      const minDwell = config.minDwellSeconds && config.minDwellSeconds > 0 ? config.minDwellSeconds : 0;
      return minDwell === 0 ? p.stage === 'confirmed' : p.stage === 'dwell' && p.stageSeconds === minDwell;
    },
    v1: {
      // Resolved per object class (ai.person_detected / ai.vehicle_detected); an unknown class has no v1 type.
      type: 'ai.object_detected',
      resolveType: (p) => DETECTION_CLASS_TO_EVENT_V1[p.objectClass],
      payload: (p) => ({ objectClass: p.objectClass, confidence: p.confidence, bbox: p.bbox, trackId: p.trackId }),
    },
  },

  CAMERA_ANALYTIC: {
    triggers: {
      CAMERA_ANALYTIC: z
        .object({
          ...base,
          /** Normalised camera analytic types (see cameraEvents mapping), e.g. LINE_CROSSING, INTRUSION. */
          analyticTypes: z.array(z.string().regex(/^[A-Z_]{2,40}$/)).max(20).optional(),
          protocols: z.array(z.enum(['ONVIF_PULLPOINT', 'HIKVISION_ISAPI', 'DAHUA_EVENT_MANAGER'])).max(3).optional(),
        })
        .strict(),
    },
    matches: (config, p) => {
      if (config.analyticTypes && config.analyticTypes.length > 0 && !config.analyticTypes.includes(p.analyticType)) return false;
      if (config.protocols && config.protocols.length > 0 && !config.protocols.includes(p.protocol)) return false;
      // Camera analytics report start and stop; a rule fires on the start (or an instantaneous event).
      if (p.state === false) return false;
      return genericConfidence(config, p);
    },
    v1: {
      // Analytics computed by the camera: VigilOne has no provenance for them, so never ai.*.
      type: 'system.camera_analytic',
      payload: (p) => {
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
      },
    },
  },

  DOOR_EVENT: {
    triggers: {
      DOOR_EVENT: z
        .object({ ...base, doorIds: z.array(z.string().uuid()).max(50).optional(), doorActions: z.array(z.enum(['OPENED', 'CLOSED', 'FORCED_OPEN', 'HELD_OPEN'])).max(4).optional() })
        .strict(),
    },
    matches: (config, p) => {
      if (config.doorIds && config.doorIds.length > 0 && !config.doorIds.includes(p.doorId)) return false;
      if (config.doorActions && config.doorActions.length > 0 && !config.doorActions.includes(p.action)) return false;
      return genericConfidence(config, p);
    },
    v1: {
      type: 'access.door_opened',
      resolveType: (p) => (p.action === 'CLOSED' ? 'access.door_closed' : p.action === 'HELD_OPEN' ? 'access.door_held_open' : 'access.door_opened'),
      payload: (p) =>
        p.action === 'OPENED' || p.action === 'FORCED_OPEN'
          ? { doorId: p.doorId, forced: p.action === 'FORCED_OPEN' }
          : { doorId: p.doorId, ...(p.openSeconds !== undefined ? { openSeconds: p.openSeconds } : {}) },
    },
  },
};

export const EVENT_KIND_NAMES = Object.keys(EVENT_KINDS) as VigilOneEventType[];

export function isEventKind(type: unknown): type is VigilOneEventType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(EVENT_KINDS, type);
}

/** The entry for a payload, typed by its kind (or undefined for a payload of no known kind). */
function kindOf(p: VigilOneEventPayload | undefined): EventKind<VigilOneEventType> | undefined {
  return p && isEventKind(p.kind) ? (EVENT_KINDS[p.kind] as unknown as EventKind<VigilOneEventType>) : undefined;
}

/** Trigger type -> the event kind that feeds it and the schema of its config. Built from EVENT_KINDS. */
export const RULE_TRIGGERS = (() => {
  const out = {} as Record<RuleTriggerType, { eventKind: VigilOneEventType; configSchema: z.ZodTypeAny }>;
  for (const kind of EVENT_KIND_NAMES) {
    for (const [trigger, configSchema] of Object.entries(EVENT_KINDS[kind].triggers) as Array<[RuleTriggerType, z.ZodTypeAny]>) {
      if (out[trigger]) throw new Error(`event kinds: trigger ${trigger} is fed by both ${out[trigger].eventKind} and ${kind}`);
      out[trigger] = { eventKind: kind, configSchema };
    }
  }
  const missing = Object.values(RuleTriggerType).filter((t) => !out[t]);
  if (missing.length) throw new Error(`event kinds: no event kind feeds trigger type(s) ${missing.join(', ')}`);
  return out;
})();

/** The rule trigger type an event of this type fires, or null when it fires none. */
export function triggerTypeFor(eventType: VigilOneEventType, payload?: VigilOneEventPayload): RuleTriggerType | null {
  const kind = EVENT_KINDS[eventType] as unknown as EventKind<VigilOneEventType> | undefined;
  if (!kind) return null;
  if (kind.triggerTypeFor) {
    return payload && payload.kind === eventType ? kind.triggerTypeFor(payload) : null;
  }
  const own = Object.keys(kind.triggers) as RuleTriggerType[];
  return own.length === 1 ? own[0] : null;
}

/** Does a rule's trigger config match this event? (Conditions are evaluated separately.) */
export function matchesTriggerConfig(config: RuleTriggerConfig, event: VigilOneEvent): boolean {
  if (config.cameraId && config.cameraId !== event.cameraId) return false;
  if (config.zoneId && config.zoneId !== event.spatialRef?.zoneId) return false;
  const kind = kindOf(event.payload);
  if (config.spatialRuleId && kind?.spatialRuleRef?.(event.payload) !== config.spatialRuleId) return false;
  return kind ? kind.matches(config, event.payload) : genericConfidence(config, event.payload);
}

/** events.v1 type of an event: the kind's type, refined per event where the kind maps to several. */
export function v1TypeOf(event: VigilOneEvent): string | undefined {
  const payloadKind = kindOf(event.payload);
  if (payloadKind?.v1.resolveType) return payloadKind.v1.resolveType(event.payload);
  return isEventKind(event.type) ? EVENT_KINDS[event.type].v1.type : undefined;
}

/** events.v1 payload of an event, by its payload kind; undefined for a payload of no known kind. */
export function v1PayloadOf(event: VigilOneEvent): Record<string, unknown> | undefined {
  return kindOf(event.payload)?.v1.payload(event.payload, event);
}
