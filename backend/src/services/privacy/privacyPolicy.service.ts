import { PrismaClient, PrivacyPolicy, Role } from '@prisma/client';

export interface CreatePolicyInput {
  tenantId: string;
  name: string;
  enabled?: boolean;
  faceRedaction?: boolean;
  plateRedaction?: boolean;
  bystanderRedaction?: boolean;
  restrictedZonesJson?: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  }>;
  defaultExportMode?: string;
  approvalRequired?: boolean;
  retentionDays?: number;
}

export interface UpdatePolicyInput {
  name?: string;
  enabled?: boolean;
  faceRedaction?: boolean;
  plateRedaction?: boolean;
  bystanderRedaction?: boolean;
  restrictedZonesJson?: any;
  defaultExportMode?: string;
  approvalRequired?: boolean;
  retentionDays?: number;
}

export interface ComplianceEvaluationResult {
  compliant: boolean;
  requiresRedaction: boolean;
  requiresApproval: boolean;
  enforcedRedactions: {
    face: boolean;
    plate: boolean;
    bystander: boolean;
    restrictedZones: boolean;
  };
  reason?: string;
}

export class PrivacyPolicyService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  public async createPolicy(input: CreatePolicyInput): Promise<PrivacyPolicy> {
    return this.prisma.privacyPolicy.create({
      data: {
        tenantId: input.tenantId,
        name: input.name,
        enabled: input.enabled ?? true,
        faceRedaction: input.faceRedaction ?? false,
        plateRedaction: input.plateRedaction ?? false,
        bystanderRedaction: input.bystanderRedaction ?? false,
        restrictedZonesJson: input.restrictedZonesJson ? (input.restrictedZonesJson as any) : undefined,
        defaultExportMode: input.defaultExportMode ?? 'STREAM_COPY',
        approvalRequired: input.approvalRequired ?? false,
        retentionDays: input.retentionDays ?? 30,
      },
    });
  }

  public async getPolicy(tenantId: string, id: string): Promise<PrivacyPolicy | null> {
    return this.prisma.privacyPolicy.findFirst({
      where: { id, tenantId },
    });
  }

  public async listPolicies(tenantId: string): Promise<PrivacyPolicy[]> {
    return this.prisma.privacyPolicy.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async updatePolicy(
    tenantId: string,
    id: string,
    input: UpdatePolicyInput
  ): Promise<PrivacyPolicy> {
    const existing = await this.getPolicy(tenantId, id);
    if (!existing) {
      throw new Error(`Privacy policy ${id} not found for tenant`);
    }

    return this.prisma.privacyPolicy.update({
      where: { id },
      data: {
        ...input,
        version: { increment: 1 },
      },
    });
  }

  public async deletePolicy(tenantId: string, id: string): Promise<PrivacyPolicy> {
    const existing = await this.getPolicy(tenantId, id);
    if (!existing) {
      throw new Error(`Privacy policy ${id} not found for tenant`);
    }

    return this.prisma.privacyPolicy.delete({
      where: { id },
    });
  }

  /**
   * Evaluates whether an export request satisfies the tenant's privacy policy.
   * Unredacted master exports require dual-custody approval if approvalRequired is true.
   */
  public evaluateExportCompliance(
    policy: PrivacyPolicy,
    userRole: Role,
    isRedactedExport: boolean
  ): ComplianceEvaluationResult {
    if (!policy.enabled) {
      return {
        compliant: true,
        requiresRedaction: false,
        requiresApproval: false,
        enforcedRedactions: {
          face: false,
          plate: false,
          bystander: false,
          restrictedZones: false,
        },
      };
    }

    const hasActiveRedactionRules =
      policy.faceRedaction ||
      policy.plateRedaction ||
      policy.bystanderRedaction ||
      (policy.restrictedZonesJson !== null &&
        Array.isArray(policy.restrictedZonesJson) &&
        (policy.restrictedZonesJson as any[]).length > 0);

    const requiresRedaction = hasActiveRedactionRules && !isRedactedExport;

    // Dual-custody check: if approval is required and raw master export is requested,
    // only SUPER_ADMIN can bypass without secondary approval.
    const requiresApproval =
      policy.approvalRequired && !isRedactedExport && userRole !== Role.SUPER_ADMIN;

    let reason: string | undefined;
    if (requiresApproval) {
      reason = 'Policy requires dual-custody supervisory approval for unredacted raw footage export';
    } else if (requiresRedaction) {
      reason = 'Policy mandates video redaction (faces, plates, or static mask) before export';
    }

    return {
      compliant: !requiresApproval && !requiresRedaction,
      requiresRedaction,
      requiresApproval,
      enforcedRedactions: {
        face: policy.faceRedaction,
        plate: policy.plateRedaction,
        bystander: policy.bystanderRedaction,
        restrictedZones: policy.restrictedZonesJson !== null,
      },
      reason,
    };
  }
}
