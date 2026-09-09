import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { FederationService } from '../services/federation/federation.service';

// In-memory sliding-window replay protection cache
const nonceCache = new Map<string, number>();

// Periodic garbage collection for expired nonces
setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of nonceCache.entries()) {
    if (now > expiresAt) {
      nonceCache.delete(key);
    }
  }
}, 60000).unref();

export function buildCanonicalRequest(params: {
  version: string;
  nodeUuid: string;
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  bodyHashHex: string;
}): string {
  return [
    params.version,
    params.nodeUuid,
    params.timestamp,
    params.nonce,
    params.method.toUpperCase(),
    params.path,
    params.bodyHashHex,
  ].join('\n');
}

/**
 * Express middleware enforcing cryptographic Ed25519 signature,
 * replay protection, and canonical request integrity on incoming edge-node sync requests.
 */
export function createRequireNodeSignature(
  prisma: PrismaClient,
  federationService: FederationService
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const nodeUuid = req.params.nodeUuid;
    if (!nodeUuid) {
      res.status(400).json({ error: 'Node UUID is required in request path' });
      return;
    }

    const signature = req.headers['x-node-signature'] as string;
    const timestampStr = req.headers['x-node-timestamp'] as string;
    const nonce = req.headers['x-node-nonce'] as string;
    const version = (req.headers['x-node-version'] as string) || 'v1';

    if (!signature || !timestampStr || !nonce) {
      res.status(401).json({
        error: 'Missing edge node authentication headers (x-node-signature, x-node-timestamp, x-node-nonce)',
      });
      return;
    }

    // 1. Timestamp freshness window (+/- 300s)
    const timestampMs = !isNaN(Number(timestampStr))
      ? Number(timestampStr)
      : Date.parse(timestampStr);

    if (isNaN(timestampMs) || Math.abs(Date.now() - timestampMs) > 300000) {
      res.status(401).json({ error: 'Timestamp expired or skewed beyond 300s window' });
      return;
    }

    // 2. Replay cache check
    const cacheKey = `${nodeUuid}:${nonce}`;
    if (nonceCache.has(cacheKey)) {
      res.status(401).json({ error: 'Cryptographic replay detected: duplicate nonce' });
      return;
    }

    try {
      // 3. Lookup node registration
      const node = await prisma.federatedNode.findUnique({
        where: { nodeUuid },
      });

      if (!node || (node as any).status === 'DEPROVISIONED') {
        res.status(401).json({ error: 'Unregistered or deprovisioned edge node' });
        return;
      }

      // 4. Compute raw request body SHA-256
      const rawBody =
        (req as any).rawBody ||
        (req.body && Object.keys(req.body).length > 0
          ? Buffer.from(JSON.stringify(req.body))
          : Buffer.alloc(0));

      const bodyHashHex = crypto.createHash('sha256').update(rawBody).digest('hex');

      // 5. Build canonical request string
      const canonical = buildCanonicalRequest({
        version,
        nodeUuid,
        timestamp: timestampStr,
        nonce,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        bodyHashHex,
      });

      // 6. Verify Ed25519 signature against registered node public key
      const isValid = await federationService.verifyNodeSignature(nodeUuid, canonical, signature);
      if (!isValid) {
        res.status(401).json({ error: 'Invalid edge node cryptographic signature' });
        return;
      }

      // 7. Record nonce with 360s TTL
      nonceCache.set(cacheKey, Date.now() + 360000);
      (req as any).federatedNode = node;
      next();
    } catch (err: any) {
      res.status(500).json({ error: `Node authentication error: ${err.message}` });
    }
  };
}
