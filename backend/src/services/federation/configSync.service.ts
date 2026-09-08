import { PrismaClient } from '@prisma/client';

export interface DesiredConfigPayload {
  version: number;
  tenantId: string;
  cameras: Array<{
    id: string;
    name: string;
    ipAddress: string;
    rtspPort: number;
    mainRtspUri: string;
    subRtspUri?: string | null;
  }>;
  schedules: any[];
  detectionZones: any[];
  watchlists: any[];
  automationRules: any[];
  generatedAt: string;
}

export interface ConfigAckPayload {
  desiredVersion: number;
  appliedVersion: number;
  status: 'APPLIED' | 'REJECTED';
  error?: string;
  appliedAt: string;
}

export class ConfigSyncService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Generates a declarative desired-state configuration bundle for a tenant's edge nodes
   */
  public async generateDesiredConfig(tenantId: string, desiredVersion: number): Promise<DesiredConfigPayload> {
    const [cameras, schedules, detectionZones, watchlists, automationRules] = await Promise.all([
      this.prisma.camera.findMany({
        where: { tenantId },
        select: {
          id: true,
          name: true,
          ipAddress: true,
          rtspPort: true,
          mainRtspUri: true,
          subRtspUri: true,
        },
      }),
      this.prisma.recordingSchedule.findMany({ where: { tenantId } }),
      this.prisma.detectionZone.findMany({ where: { tenantId } }),
      this.prisma.vehicleWatchlist.findMany({ where: { tenantId } }),
      this.prisma.automationRule.findMany({ where: { tenantId, enabled: true } }),
    ]);

    return {
      version: desiredVersion,
      tenantId,
      cameras,
      schedules,
      detectionZones,
      watchlists,
      automationRules,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Dispatches a configuration sync record to a target node
   */
  public async createSyncRecord(nodeUuid: string, desiredConfig: DesiredConfigPayload) {
    const node = await this.prisma.federatedNode.findUnique({
      where: { nodeUuid },
    });
    if (!node) {
      throw new Error(`Node ${nodeUuid} not found`);
    }

    return this.prisma.configSyncRecord.create({
      data: {
        tenantId: node.tenantId,
        nodeId: node.id,
        desiredVersion: desiredConfig.version,
        status: 'PENDING',
        payloadJson: desiredConfig as any,
      },
    });
  }

  /**
   * Processes a CONFIG_ACK frame from an edge node, updating applied versions
   */
  public async handleConfigAck(nodeUuid: string, ack: ConfigAckPayload) {
    const node = await this.prisma.federatedNode.findUnique({
      where: { nodeUuid },
    });
    if (!node) {
      throw new Error(`Node ${nodeUuid} not found`);
    }

    await this.prisma.$transaction([
      this.prisma.configSyncRecord.updateMany({
        where: {
          nodeId: node.id,
          desiredVersion: ack.desiredVersion,
        },
        data: {
          appliedVersion: ack.appliedVersion,
          status: ack.status,
          errorMessage: ack.error,
          syncedAt: new Date(ack.appliedAt),
        },
      }),
      this.prisma.federatedNode.update({
        where: { nodeUuid },
        data: {
          configVersionApplied: ack.appliedVersion,
        },
      }),
    ]);

    return { success: true, nodeUuid, appliedVersion: ack.appliedVersion };
  }

  /**
   * Verifies protocol and schema version compatibility between CMS and edge node
   */
  public isCompatible(
    edgeProtocolVersion: number,
    cmsProtocolVersion: number = 1
  ): { compatible: boolean; reason?: string } {
    if (edgeProtocolVersion !== cmsProtocolVersion) {
      return {
        compatible: false,
        reason: `Protocol version mismatch: edge v${edgeProtocolVersion} vs CMS v${cmsProtocolVersion}`,
      };
    }
    return { compatible: true };
  }
}
