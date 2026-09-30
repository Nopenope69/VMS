/**
 * Per-site crop policy (ADR 0005 decision 4): the switch for PERSON crops and the retention overrides.
 *
 * - Person crops are off unless a site row says otherwise; there is no default-on and no global switch.
 * - Turning them on needs a purpose from the DPDP list (and a case reference for the purposes that
 *   need one); the acting user and time are recorded with it, and the database refuses an enabled row
 *   without them. Turning them off clears the acknowledgement; the audit chain keeps the history.
 * - Every change is written to the audit chain in the same transaction as the change.
 * - Crops already stored stay until their retention ends or a hold releases; this does not delete them.
 *   The response says how many person crops remain so nobody assumes otherwise.
 */
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AuditChainService } from '../audit/auditChain.service';
import { DATA_PURPOSES, PURPOSES_NEEDING_REFERENCE } from '../privacy/dataProtection.service';
import { DEFAULT_CROP_POLICY } from './cropStore';

export class CropPolicyError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

const days = z.number().int().min(1).max(3650);

export const SiteCropPolicyPatch = z
  .object({
    personCropsEnabled: z.boolean().optional(),
    /** Required when turning person crops on. */
    purpose: z.enum(DATA_PURPOSES).optional(),
    /** Required for the purposes that must name a case, request or claim. */
    purposeReference: z.string().trim().min(1).max(200).optional(),
    /** null resets to the default. */
    nonPersonRetentionDays: days.nullable().optional(),
    personRetentionDays: days.nullable().optional(),
  })
  .strict();
export type SiteCropPolicyPatch = z.infer<typeof SiteCropPolicyPatch>;

export interface SiteCropPolicyView {
  siteId: string;
  personCropsEnabled: boolean;
  acknowledgedPurpose: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedAt: string | null;
  nonPersonRetentionDays: number;
  personRetentionDays: number;
  /** True when the value is the ADR default rather than a site override. */
  usingDefaultRetention: { nonPerson: boolean; person: boolean };
  storedPersonCrops: number;
}

async function requireSite(prisma: PrismaClient, tenantId: string, siteId: string) {
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true, tenantId: true } });
  // The same answer for a missing site and another tenant's site: existence is not disclosed.
  if (!site || site.tenantId !== tenantId) throw new CropPolicyError(404, 'SITE_NOT_FOUND', 'Site not found');
  return site;
}

async function view(prisma: PrismaClient, tenantId: string, siteId: string): Promise<SiteCropPolicyView> {
  const row = await prisma.siteCropPolicy.findUnique({ where: { siteId } });
  const storedPersonCrops = await prisma.objectCrop.count({ where: { tenantId, cropClass: 'PERSON', camera: { siteId } } });
  return {
    siteId,
    personCropsEnabled: row?.personCropsEnabled === true,
    acknowledgedPurpose: row?.acknowledgedPurpose ?? null,
    acknowledgedByUserId: row?.acknowledgedByUserId ?? null,
    acknowledgedAt: row?.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    nonPersonRetentionDays: row?.nonPersonRetentionDays ?? DEFAULT_CROP_POLICY.nonPersonRetentionDays,
    personRetentionDays: row?.personRetentionDays ?? DEFAULT_CROP_POLICY.personRetentionDays,
    usingDefaultRetention: { nonPerson: row?.nonPersonRetentionDays == null, person: row?.personRetentionDays == null },
    storedPersonCrops,
  };
}

export async function getSiteCropPolicy(prisma: PrismaClient, tenantId: string, siteId: string): Promise<SiteCropPolicyView> {
  await requireSite(prisma, tenantId, siteId);
  return view(prisma, tenantId, siteId);
}

export async function updateSiteCropPolicy(
  prisma: PrismaClient,
  tenantId: string,
  siteId: string,
  actorUserId: string,
  patch: SiteCropPolicyPatch,
  ipAddress = '127.0.0.1'
): Promise<{ before: SiteCropPolicyView; after: SiteCropPolicyView }> {
  await requireSite(prisma, tenantId, siteId);
  const before = await view(prisma, tenantId, siteId);
  const data: Record<string, unknown> = {};

  if (patch.personCropsEnabled === true) {
    if (!patch.purpose) throw new CropPolicyError(400, 'PURPOSE_REQUIRED', 'Enabling person crops requires a purpose');
    if (PURPOSES_NEEDING_REFERENCE.includes(patch.purpose) && !patch.purposeReference) {
      throw new CropPolicyError(400, 'PURPOSE_REFERENCE_REQUIRED', `Purpose ${patch.purpose} needs a case, request or claim reference`);
    }
    Object.assign(data, {
      personCropsEnabled: true,
      acknowledgedPurpose: patch.purposeReference ? `${patch.purpose}: ${patch.purposeReference}` : patch.purpose,
      acknowledgedByUserId: actorUserId,
      acknowledgedAt: new Date(),
    });
  } else if (patch.personCropsEnabled === false) {
    Object.assign(data, { personCropsEnabled: false, acknowledgedPurpose: null, acknowledgedByUserId: null, acknowledgedAt: null });
  } else if (patch.purpose || patch.purposeReference) {
    throw new CropPolicyError(400, 'PURPOSE_WITHOUT_SWITCH', 'A purpose is only accepted together with personCropsEnabled: true');
  }
  if (patch.nonPersonRetentionDays !== undefined) data.nonPersonRetentionDays = patch.nonPersonRetentionDays;
  if (patch.personRetentionDays !== undefined) data.personRetentionDays = patch.personRetentionDays;
  if (Object.keys(data).length === 0) throw new CropPolicyError(400, 'EMPTY_PATCH', 'Nothing to change');

  await prisma.$transaction(async (tx: any) => {
    await tx.siteCropPolicy.upsert({ where: { siteId }, create: { siteId, ...data }, update: data });
    await AuditChainService.record(tx, {
      tenantId,
      userId: actorUserId,
      action: 'CROP_POLICY_UPDATE',
      resourceType: 'Site',
      resourceId: siteId,
      ipAddress,
      metadata: {
        before: { personCropsEnabled: before.personCropsEnabled, acknowledgedPurpose: before.acknowledgedPurpose, nonPersonRetentionDays: before.nonPersonRetentionDays, personRetentionDays: before.personRetentionDays },
        requested: patch,
      },
    });
  });
  return { before, after: await view(prisma, tenantId, siteId) };
}
