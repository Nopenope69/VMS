import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import config from '../config/env';

const prisma = new PrismaClient();

export interface AuthUser {
  id: string;
  email: string;
  role: string;
  tenantId: string;
  active?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Authoritative user resolver for active account verification.
 * Abstracted behind a helper function to facilitate in-memory caching or token version checks.
 */
export async function getActiveUser(userId: string): Promise<AuthUser | null> {
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

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      active: user.active,
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
    const decoded = jwt.verify(token, config.JWT_SECRET) as AuthUser;

    // Immediate account revocation check: ensure user exists, is active, and retrieve current role
    const activeUser = await getActiveUser(decoded.id);
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

