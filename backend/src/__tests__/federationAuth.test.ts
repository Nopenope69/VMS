import { FederationService } from '../services/federation/federation.service';
import crypto from 'crypto';

describe('FederationService (Cryptographic Node Identity, Pairing & Framing)', () => {
  let service: FederationService;
  let mockPrisma: any;
  const tenantId = 'tenant_fed_01';
  const nodeUuid = 'node_edge_uuid_101';

  let keyPair: crypto.KeyPairSyncResult<Buffer, Buffer>;

  beforeAll(() => {
    // Generate an Ed25519 keypair for node testing
    keyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
  });

  beforeEach(() => {
    mockPrisma = {
      federatedNode: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    service = new FederationService(mockPrisma);
  });

  describe('Pairing Token Lifecycle', () => {
    it('should create and consume single-use pairing token', () => {
      const token = service.createPairingToken(tenantId, 60);
      expect(token).toMatch(/^vigilone_pair_/);

      const consumedTenant = service.consumePairingToken(token);
      expect(consumedTenant).toBe(tenantId);

      // Single-use: Second consumption must fail
      expect(() => service.consumePairingToken(token)).toThrow('Invalid pairing token');
    });

    it('should reject expired pairing tokens', () => {
      // 0 second TTL
      const token = service.createPairingToken(tenantId, -1);
      expect(() => service.consumePairingToken(token)).toThrow('Expired pairing token');
    });
  });

  describe('Node Registration & Cryptographic Fingerprinting', () => {
    it('should register node with SHA-256 certificate fingerprint of Ed25519 public key', async () => {
      const token = service.createPairingToken(tenantId, 60);
      const pubKeyBase64 = keyPair.publicKey.toString('base64');
      const expectedFingerprint = crypto
        .createHash('sha256')
        .update(Buffer.from(pubKeyBase64, 'base64'))
        .digest('hex');

      mockPrisma.federatedNode.upsert.mockResolvedValue({
        nodeUuid,
        tenantId,
        certificateFingerprint: expectedFingerprint,
      });

      const node = await service.registerNode({
        pairingToken: token,
        nodeUuid,
        name: 'Warehouse North Gate',
        publicKeyEd25519: pubKeyBase64,
        softwareVersion: '5.22.0',
        schemaVersion: '5.22.0',
        capabilities: {
          anprEnabled: true,
          ptzSupport: false,
          maxCameras: 8,
          localStorageGb: 2000,
          hardwarePlatform: 'Jetson Orin',
        },
      });

      expect(node.certificateFingerprint).toBe(expectedFingerprint);
      expect(mockPrisma.federatedNode.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { nodeUuid },
          create: expect.objectContaining({
            certificateFingerprint: expectedFingerprint,
            publicKeyEd25519: pubKeyBase64,
          }),
        })
      );
    });
  });

  describe('Mutual Signature Verification & Frame Replay Protection', () => {
    it('should verify valid Ed25519 signature and reject invalid/tampered signature', async () => {
      const pubKeyBase64 = keyPair.publicKey.toString('base64');
      mockPrisma.federatedNode.findUnique.mockResolvedValue({
        nodeUuid,
        publicKeyEd25519: pubKeyBase64,
      });

      const challenge = service.generateChallenge(nodeUuid);
      const privKey = crypto.createPrivateKey({
        key: Buffer.from(keyPair.privateKey.toString('base64'), 'base64'),
        format: 'der',
        type: 'pkcs8',
      });

      // Sign challenge
      const signature = crypto.sign(null, Buffer.from(challenge), privKey).toString('base64');

      const isValid = await service.verifyNodeSignature(nodeUuid, challenge, signature);
      expect(isValid).toBe(true);

      // Tampered data
      const isBadValid = await service.verifyNodeSignature(nodeUuid, 'tampered_data', signature);
      expect(isBadValid).toBe(false);
    });

    it('should reject replayed or excessively stale protocol frames (> 5 mins)', async () => {
      const freshFrame = {
        messageId: crypto.randomUUID(),
        nodeUuid,
        sequenceNumber: 1,
        timestamp: new Date().toISOString(),
        type: 'HEARTBEAT' as const,
        payload: {},
      };
      expect(await service.validateFrame(freshFrame)).toBe(true);

      const staleFrame = {
        ...freshFrame,
        timestamp: new Date(Date.now() - 360000).toISOString(), // 6 minutes ago
      };
      expect(await service.validateFrame(staleFrame)).toBe(false);
    });
  });

  describe('Heartbeat & Degradation Watchdog', () => {
    it('should transition node to DEGRADED state if disk usage or queue depth exceeds thresholds', async () => {
      mockPrisma.federatedNode.findUnique.mockResolvedValue({ nodeUuid });
      mockPrisma.federatedNode.update.mockResolvedValue({});

      const result = await service.handleHeartbeat(nodeUuid, {
        activeCameras: 4,
        fpsTotal: 60,
        diskUsagePercent: 98, // Critical disk
        queueDepth: 10,
      });

      expect(result.nodeState).toBe('DEGRADED');
      expect(mockPrisma.federatedNode.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { nodeUuid },
          data: expect.objectContaining({ state: 'DEGRADED' }),
        })
      );
    });

    it('should mark stale nodes as OFFLINE when heartbeat threshold is exceeded', async () => {
      mockPrisma.federatedNode.updateMany.mockResolvedValue({ count: 3 });

      const offlineCount = await service.evaluateStaleNodes(30);
      expect(offlineCount).toBe(3);
      expect(mockPrisma.federatedNode.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { state: 'OFFLINE' },
        })
      );
    });
  });
});
