import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import config from '../config/env';
import { getActiveUser } from '../middleware/auth';

const router = Router();

interface MediaMtxAuthPayload {
  user?: string;
  password?: string;
  token?: string;
  ip?: string;
  action: 'publish' | 'read' | 'playback' | 'api' | 'metrics' | 'pprof';
  path: string;
  protocol?: string;
  id?: string;
  query?: string;
}

/**
 * HTTP Authentication Webhook for MediaMTX
 * MediaMTX calls this endpoint before permitting any action.
 * Return 200 OK to allow, or 401/403 to forbid.
 */
router.post('/auth', async (req: Request, res: Response) => {
  const payload: MediaMtxAuthPayload = req.body;

  // 1. Control API actions are internal
  if (payload.action === 'api') {
    return res.status(200).send('OK');
  }

  // 2. Allow internal services supplying INTERNAL_API_SECRET (internal pipelines, synthetic sources, proxies)
  const secretCandidate = payload.password || payload.token;
  if (secretCandidate && secretCandidate === config.INTERNAL_API_SECRET) {
    return res.status(200).send('OK');
  }

  // 3. Strict media publishing authorization (reject external publish)
  if (payload.action === 'publish') {
    console.warn(
      `[MediaAuth] Denied unauthorized RTSP publish attempt for path: ${payload.path} from IP: ${payload.ip}`
    );
    return res.status(403).json({ error: 'Forbidden: Unauthorized media publishing' });
  }

  // 4. For read/playback, authenticate media token from token, password, user, or query parameter
  let token = payload.token;
  if (!token && payload.password && payload.password.length > 20) {
    token = payload.password;
  }
  if (!token && payload.user && payload.user.length > 20) {
    token = payload.user;
  }
  if (!token && payload.query) {
    try {
      const searchParams = new URLSearchParams(payload.query);
      token = searchParams.get('token') || searchParams.get('jwt') || undefined;
    } catch {
      // Ignore malformed query string
    }
  }

  if (!token) {
    console.warn(`[MediaAuth] Denied unauthenticated ${payload.action} request for path: ${payload.path} from IP: ${payload.ip}`);
    return res.status(403).json({ error: 'Forbidden: No media token provided' });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as any;

    // 1. Strict rejection of refresh tokens
    if (decoded.type === 'REFRESH' || decoded.type === 'refresh') {
      console.warn(`[MediaAuth] Denied refresh token used for media auth: ${payload.path}`);
      return res.status(403).json({ error: 'Forbidden: Refresh token cannot be used for media access' });
    }

    // 2. Check token action scope
    if (decoded.action && decoded.action !== 'read') {
      return res.status(403).json({ error: 'Forbidden: Invalid token action scope' });
    }

    // 3. If token is scoped to specific stream path, verify match
    if (decoded.streamPath && decoded.streamPath !== payload.path) {
      console.warn(`[MediaAuth] Token path mismatch: token=${decoded.streamPath}, req=${payload.path}`);
      return res.status(403).json({ error: 'Forbidden: Token is not valid for this stream path' });
    }

    // 4. Verify user exists and is active (for user access tokens)
    if (decoded.id) {
      const activeUser = await getActiveUser(decoded.id, decoded.sessionId);
      if (!activeUser || !activeUser.active) {
        console.warn(`[MediaAuth] Denied inactive or revoked user ${decoded.id} for path: ${payload.path}`);
        return res.status(403).json({ error: 'Forbidden: User account is inactive or session is invalid' });
      }
    }

    // 5. Verify camera exists and enforce strict tenant isolation
    const camera = await prisma.camera.findUnique({
      where: { streamPath: payload.path },
    });

    if (!camera) {
      return res.status(404).json({ error: 'Stream path not found' });
    }

    if (!decoded.tenantId || camera.tenantId !== decoded.tenantId) {
      console.warn(`[MediaAuth] Tenant isolation mismatch: token tenant=${decoded.tenantId}, camera tenant=${camera.tenantId}`);
      return res.status(403).json({ error: 'Forbidden: Tenant isolation mismatch' });
    }

    // Authenticated successfully
    return res.status(200).send('OK');
  } catch (err: any) {
    console.warn(`[MediaAuth] Token verification failed for ${payload.path}: ${err.message}`);
    return res.status(403).json({ error: 'Forbidden: Token verification failed' });
  }
});

export default router;
