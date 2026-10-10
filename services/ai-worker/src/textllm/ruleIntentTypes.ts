/**
 * Typed Intermediate Representation (IR) for Describe-What-To-Watch Rules.
 *
 * The generative model extracts intent into this strictly typed schema.
 * A deterministic backend compiler then resolves physical entities,
 * sets thresholds, and enforces invariants before the operator approves.
 */
import { z } from 'zod';

export const BehaviorEnum = z.enum([
  'LOITERING',
  'TRIPWIRE_CROSS',
  'AREA_INTRUSION',
  'PERSON_DOWN',
  'FENCE_CLIMB',
  'CAMERA_TAMPER',
  'OBJECT_ABANDONED',
  'UNRECOGNIZED_VEHICLE',
  'GENERIC_DETECTION',
]);

export type BehaviorType = z.infer<typeof BehaviorEnum>;

export const TargetClassEnum = z.enum([
  'person',
  'vehicle',
  'bicycle',
  'motorcycle',
  'bag',
  'any',
]);

export type TargetClassType = z.infer<typeof TargetClassEnum>;

export const ScheduleTypeEnum = z.enum(['AFTER', 'BEFORE', 'BETWEEN', 'ALWAYS']);

export const ScheduleSchema = z.object({
  type: ScheduleTypeEnum,
  startTime: z.string().nullable().default(null),
  endTime: z.string().nullable().default(null),
  days: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
});

export const ActionTypeEnum = z.enum(['ALARM', 'NOTIFICATION', 'RELAY', 'RECORD']);
export const SeverityEnum = z.enum(['CRITICAL', 'WARNING', 'INFO']);

export const RuleIntentIRSchema = z.object({
  suggestedName: z.string().min(1).max(200),
  behavior: BehaviorEnum,
  targetClass: TargetClassEnum.default('any'),
  locationPhrase: z.string().nullable().default(null),
  durationSeconds: z.number().int().positive().nullable().default(null),
  schedule: ScheduleSchema.default({
    type: 'ALWAYS',
    startTime: null,
    endTime: null,
    days: [0, 1, 2, 3, 4, 5, 6],
  }),
  actionType: ActionTypeEnum.default('ALARM'),
  severity: SeverityEnum.default('CRITICAL'),
  unresolvedNotes: z.array(z.string()).default([]),
});

export type RuleIntentIR = z.infer<typeof RuleIntentIRSchema>;

export function parseRuleIntentIR(input: unknown): RuleIntentIR {
  return RuleIntentIRSchema.parse(input);
}
