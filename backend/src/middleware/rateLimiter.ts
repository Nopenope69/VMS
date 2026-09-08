import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

export class AuthRateLimiter {
  // IP window map
  private static ipAttempts = new Map<string, RateLimitRecord>();
  // Account/email window map (tracks failed attempts only)
  private static accountAttempts = new Map<string, RateLimitRecord>();
  // Bootstrap window map
  private static bootstrapAttempts = new Map<string, RateLimitRecord>();

  // Configuration constants
  private static readonly WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  private static readonly MAX_IP_ATTEMPTS = 15; // Max 15 attempts per IP per 15 min
  private static readonly MAX_ACCOUNT_FAILED_ATTEMPTS = 5; // Max 5 failed attempts per account per 15 min
  private static readonly MAX_BOOTSTRAP_ATTEMPTS = 5; // Max 5 attempts per IP per 15 min

  private static cleanupTimer: NodeJS.Timeout | null = null;

  static {
    // Background memory maintenance: clean expired entries every 5 minutes
    this.cleanupTimer = setInterval(() => {
      this.evictExpired();
    }, 5 * 60 * 1000);
    // Unref so timer does not hold process open in test runners
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  private static evictExpired() {
    const now = Date.now();
    for (const [key, record] of this.ipAttempts.entries()) {
      if (now > record.resetTime) this.ipAttempts.delete(key);
    }
    for (const [key, record] of this.accountAttempts.entries()) {
      if (now > record.resetTime) this.accountAttempts.delete(key);
    }
    for (const [key, record] of this.bootstrapAttempts.entries()) {
      if (now > record.resetTime) this.bootstrapAttempts.delete(key);
    }
  }

  public static getClientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket.remoteAddress || '127.0.0.1';
  }

  public static checkLoginAllowed(ip: string, email?: string): { allowed: boolean; retryAfterSec?: number; reason?: string } {
    const now = Date.now();

    // 1. Check IP-based limit
    const ipRecord = this.ipAttempts.get(ip);
    if (ipRecord && now < ipRecord.resetTime && ipRecord.count >= this.MAX_IP_ATTEMPTS) {
      const retryAfterSec = Math.ceil((ipRecord.resetTime - now) / 1000);
      return { allowed: false, retryAfterSec, reason: 'Too many authentication attempts from this IP' };
    }

    // 2. Check Account-based limit (if email provided)
    if (email) {
      const normEmail = email.toLowerCase().trim();
      const accountRecord = this.accountAttempts.get(normEmail);
      if (accountRecord && now < accountRecord.resetTime && accountRecord.count >= this.MAX_ACCOUNT_FAILED_ATTEMPTS) {
        const retryAfterSec = Math.ceil((accountRecord.resetTime - now) / 1000);
        return { allowed: false, retryAfterSec, reason: 'Too many failed attempts for this account' };
      }
    }

    return { allowed: true };
  }

  public static recordFailedLogin(ip: string, email?: string): void {
    const now = Date.now();

    // Record on IP
    const ipRec = this.ipAttempts.get(ip);
    if (!ipRec || now > ipRec.resetTime) {
      this.ipAttempts.set(ip, { count: 1, resetTime: now + this.WINDOW_MS });
    } else {
      ipRec.count++;
    }

    // Record on Account
    if (email) {
      const normEmail = email.toLowerCase().trim();
      const accRec = this.accountAttempts.get(normEmail);
      if (!accRec || now > accRec.resetTime) {
        this.accountAttempts.set(normEmail, { count: 1, resetTime: now + this.WINDOW_MS });
      } else {
        accRec.count++;
      }
    }
  }

  public static recordSuccessfulLogin(ip: string, email?: string): void {
    // Clear account failures upon successful authentication
    if (email) {
      const normEmail = email.toLowerCase().trim();
      this.accountAttempts.delete(normEmail);
    }
  }

  public static checkBootstrapAllowed(ip: string): { allowed: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const record = this.bootstrapAttempts.get(ip);
    if (record && now < record.resetTime && record.count >= this.MAX_BOOTSTRAP_ATTEMPTS) {
      const retryAfterSec = Math.ceil((record.resetTime - now) / 1000);
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true };
  }

  public static recordBootstrapAttempt(ip: string): void {
    const now = Date.now();
    const record = this.bootstrapAttempts.get(ip);
    if (!record || now > record.resetTime) {
      this.bootstrapAttempts.set(ip, { count: 1, resetTime: now + this.WINDOW_MS });
    } else {
      record.count++;
    }
  }

  public static reset(): void {
    this.ipAttempts.clear();
    this.accountAttempts.clear();
    this.bootstrapAttempts.clear();
  }
}

/**
 * Express middleware for login endpoint rate limiting.
 */
export function loginRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = AuthRateLimiter.getClientIp(req);
  const email = req.body?.email;

  const check = AuthRateLimiter.checkLoginAllowed(ip, email);
  if (!check.allowed) {
    res.setHeader('Retry-After', check.retryAfterSec || 60);
    return res.status(429).json({
      error: 'Too many login attempts. Please try again later.',
      retryAfterSec: check.retryAfterSec,
    });
  }

  next();
}

/**
 * Express middleware for bootstrap endpoint rate limiting.
 */
export function bootstrapRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = AuthRateLimiter.getClientIp(req);

  const check = AuthRateLimiter.checkBootstrapAllowed(ip);
  if (!check.allowed) {
    res.setHeader('Retry-After', check.retryAfterSec || 60);
    return res.status(429).json({
      error: 'Too many bootstrap attempts. Please try again later.',
      retryAfterSec: check.retryAfterSec,
    });
  }

  AuthRateLimiter.recordBootstrapAttempt(ip);
  next();
}
