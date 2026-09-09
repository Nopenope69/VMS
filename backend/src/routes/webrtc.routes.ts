import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import turnAuthService from '../services/webrtc/turnAuth.service';

const router = Router();

router.use(requireAuth);

/**
 * GET /api/v1/webrtc/ice-config
 * Generates and returns dynamic STUN and Ephemeral TURN ICE configurations for WebRTC NAT/WAN traversal.
 * Complies with RFC 5766 REST API and avoids external third-party STUN leaks.
 */
router.get('/ice-config', (req: Request, res: Response) => {
  try {
    const iceConfig = turnAuthService.generateIceServers(req.user!.id, 86400);
    return res.json(iceConfig);
  } catch (err: any) {
    return res.status(500).json({ error: `Failed to generate ICE configuration: ${err.message}` });
  }
});

export default router;
