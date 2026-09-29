/**
 * Evidence-hold lookup shared by every retention purge (DPDP plate and snapshot purge, crop purge).
 *
 * A record is held when an unexpired incident hold or a legal-hold manifest covers its camera and
 * time. The lookup is loaded once per tenant and per run and answers synchronously. If either query
 * fails, this throws: a purge that cannot tell whether something is held must delete nothing, so
 * callers let the error abort the run (fail closed) rather than falling back to "not held".
 */
import { PrismaClient } from '@prisma/client';

export type HoldChecker = (cameraId: string, from: Date, to: Date) => boolean;

export async function loadHoldChecker(prisma: PrismaClient, tenantId: string, now: Date): Promise<HoldChecker> {
  const holds = await prisma.incidentEvidenceHold.findMany({ where: { tenantId, expiresAt: { gt: now } }, select: { cameraId: true, windowStart: true, windowEnd: true } });
  const legal = await prisma.evidenceManifest.findMany({ where: { tenantId, legalHold: true }, select: { cameraIdsJson: true, startUtc: true, endUtc: true } });
  return (cameraId, from, to) =>
    holds.some((h) => h.cameraId === cameraId && h.windowStart <= to && h.windowEnd >= from) ||
    legal.some((m) => (m.cameraIdsJson as string[]).includes(cameraId) && m.startUtc <= to && m.endUtc >= from);
}
