import { z } from 'zod';
import { RuleTriggerType, RuleActionType, EventSeverity } from '@prisma/client';
import { EVENT_KIND_NAMES, RULE_TRIGGERS } from '../incident/orchestrator/eventKinds';
import { VigilOneEventType } from '../incident/orchestrator/types';

/**
 * Validation for automation rules (P3.5 / P3.6). A rule that the engine cannot evaluate exactly
 * is rejected here rather than stored and silently mis-evaluated.
 */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (24 h)');

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeWindowSchema = z
  .object({
    /** 0 = Sunday ... 6 = Saturday, in the schedule's time zone; for an overnight window, the day it starts. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: HHMM,
    /** Exclusive. end < start is an overnight window (22:00-06:00). */
    end: HHMM,
  })
  .strict()
  .refine((w) => w.start !== w.end, 'start and end must differ (use all seven days 00:00-23:59 for always)');

export const EVENT_TYPES = EVENT_KIND_NAMES as [VigilOneEventType, ...VigilOneEventType[]];

const SeverityCondition = z
  .object({
    type: z.literal('SEVERITY_THRESHOLD'),
    /** Historical rules say EQUALS; the semantics were always "at least". */
    operator: z.enum(['EQUALS', 'GTE']).optional(),
    value: z.nativeEnum(EventSeverity),
  })
  .strict();

const TimeScheduleCondition = z
  .object({
    type: z.literal('TIME_SCHEDULE'),
    /** BETWEEN: only inside the windows; NOT_BETWEEN: only outside them. */
    operator: z.enum(['BETWEEN', 'NOT_BETWEEN']),
    value: z
      .object({
        windows: z.array(TimeWindowSchema).min(1).max(14),
        /** IANA zone; default: the camera's site time zone. */
        timezone: z.string().refine(isValidTimeZone, 'unknown IANA time zone').optional(),
      })
      .strict(),
  })
  .strict();

const PrecedenceValue = z
  .object({
    eventTypes: z.array(z.enum(EVENT_TYPES)).min(1).max(10),
    withinSeconds: z.number().int().min(1).max(86400),
    /** SAME_CAMERA (default), ANY_CAMERA of the tenant, or one CAMERA (cameraId). */
    scope: z.enum(['SAME_CAMERA', 'ANY_CAMERA', 'CAMERA']).default('SAME_CAMERA'),
    cameraId: z.string().uuid().optional(),
    /** AI_OBJECT_DETECTED predecessors only: restrict to these classes. */
    objectClasses: z.array(z.string()).min(1).max(20).optional(),
  })
  .strict()
  .refine((v) => (v.scope === 'CAMERA') === !!v.cameraId, 'cameraId is required with scope CAMERA and only then');

const PrecededByCondition = z.object({ type: z.literal('PRECEDED_BY'), value: PrecedenceValue }).strict();
const NotPrecededByCondition = z.object({ type: z.literal('NOT_PRECEDED_BY'), value: PrecedenceValue }).strict();

export const RuleConditionSchema = z.discriminatedUnion('type', [SeverityCondition, TimeScheduleCondition, PrecededByCondition, NotPrecededByCondition]);
export type ValidatedCondition = z.infer<typeof RuleConditionSchema>;

const ActionSchema = z
  .object({
    id: z.string().min(1).max(100),
    type: z.nativeEnum(RuleActionType),
    config: z.record(z.any()).default({}),
    timeoutMs: z.number().int().min(100).max(120000).optional(),
    retryPolicy: z.object({ maxRetries: z.number().int().min(0).max(10), backoffMs: z.number().int().min(0).max(600000) }).strict().optional(),
    continueOnFailure: z.boolean().optional(),
  })
  .strict();

export const RuleInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    triggerType: z.nativeEnum(RuleTriggerType),
    triggerConfig: z.record(z.any()).default({}),
    conditions: z.array(z.any()).max(10).default([]),
    actions: z.array(ActionSchema).min(1).max(10),
    cooldownSeconds: z.number().int().min(0).max(86400).default(30),
    priority: z.number().int().min(0).max(1000).default(1),
    enabled: z.boolean().default(true),
  })
  .strict();

export class RuleValidationError extends Error {}

function firstIssue(prefix: string, e: z.ZodError): string {
  const i = e.issues[0];
  return `${prefix}${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`;
}

export function validateTriggerConfig(triggerType: RuleTriggerType, cfg: unknown) {
  const r = RULE_TRIGGERS[triggerType].configSchema.safeParse(cfg ?? {});
  if (!r.success) throw new RuleValidationError(firstIssue('triggerConfig.', r.error));
  return r.data as Record<string, unknown>;
}

export function validateConditions(conditions: unknown): ValidatedCondition[] {
  const arr = Array.isArray(conditions) ? conditions : [];
  return arr.map((c, i) => {
    const r = RuleConditionSchema.safeParse(c);
    if (!r.success) throw new RuleValidationError(firstIssue(`conditions.${i}.`, r.error));
    return r.data;
  });
}

/** Full rule validation for create/update/preview. Unique action ids are required (outbox key). */
export function validateRuleInput(body: unknown) {
  const r = RuleInputSchema.safeParse(body);
  if (!r.success) throw new RuleValidationError(firstIssue('', r.error));
  const triggerConfig = validateTriggerConfig(r.data.triggerType, r.data.triggerConfig);
  const conditions = validateConditions(r.data.conditions);
  const ids = r.data.actions.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new RuleValidationError('actions: action ids must be unique');
  return { ...r.data, triggerConfig, conditions };
}
