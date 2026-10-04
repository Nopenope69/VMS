import { z } from 'zod';

/** Per-type settings of the threat rules (SpatialAnalyticsRule.paramsJson), normalised image coordinates. */
export const UnattendedObjectParams = z
  .object({
    ownerRadius: z.number().min(0.01).max(0.5).optional(),
    moveTolerance: z.number().min(0.005).max(0.2).optional(),
  })
  .strict();

export const WrongWayParams = z
  .object({
    minTravel: z.number().min(0.02).max(1).optional(),
    objectClasses: z.array(z.enum(['person', 'bicycle', 'motorcycle', 'car', 'bus', 'truck'])).max(6).optional(),
  })
  .strict();

export type ThreatRuleType = 'UNATTENDED_OBJECT' | 'WRONG_WAY';

/** The stored settings, or none when they are missing or no longer valid (the rule then uses its defaults). */
export function parseThreatParams(type: 'UNATTENDED_OBJECT', raw: unknown): z.infer<typeof UnattendedObjectParams>;
export function parseThreatParams(type: 'WRONG_WAY', raw: unknown): z.infer<typeof WrongWayParams>;
export function parseThreatParams(type: ThreatRuleType, raw: unknown) {
  const r = (type === 'UNATTENDED_OBJECT' ? UnattendedObjectParams : WrongWayParams).safeParse(raw ?? {});
  return r.success ? r.data : {};
}
