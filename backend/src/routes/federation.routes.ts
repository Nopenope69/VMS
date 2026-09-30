import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { authorize, Permission } from '../services/rbac/permissions';
import { FederationError, FederationService } from '../services/federation/federation.service';
import { SyncEngineService, SyncError } from '../services/federation/syncEngine.service';
import { RECORD_KINDS } from '../services/federation/recordLog';
import { FederationUplink, registerWithHeadquarters, startFederationUplink, uplinkStatus } from '../services/federation/uplink';
import { ConfigSyncService } from '../services/federation/configSync.service';
import { createRequireNodeSignature } from '../middleware/federationAuth';

const router = Router();
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
      if (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400) {
        res.status(400).json({ error: 'ttlSeconds must be a whole number from 30 to 86400' });
        return;
      }
      const token = await federationService.createPairingToken(tenantId, ttl, req.user!.id);

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
    // The node must report its own facts; the central console never invents versions or capabilities.
    if (!softwareVersion || !schemaVersion || !capabilities || typeof capabilities !== 'object') {
      res.status(400).json({
        error: 'softwareVersion, schemaVersion and capabilities must be reported by the registering node',
        code: 'NODE_FACTS_REQUIRED',
      });
      return;
    }

    const node = await federationService.registerNode({
      pairingToken,
      nodeUuid,
      name: name || `Edge-${nodeUuid.slice(0, 8)}`,
      publicKeyEd25519,
      softwareVersion,
      schemaVersion,
      protocolVersion: protocolVersion || 1,
      capabilities,
    });

    res.status(201).json({
      status: 'REGISTERED',
      nodeUuid: node.nodeUuid,
      tenantId: node.tenantId,
      certificateFingerprint: node.certificateFingerprint,
    });
  } catch (err: any) {
    res.status(err instanceof FederationError && err.code === 'NODE_OWNED_ELSEWHERE' ? 409 : 400).json({ error: err.message, code: err.code });
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
        syncCursorLog: node.syncCursorLog.toString(),
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
 * A site's hash-chained record log (streamType LOG), authenticated by the node's Ed25519 signature.
 */
router.post('/nodes/:nodeUuid/sync-batch', requireNodeAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await syncEngineService.processSyncBatch(req.params.nodeUuid, req.body || {}));
  } catch (err: any) {
    if (err instanceof SyncError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err.message });
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

/** Records received from one site, newest first (headquarters view). */
router.get('/nodes/:nodeUuid/records', requireAuth, authorize(Permission.FEDERATION_VIEW), async (req: Request, res: Response): Promise<void> => {
  const node = await prisma.federatedNode.findUnique({ where: { nodeUuid: req.params.nodeUuid }, select: { id: true, tenantId: true } });
  if (!node || node.tenantId !== req.user!.tenantId) {
    res.status(404).json({ error: 'node not found' });
    return;
  }
  const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  if (kind !== undefined && !(RECORD_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `kind must be one of ${RECORD_KINDS.join(', ')}` });
    return;
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await prisma.federatedRecord.findMany({ where: { nodeId: node.id, ...(kind ? { kind } : {}) }, orderBy: { seq: 'desc' }, take: limit });
  res.json({ records: rows.map((r) => ({ seq: r.seq.toString(), kind: r.kind, sourceId: r.sourceId, occurredAt: r.occurredAt, receivedAt: r.receivedAt, data: r.dataJson, hash: r.hash })) });
});

/** The current state of every site's alarms: the latest ALARM record per site alarm (headquarters view). */
router.get('/alarms', requireAuth, authorize(Permission.FEDERATION_VIEW), async (req: Request, res: Response): Promise<void> => {
  const state = typeof req.query.state === 'string' ? req.query.state : undefined;
  const rows = await prisma.$queryRaw<Array<{ nodeUuid: string; nodeName: string; sourceId: string; seq: bigint; occurredAt: Date; dataJson: any }>>`
    SELECT DISTINCT ON (r."nodeId", r."sourceId") n."nodeUuid", n."name" AS "nodeName", r."sourceId", r."seq", r."occurredAt", r."dataJson"
    FROM "FederatedRecord" r JOIN "FederatedNode" n ON n."id" = r."nodeId"
    WHERE r."tenantId" = ${req.user!.tenantId} AND r."kind" = 'ALARM'
    ORDER BY r."nodeId", r."sourceId", r."seq" DESC`;
  const alarms = rows
    .map((r) => ({ nodeUuid: r.nodeUuid, nodeName: r.nodeName, alarmId: r.sourceId, seq: r.seq.toString(), updatedAt: r.occurredAt, ...r.dataJson }))
    .filter((a) => !state || a.state === state)
    .sort((a, b) => String(b.triggeredAt).localeCompare(String(a.triggeredAt)));
  res.json({ alarms });
});

/** Retires a node: its signatures are refused from now on, and it cannot be re-paired under the same id. */
router.post('/nodes/:nodeUuid/deprovision', requireAuth, authorize(Permission.FEDERATION_MANAGE), async (req: Request, res: Response): Promise<void> => {
  const node = await prisma.federatedNode.findUnique({ where: { nodeUuid: req.params.nodeUuid }, select: { id: true, tenantId: true } });
  if (!node || node.tenantId !== req.user!.tenantId) {
    res.status(404).json({ error: 'node not found' });
    return;
  }
  await prisma.federatedNode.update({ where: { id: node.id }, data: { deprovisionedAt: new Date(), state: 'OFFLINE' } });
  res.json({ status: 'DEPROVISIONED' });
});

/**
 * Site side: pair this appliance with a headquarters (FEDERATION_MANAGE). Creates the node key if needed,
 * registers with the headquarters using its one-time pairing token, and starts syncing this tenant's records.
 */
router.post('/upstream/register', requireAuth, authorize(Permission.FEDERATION_MANAGE), async (req: Request, res: Response): Promise<void> => {
  try {
    const { hqUrl, pairingToken, name } = req.body || {};
    const out = await registerWithHeadquarters(prisma, { hqUrl, pairingToken, name, localTenantId: req.user!.tenantId });
    await startFederationUplink(prisma); // sync starts now, not at the next restart
    res.status(201).json(out);
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

/** Site side: what the uplink has sent and what headquarters acknowledged. */
router.get('/upstream/status', requireAuth, authorize(Permission.FEDERATION_VIEW), async (req: Request, res: Response): Promise<void> => {
  res.json(await uplinkStatus(prisma, req.user!.tenantId));
});

void FederationUplink;
export default router;
