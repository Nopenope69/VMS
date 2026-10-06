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

const Pt01 = z.object({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1) }).strict();
const Segment = z.tuple([Pt01, Pt01]).refine(([a, b]) => Math.hypot(a.x - b.x, a.y - b.y) >= 0.01, 'the two points must be apart');

/** PERSON_DOWN: the lying time is the rule's dwellThresholdSeconds; these refine how a fall is read. */
export const PersonDownParams = z
  .object({
    fallWindowSeconds: z.number().min(1).max(30).optional(),
    /** 0 or absent = off: otherwise someone found lying and still for this long raises the weaker alert. */
    lyingStillSeconds: z.number().min(0).max(3600).optional(),
    stillTolerance: z.number().min(0.005).max(0.2).optional(),
    minKeypointScore: z.number().min(0.1).max(0.9).optional(),
    /** Picture width over height (default 16/9): torso angles are read in pixels. */
    aspectRatio: z.number().min(0.5).max(4).optional(),
  })
  .strict();

/** FENCE_CLIMB: the rule's line is the fence base; `topLine` is the fence top, `protectedSide` the side to keep people off. */
export const FenceClimbParams = z
  .object({
    topLine: Segment,
    protectedSide: z.enum(['LEFT', 'RIGHT']),
    climbSeconds: z.number().min(0.5).max(30).optional(),
    nearDistance: z.number().min(0.01).max(0.3).optional(),
    maxClimbSeconds: z.number().min(5).max(300).optional(),
    minKeypointScore: z.number().min(0.1).max(0.9).optional(),
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

/** The stored PERSON_DOWN settings, or none when missing or no longer valid (the rule then uses its defaults). */
export function parsePersonDownParams(raw: unknown): z.infer<typeof PersonDownParams> {
  const r = PersonDownParams.safeParse(raw ?? {});
  return r.success ? r.data : {};
}

/** The stored FENCE_CLIMB settings, or null: without a valid top line and protected side the rule cannot run. */
export function parseFenceClimbParams(raw: unknown): z.infer<typeof FenceClimbParams> | null {
  const r = FenceClimbParams.safeParse(raw ?? {});
  return r.success ? r.data : null;
}
