import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { FederationService } from '../services/federation/federation.service';
import { SyncEngineService } from '../services/federation/syncEngine.service';
import { ConfigSyncService } from '../services/federation/configSync.service';
import { createRequireNodeSignature } from '../middleware/federationAuth';

const router = Router();
const prisma = new PrismaClient();
const federationService = new FederationService(prisma);
const syncEngineService = new SyncEngineService(prisma);
const configSyncService = new ConfigSyncService(prisma);
const requireNodeAuth = createRequireNodeSignature(prisma, federationService);

/**
 * POST /api/v1/federation/pairing-token
 * Issue single-use pairing token for a remote edge node
 */
router.post(
  '/pairing-token',
  requireAuth,
  authorize(Permission.FEDERATION_MANAGE),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const ttl = req.body.ttlSeconds ? Number(req.body.ttlSeconds) : 600;
      const token = federationService.createPairingToken(tenantId, ttl);

      res.status(201).json({
        pairingToken: token,
        expiresInSeconds: ttl,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/federation/register
 * Edge node registers with pairing token and Ed25519 identity
 */
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      pairingToken,
      nodeUuid,
      name,
      publicKeyEd25519,
      softwareVersion,
      schemaVersion,
      protocolVersion,
      capabilities,
    } = req.body;

    if (!pairingToken || !nodeUuid || !publicKeyEd25519) {
      res.status(400).json({ error: 'pairingToken, nodeUuid, and publicKeyEd25519 are required' });
      return;
    }

    const node = await federationService.registerNode({
      pairingToken,
      nodeUuid,
      name: name || `Edge-${nodeUuid.slice(0, 8)}`,
      publicKeyEd25519,
      softwareVersion: softwareVersion || '1.0.0',
      schemaVersion: schemaVersion || '5.22.0',
      protocolVersion: protocolVersion || 1,
      capabilities: capabilities || {
        anprEnabled: true,
        ptzSupport: true,
        maxCameras: 16,
        localStorageGb: 1000,
        hardwarePlatform: 'Linux x86_64',
      },
    });

    res.status(201).json({
      status: 'REGISTERED',
      nodeUuid: node.nodeUuid,
      tenantId: node.tenantId,
      certificateFingerprint: node.certificateFingerprint,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/v1/federation/nodes
 * List all federated nodes for a tenant
 */
router.get(
  '/nodes',
  requireAuth,
  authorize(Permission.FEDERATION_VIEW),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const tenantId = req.user!.tenantId;
      const nodes = await prisma.federatedNode.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
      });
      const serialized = nodes.map((node) => ({
        ...node,
        syncCursorEvent: node.syncCursorEvent.toString(),
        syncCursorAudit: node.syncCursorAudit.toString(),
        syncCursorAlarm: node.syncCursorAlarm.toString(),
      }));
      res.json({ nodes: serialized });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/v1/federation/nodes/:nodeUuid/heartbeat
 * Edge node heartbeat ping (authenticated via Ed25519 signature & replay nonce)
 */
router.post('/nodes/:nodeUuid/heartbeat', requireNodeAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { nodeUuid } = req.params;
    const result = await federationService.handleHeartbeat(nodeUuid, req.body);
    res.json(result);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/**
 * POST /api/v1/federation/nodes/:nodeUuid/sync-batch
 * Store-and-forward batch ingestion (authenticated via Ed25519 signature & replay nonce)
 */
router.post('/nodes/:nodeUuid/sync-batch', requireNodeAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { nodeUuid } = req.params;
    const { streamType, fromSeq, toSeq, items } = req.body;

    const result = await syncEngineService.processSyncBatch(nodeUuid, {
      streamType: streamType || 'EVENT',
      fromSeq: BigInt(fromSeq),
      toSeq: BigInt(toSeq),
      items: (items || []).map((i: any) => ({
        ...i,
        seq: BigInt(i.seq),
      })),
    });

    res.json({
      ...result,
      acknowledgedCursor: result.acknowledgedCursor.toString(),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/v1/federation/nodes/:nodeUuid/config-ack
 * Edge node acknowledging desired configuration application (authenticated via Ed25519)
 */
router.post('/nodes/:nodeUuid/config-ack', requireNodeAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const { nodeUuid } = req.params;
    const result = await configSyncService.handleConfigAck(nodeUuid, req.body);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
