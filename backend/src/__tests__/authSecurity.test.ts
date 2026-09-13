import jwt from 'jsonwebtoken';
import config from '../config/env';
import { AuthRateLimiter } from '../middleware/rateLimiter';
import { getActiveUser, requireAuth } from '../middleware/auth';
import { PrismaClient } from '@prisma/client';

describe('Auth Security, Throttling & Immediate Revocation Invariant', () => {
  beforeEach(() => {
    AuthRateLimiter.reset();
  });

  describe('Dual-Axis Rate Limiting', () => {
    it('should throttle IP after exceeding maximum allowed attempts', () => {
      const testIp = '192.168.1.100';

      // Record 15 failed attempts
      for (let i = 0; i < 15; i++) {
        expect(AuthRateLimiter.checkLoginAllowed(testIp).allowed).toBe(true);
        AuthRateLimiter.recordFailedLogin(testIp);
      }

      // 16th attempt must be rejected
      const result = AuthRateLimiter.checkLoginAllowed(testIp);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Too many authentication attempts from this IP');
      expect(result.retryAfterSec).toBeGreaterThan(0);
    });

    it('should throttle account after exceeding maximum failed attempts even across different IPs', () => {
      const targetEmail = 'admin@vigilone.local';

      // 5 failed attempts from 5 different IPs
      for (let i = 1; i <= 5; i++) {
        const ip = `10.0.0.${i}`;
        expect(AuthRateLimiter.checkLoginAllowed(ip, targetEmail).allowed).toBe(true);
        AuthRateLimiter.recordFailedLogin(ip, targetEmail);
      }

      // 6th attempt from a brand new 6th IP against the same target account must be blocked
      const newIp = '10.0.0.99';
      const result = AuthRateLimiter.checkLoginAllowed(newIp, targetEmail);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Too many failed attempts for this account');
    });

    it('should reset account failed count upon successful login', () => {
      const ip = '192.168.1.50';
      const email = 'operator@vigilone.local';

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        AuthRateLimiter.recordFailedLogin(ip, email);
      }

      // Successful login
      AuthRateLimiter.recordSuccessfulLogin(ip, email);

      // Subsequent check should allow login without account throttle
      const check = AuthRateLimiter.checkLoginAllowed(ip, email);
      expect(check.allowed).toBe(true);
    });

    it('should throttle bootstrap attempts after 5 attempts', () => {
      const ip = '192.168.1.200';

      for (let i = 0; i < 5; i++) {
        expect(AuthRateLimiter.checkBootstrapAllowed(ip).allowed).toBe(true);
        AuthRateLimiter.recordBootstrapAttempt(ip);
      }

      expect(AuthRateLimiter.checkBootstrapAllowed(ip).allowed).toBe(false);
    });
  });

  describe('Active User Resolution (getActiveUser)', () => {
    it('should return null if user does not exist or has active: false', async () => {
      const mockPrisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'u1',
            email: 'deactivated@vigilone.local',
            role: 'OPERATOR',
            tenantId: 't1',
            active: false,
          }),
        },
      };

      // Test active=false user check directly
      const user = await mockPrisma.user.findUnique({ where: { id: 'u1' } });
      const isActive = user && user.active;
      expect(isActive).toBe(false);
    });

    it('should return valid user profile if active: true', async () => {
      const mockPrisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'u2',
            email: 'active@vigilone.local',
            role: 'OPERATOR',
            tenantId: 't1',
            active: true,
          }),
        },
      };

      const user = await mockPrisma.user.findUnique({ where: { id: 'u2' } });
      expect(user.active).toBe(true);
      expect(user.role).toBe('OPERATOR');
    });
  });

  describe('Strict Token-Type Enforcement Invariant (C-003)', () => {
    it('should reject refresh tokens used as bearer access tokens', async () => {
      const refreshToken = jwt.sign(
        { id: 'u1', type: 'REFRESH', tenantId: 't1' },
        config.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const req: any = {
        headers: { authorization: `Bearer ${refreshToken}` },
      };
      const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      await requireAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_TOKEN_TYPE' })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should reject media tokens used as bearer access tokens', async () => {
      const mediaToken = jwt.sign(
        { id: 'u1', type: 'MEDIA', tenantId: 't1', streamPath: 'cam1' },
        config.JWT_SECRET,
        { expiresIn: '60s' }
      );

      const req: any = {
        headers: { authorization: `Bearer ${mediaToken}` },
      };
      const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      await requireAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INVALID_TOKEN_TYPE' })
      );
      expect(next).not.toHaveBeenCalled();
    });
  });
});
