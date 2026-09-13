import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import config from '../config/env';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  active?: boolean;
  sessionId?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Authoritative user resolver for active account & session verification.
 * Supports immediate session revocation and token invalidation.
 */
export async function getActiveUser(userId: string, sessionId?: string): Promise<AuthUser | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        tenantId: true,
        active: true,
      },
    });

    if (!user || !user.active) {
      return null;
    }

    if (sessionId && (prisma as any).userSession) {
      try {
        const session = await (prisma as any).userSession.findUnique({
          where: { id: sessionId },
          select: {
            id: true,
            state: true,
            expiresAt: true,
            revokedAt: true,
          },
        });

        if (
          !session ||
          session.state !== 'ACTIVE' ||
          session.revokedAt ||
          (session.expiresAt && session.expiresAt < new Date())
        ) {
          return null;
        }

        // Asynchronously touch lastActivityAt
        (prisma as any).userSession
          .update({
            where: { id: sessionId },
            data: { lastActivityAt: new Date() },
          })
          .catch(() => {});
      } catch (sessionErr) {
        console.error('[Auth] Error querying userSession:', sessionErr);
        return null;
      }
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      active: user.active,
      sessionId,
    };
  } catch (err) {
    console.error('[Auth] Error checking active user status:', err);
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET) as any;

    // Strict token-type enforcement: Reject refresh or media tokens used as bearer authorization
    if (decoded.type === 'REFRESH' || decoded.type === 'refresh' || decoded.type === 'MEDIA' || (decoded.type && decoded.type !== 'ACCESS')) {
      return res.status(401).json({
        error: 'Unauthorized: Invalid token type for API access',
        code: 'INVALID_TOKEN_TYPE',
      });
    }

    // Immediate account & session revocation check: ensure user exists, is active, and session is valid
    const activeUser = await getActiveUser(decoded.id, decoded.sessionId);
    if (!activeUser) {
      return res.status(401).json({
        error: 'Unauthorized: Account is deactivated or session is invalid',
        code: 'ACCOUNT_DEACTIVATED',
      });
    }

    req.user = activeUser;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Token expired or invalid' });
  }
}

