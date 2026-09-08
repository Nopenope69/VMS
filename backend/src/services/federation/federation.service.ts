import { PrismaClient, NodeState } from '@prisma/client';
import crypto from 'crypto';

export type FederationMessageType =
  | 'REGISTER'
  | 'REGISTER_ACK'
  | 'HEARTBEAT'
  | 'HEARTBEAT_ACK'
  | 'EVENT_BATCH'
  | 'EVENT_ACK'
  | 'SYNC_REQUEST'
  | 'SYNC_RESPONSE'
  | 'CONFIG_UPDATE'
  | 'CONFIG_ACK'
  | 'COMMAND'
  | 'COMMAND_ACK'
  | 'MEDIA_SESSION_REQUEST'
  | 'MEDIA_SESSION_RESPONSE';

export interface FederationFrame<T = any> {
  messageId: string;
  nodeUuid: string;
  sequenceNumber: number;
  timestamp: string;
  type: FederationMessageType;
  payload: T;
  signature?: string;
}

export interface NodeCapabilities {
  anprEnabled: boolean;
  ptzSupport: boolean;
  maxCameras: number;
  localStorageGb: number;
  hardwarePlatform: string;
}

export interface PairingTokenPayload {
  token: string;
  tenantId: string;
  expiresAt: number; // Unix timestamp ms
}

export class FederationService {
  private prisma: PrismaClient;
  private pairingTokens: Map<string, PairingTokenPayload> = new Map();
  private activeChallenges: Map<string, { challenge: string; expiresAt: number }> = new Map();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Generates a single-use, time-limited pairing token for a remote edge node
   */
  public createPairingToken(tenantId: string, ttlSeconds: number = 600): string {
    const token = `vigilone_pair_${crypto.randomBytes(16).toString('hex')}`;
    this.pairingTokens.set(token, {
      token,
      tenantId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return token;
  }

  /**
   * Validates pairing token and consumes it (single-use)
   */
  public consumePairingToken(token: string): string {
    const payload = this.pairingTokens.get(token);
    if (!payload) {
      throw new Error('Invalid pairing token');
    }
    if (Date.now() > payload.expiresAt) {
      this.pairingTokens.delete(token);
      throw new Error('Expired pairing token');
    }
    this.pairingTokens.delete(token);
    return payload.tenantId;
  }

  /**
   * Registers a new edge node with its cryptographic Ed25519 identity
   */
  public async registerNode(params: {
    pairingToken: string;
    nodeUuid: string;
    name: string;
    publicKeyEd25519: string;
    softwareVersion: string;
    schemaVersion: string;
    protocolVersion?: number;
    capabilities: NodeCapabilities;
  }) {
    const tenantId = this.consumePairingToken(params.pairingToken);

    // Compute certificate fingerprint: SHA-256 of the Ed25519 public key
    const certificateFingerprint = crypto
      .createHash('sha256')
      .update(Buffer.from(params.publicKeyEd25519, 'base64'))
      .digest('hex');

    const node = await this.prisma.federatedNode.upsert({
      where: { nodeUuid: params.nodeUuid },
      create: {
        tenantId,
        nodeUuid: params.nodeUuid,
        name: params.name,
        publicKeyEd25519: params.publicKeyEd25519,
        certificateFingerprint,
        softwareVersion: params.softwareVersion,
        protocolVersion: params.protocolVersion || 1,
        schemaVersion: params.schemaVersion,
        capabilitiesJson: params.capabilities as any,
        state: NodeState.ONLINE,
        lastSeenAt: new Date(),
      },
      update: {
        name: params.name,
        publicKeyEd25519: params.publicKeyEd25519,
        certificateFingerprint,
        softwareVersion: params.softwareVersion,
        protocolVersion: params.protocolVersion || 1,
        schemaVersion: params.schemaVersion,
        capabilitiesJson: params.capabilities as any,
        state: NodeState.ONLINE,
        lastSeenAt: new Date(),
      },
    });

    return node;
  }

  /**
   * Generates a cryptographic challenge for mutual authentication
   */
  public generateChallenge(nodeUuid: string): string {
    const challenge = crypto.randomBytes(32).toString('hex');
    this.activeChallenges.set(nodeUuid, {
      challenge,
      expiresAt: Date.now() + 60000, // 60s validity
    });
    return challenge;
  }

  /**
   * Verifies an Ed25519 signature from an edge node against its registered public key
   */
  public async verifyNodeSignature(
    nodeUuid: string,
    data: string,
    signatureBase64: string
  ): Promise<boolean> {
    const node = await this.prisma.federatedNode.findUnique({
      where: { nodeUuid },
    });
    if (!node) return false;

    try {
      const pubKey = crypto.createPublicKey({
        key: Buffer.from(node.publicKeyEd25519, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(
        null,
        Buffer.from(data),
        pubKey,
        Buffer.from(signatureBase64, 'base64')
      );
    } catch {
      return false;
    }
  }

  /**
   * Validates and verifies incoming WSS protocol frame
   */
  public async validateFrame<T>(frame: FederationFrame<T>): Promise<boolean> {
    if (!frame.messageId || !frame.nodeUuid || frame.sequenceNumber === undefined || !frame.type) {
      return false;
    }
    const ageMs = Math.abs(Date.now() - new Date(frame.timestamp).getTime());
    if (ageMs > 300000) {
      // Reject frames older than 5 minutes to prevent replay attacks
      return false;
    }
    return true;
  }

  /**
   * Processes a HEARTBEAT frame from an edge node and updates health metrics
   */
  public async handleHeartbeat(
    nodeUuid: string,
    payload: {
      activeCameras: number;
      fpsTotal: number;
      diskUsagePercent: number;
      queueDepth: number;
      roundTripMs?: number;
    }
  ) {
    const node = await this.prisma.federatedNode.findUnique({
      where: { nodeUuid },
    });
    if (!node) {
      throw new Error(`Node ${nodeUuid} not found`);
    }

    const state =
      payload.diskUsagePercent > 95 || payload.queueDepth > 500
        ? NodeState.DEGRADED
        : NodeState.ONLINE;

    await this.prisma.federatedNode.update({
      where: { nodeUuid },
      data: {
        state,
        lastSeenAt: new Date(),
      },
    });

    return {
      status: 'ACK',
      timestamp: new Date().toISOString(),
      nodeState: state,
    };
  }

  /**
   * Evaluates stale nodes that have missed heartbeats and marks them OFFLINE
   */
  public async evaluateStaleNodes(thresholdSeconds: number = 30): Promise<number> {
    const cutoff = new Date(Date.now() - thresholdSeconds * 1000);
    const result = await this.prisma.federatedNode.updateMany({
      where: {
        state: { in: [NodeState.ONLINE, NodeState.DEGRADED] },
        lastSeenAt: { lt: cutoff },
      },
      data: {
        state: NodeState.OFFLINE,
      },
    });
    return result.count;
  }
}
