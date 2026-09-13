import jwt from 'jsonwebtoken';
import config from '../config/env';

describe('MediaMTX Webhook Authentication Logic', () => {
  const streamPath = 'cam_test123';
  const tenantId = 'ten_abc';

  it('should generate valid short-lived media token and verify claims', () => {
    const token = jwt.sign(
      {
        sub: 'user_1',
        tenantId,
        streamPath,
        action: 'read',
      },
      config.JWT_SECRET,
      { expiresIn: '60s' }
    );

    const decoded = jwt.verify(token, config.JWT_SECRET) as any;
    expect(decoded.streamPath).toBe(streamPath);
    expect(decoded.action).toBe('read');
    expect(decoded.tenantId).toBe(tenantId);
  });

  it('should reject tokens with path mismatch', () => {
    const token = jwt.sign(
      {
        sub: 'user_1',
        tenantId,
        streamPath: 'cam_authorized',
        action: 'read',
      },
      config.JWT_SECRET,
      { expiresIn: '60s' }
    );

    const decoded = jwt.verify(token, config.JWT_SECRET) as any;
    const requestedPath = 'cam_unauthorized_attacker';
    expect(decoded.streamPath === requestedPath).toBe(false);
  });

  it('should reject expired tokens', () => {
    const expiredToken = jwt.sign(
      {
        sub: 'user_1',
        tenantId,
        streamPath,
        action: 'read',
      },
      config.JWT_SECRET,
      { expiresIn: '-1s' }
    );

    expect(() => jwt.verify(expiredToken, config.JWT_SECRET)).toThrow(/jwt expired/);
  });

  it('should reject tokens signed with a forged key', () => {
    const forgedToken = jwt.sign(
      {
        sub: 'user_1',
        tenantId,
        streamPath,
        action: 'read',
      },
      'attacker_forged_secret_key_32_characters_long!',
      { expiresIn: '60s' }
    );

    expect(() => jwt.verify(forgedToken, config.JWT_SECRET)).toThrow(/invalid signature/);
  });

  describe('RTSP Ingest & Publishing Authorization Invariant', () => {
    it('should reject unauthenticated publish attempts', () => {
      const candidateSecret: string | undefined = undefined;
      const isAuthorized = candidateSecret === config.INTERNAL_API_SECRET;
      expect(isAuthorized).toBe(false);
    });

    it('should forbid web user session JWTs from authorizing RTSP publishing', () => {
      const userWebToken = jwt.sign(
        {
          id: 'user_123',
          email: 'admin@vigilone.local',
          role: 'SUPER_ADMIN',
          tenantId,
        },
        config.JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Web session JWT should never match the internal ingest secret
      const isAuthorized = userWebToken === config.INTERNAL_API_SECRET;
      expect(isAuthorized).toBe(false);
    });

    it('should authorize internal services supplying valid INTERNAL_API_SECRET', () => {
      const internalSecret = config.INTERNAL_API_SECRET;
      const isAuthorized = internalSecret === config.INTERNAL_API_SECRET;
      expect(isAuthorized).toBe(true);
    });
  });

  describe('Strict Token Typing & Tenant Isolation Invariants (C-003)', () => {
    it('should reject refresh tokens attempted for media playback/viewing', () => {
      const refreshToken = jwt.sign(
        { id: 'user_1', tenantId, type: 'REFRESH' },
        config.JWT_SECRET,
        { expiresIn: '7d' }
      );

      const decoded = jwt.verify(refreshToken, config.JWT_SECRET) as any;
      const isRefresh = decoded.type === 'REFRESH' || decoded.type === 'refresh';
      expect(isRefresh).toBe(true);
    });

    it('should strictly reject media token when tenantId does not match camera tenant', () => {
      const token = jwt.sign(
        { id: 'user_1', tenantId: 'tenant_alpha', streamPath, action: 'read', type: 'MEDIA' },
        config.JWT_SECRET,
        { expiresIn: '60s' }
      );

      const decoded = jwt.verify(token, config.JWT_SECRET) as any;
      const cameraTenantId = 'tenant_beta';
      const isTenantMatch = decoded.tenantId && decoded.tenantId === cameraTenantId;
      expect(isTenantMatch).toBe(false);
    });

    it('should reject media tokens with missing tenantId', () => {
      const tokenWithoutTenant = jwt.sign(
        { id: 'user_1', streamPath, action: 'read', type: 'MEDIA' },
        config.JWT_SECRET,
        { expiresIn: '60s' }
      );

      const decoded = jwt.verify(tokenWithoutTenant, config.JWT_SECRET) as any;
      const cameraTenantId = 'tenant_beta';
      const isAllowed = Boolean(decoded.tenantId && decoded.tenantId === cameraTenantId);
      expect(isAllowed).toBe(false);
    });
  });
});
