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

export class FederationError extends Error {
  constructor(public readonly code: 'PAIRING_TOKEN_INVALID' | 'PAIRING_TOKEN_EXPIRED' | 'PAIRING_TOKEN_USED' | 'NODE_OWNED_ELSEWHERE' | 'NODE_DEPROVISIONED' | 'BAD_PUBLIC_KEY', message: string) {
    super(message);
  }
}

const tokenSha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class FederationService {
  private prisma: PrismaClient;
  private activeChallenges: Map<string, { challenge: string; expiresAt: number }> = new Map();

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Issues a single-use, time-limited pairing token for a remote site. Only its SHA-256 is stored, so the token
   * survives a restart and a database read does not reveal it.
   */
  public async createPairingToken(tenantId: string, ttlSeconds: number = 600, createdById?: string): Promise<string> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 86400) throw new Error('ttlSeconds must be a whole number from 30 to 86400');
    const token = `vigilone_pair_${crypto.randomBytes(24).toString('hex')}`;
    await this.prisma.federationPairingToken.create({
      data: { tenantId, tokenSha256: tokenSha(token), expiresAt: new Date(Date.now() + ttlSeconds * 1000), createdById },
    });
    return token;
  }

  /** Consumes a pairing token atomically (single use) and returns its tenant. */
  public async consumePairingToken(token: string): Promise<string> {
    if (typeof token !== 'string' || !token.startsWith('vigilone_pair_')) throw new FederationError('PAIRING_TOKEN_INVALID', 'Invalid pairing token');
    const h = tokenSha(token);
    const used = await this.prisma.federationPairingToken.updateMany({ where: { tokenSha256: h, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    const row = await this.prisma.federationPairingToken.findUnique({ where: { tokenSha256: h } });
    if (used.count === 1 && row) return row.tenantId;
    if (!row) throw new FederationError('PAIRING_TOKEN_INVALID', 'Invalid pairing token');
    if (row.usedAt) throw new FederationError('PAIRING_TOKEN_USED', 'Pairing token already used');
    throw new FederationError('PAIRING_TOKEN_EXPIRED', 'Expired pairing token');
  }

  /**
   * Registers a site with its Ed25519 identity. Re-pairing an existing node (a key rotation) needs a fresh token
   * from the same tenant; a node owned by another tenant or deprovisioned cannot be taken over.
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
    try {
      const k = crypto.createPublicKey({ key: Buffer.from(params.publicKeyEd25519, 'base64'), format: 'der', type: 'spki' });
      if (k.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    } catch {
      throw new FederationError('BAD_PUBLIC_KEY', 'publicKeyEd25519 must be a base64 DER SPKI Ed25519 public key');
    }
    const tenantId = await this.consumePairingToken(params.pairingToken);
    const existing = await this.prisma.federatedNode.findUnique({ where: { nodeUuid: params.nodeUuid } });
    if (existing && existing.tenantId !== tenantId) throw new FederationError('NODE_OWNED_ELSEWHERE', 'this node id is registered to another tenant');
    if (existing?.deprovisionedAt) throw new FederationError('NODE_DEPROVISIONED', 'this node was deprovisioned; pair it under a new node id');

    // Certificate fingerprint: SHA-256 of the Ed25519 public key
    const certificateFingerprint = crypto.createHash('sha256').update(Buffer.from(params.publicKeyEd25519, 'base64')).digest('hex');
    const facts = {
      name: params.name,
      publicKeyEd25519: params.publicKeyEd25519,
      certificateFingerprint,
      softwareVersion: params.softwareVersion,
      protocolVersion: params.protocolVersion || 1,
      schemaVersion: params.schemaVersion,
      capabilitiesJson: params.capabilities as any,
      state: NodeState.ONLINE,
      lastSeenAt: new Date(),
    };
    return this.prisma.federatedNode.upsert({
      where: { nodeUuid: params.nodeUuid },
      create: { tenantId, nodeUuid: params.nodeUuid, ...facts },
      update: facts,
    });
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
