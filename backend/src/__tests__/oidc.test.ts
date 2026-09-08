import { PrismaClient, Role, SessionState } from '@prisma/client';
import { OidcService } from '../services/auth/oidc.service';

describe('Bucket 6: Enterprise Identity, OIDC & Session Security', () => {
  let prisma: any;
  let oidcService: OidcService;

  beforeEach(() => {
    prisma = {
      userSession: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sess-123', ...data })),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as unknown as PrismaClient;

    oidcService = new OidcService(prisma);
  });

  describe('PKCE Cryptographic Security', () => {
    it('generates high-entropy PKCE verifier, challenge, state, and nonce', () => {
      const bundle = oidcService.generatePkceBundle();
      expect(bundle.codeVerifier).toBeDefined();
      expect(bundle.codeChallenge).toBeDefined();
      expect(bundle.state).toBeDefined();
      expect(bundle.nonce).toBeDefined();
      expect(bundle.codeVerifier.length).toBeGreaterThanOrEqual(43);
    });

    it('verifies valid PKCE code challenge matches code verifier', () => {
      const bundle = oidcService.generatePkceBundle();
      const valid = oidcService.verifyPkce(bundle.codeVerifier, bundle.codeChallenge);
      expect(valid).toBe(true);
    });

    it('rejects mismatched PKCE challenge', () => {
      const bundle = oidcService.generatePkceBundle();
      const valid = oidcService.verifyPkce('corrupted-verifier-value', bundle.codeChallenge);
      expect(valid).toBe(false);
    });
  });

  describe('Discovery Document & Token Claims Validation', () => {
    it('validates standard OIDC discovery document', () => {
      const validDoc = {
        issuer: 'https://idp.enterprise.internal/oauth2',
        authorization_endpoint: 'https://idp.enterprise.internal/oauth2/auth',
        token_endpoint: 'https://idp.enterprise.internal/oauth2/token',
        jwks_uri: 'https://idp.enterprise.internal/oauth2/jwks',
      };
      expect(
        oidcService.validateDiscoveryDoc(validDoc, 'https://idp.enterprise.internal/oauth2')
      ).toBe(true);
    });

    it('rejects discovery doc with mismatched issuer', () => {
      const invalidDoc = {
        issuer: 'https://malicious.external.org',
        authorization_endpoint: 'https://malicious.external.org/auth',
        token_endpoint: 'https://malicious.external.org/token',
        jwks_uri: 'https://malicious.external.org/jwks',
      };
      expect(
        oidcService.validateDiscoveryDoc(invalidDoc, 'https://idp.enterprise.internal/oauth2')
      ).toBe(false);
    });

    it('validates compliant ID token claims', () => {
      const claims = {
        iss: 'https://idp.enterprise.internal',
        sub: 'usr-9876',
        aud: 'vigilone-edge-appliance',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000) - 10,
        nonce: 'nonce-xyz-123',
      };

      const res = oidcService.validateTokenClaims(
        claims,
        'https://idp.enterprise.internal',
        'vigilone-edge-appliance',
        'nonce-xyz-123'
      );
      expect(res.valid).toBe(true);
    });

    it('rejects expired ID token', () => {
      const claims = {
        iss: 'https://idp.enterprise.internal',
        sub: 'usr-9876',
        aud: 'vigilone-edge-appliance',
        exp: Math.floor(Date.now() / 1000) - 100, // Expired
        iat: Math.floor(Date.now() / 1000) - 3600,
      };

      const res = oidcService.validateTokenClaims(
        claims,
        'https://idp.enterprise.internal',
        'vigilone-edge-appliance'
      );
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Token has expired');
    });

    it('rejects ID token with nonce mismatch', () => {
      const claims = {
        iss: 'https://idp.enterprise.internal',
        sub: 'usr-9876',
        aud: 'vigilone-edge-appliance',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce: 'unexpected-nonce',
      };

      const res = oidcService.validateTokenClaims(
        claims,
        'https://idp.enterprise.internal',
        'vigilone-edge-appliance',
        'expected-nonce'
      );
      expect(res.valid).toBe(false);
      expect(res.error).toContain('Nonce mismatch');
    });
  });

  describe('Enterprise Group / Claim Role Mapping', () => {
    it('maps security directors / superadmins to SUPER_ADMIN', () => {
      expect(
        oidcService.mapClaimsToRole({
          iss: 'idp',
          sub: '1',
          aud: 'client',
          exp: 9999,
          iat: 1,
          groups: ['Security_Directors', 'Staff'],
        })
      ).toBe(Role.SUPER_ADMIN);
    });

    it('maps CCTV Admins to TENANT_ADMIN', () => {
      expect(
        oidcService.mapClaimsToRole({
          iss: 'idp',
          sub: '1',
          aud: 'client',
          exp: 9999,
          iat: 1,
          groups: ['CCTV_Admins'],
        })
      ).toBe(Role.TENANT_ADMIN);
    });

    it('maps operators to OPERATOR role', () => {
      expect(
        oidcService.mapClaimsToRole({
          iss: 'idp',
          sub: '1',
          aud: 'client',
          exp: 9999,
          iat: 1,
          groups: ['surveillance_operators'],
        })
      ).toBe(Role.OPERATOR);
    });

    it('defaults unmapped groups to VIEWER', () => {
      expect(
        oidcService.mapClaimsToRole({
          iss: 'idp',
          sub: '1',
          aud: 'client',
          exp: 9999,
          iat: 1,
          groups: ['guest_auditors'],
        })
      ).toBe(Role.VIEWER);
    });
  });

  describe('Session Lifecycle & Inactivity Timeout', () => {
    it('creates active user session with TTL', async () => {
      const session = await oidcService.createSession('tenant-1', 'user-1', 480);
      expect(session.state).toBe(SessionState.ACTIVE);
      expect(session.tenantId).toBe('tenant-1');
      expect(session.userId).toBe('user-1');
    });

    it('auto-locks session when inactivity threshold is exceeded', async () => {
      const lastActive = new Date(Date.now() - 40 * 60 * 1000); // 40 minutes idle
      const expiresAt = new Date(Date.now() + 100 * 60 * 1000);

      (prisma.userSession.findUnique as jest.Mock).mockResolvedValue({
        id: 'sess-1',
        state: SessionState.ACTIVE,
        lastActivityAt: lastActive,
        expiresAt,
      });

      const res = await oidcService.validateSession('sess-1', 30, new Date());
      expect(res.state).toBe(SessionState.LOCKED);
      expect(prisma.userSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-1' },
          data: { state: SessionState.LOCKED },
        })
      );
    });

    it('refreshes lastActivityAt for active session within timeout', async () => {
      const now = new Date();
      const lastActive = new Date(now.getTime() - 5 * 60 * 1000); // 5 min idle (< 30 min)
      const expiresAt = new Date(now.getTime() + 100 * 60 * 1000);

      (prisma.userSession.findUnique as jest.Mock).mockResolvedValue({
        id: 'sess-1',
        state: SessionState.ACTIVE,
        lastActivityAt: lastActive,
        expiresAt,
      });

      const res = await oidcService.validateSession('sess-1', 30, now);
      expect(res.state).toBe(SessionState.ACTIVE);
      expect(prisma.userSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-1' },
          data: { lastActivityAt: now },
        })
      );
    });

    it('unlocks locked workstation session', async () => {
      await oidcService.unlockSession('sess-1');
      expect(prisma.userSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sess-1' },
          data: expect.objectContaining({ state: SessionState.ACTIVE }),
        })
      );
    });

    it('revokes all active sessions for a user on role change or incident', async () => {
      await oidcService.revokeAllUserSessions('user-99');
      expect(prisma.userSession.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-99',
            state: { in: [SessionState.ACTIVE, SessionState.LOCKED] },
          },
          data: expect.objectContaining({ state: SessionState.REVOKED }),
        })
      );
    });
  });
});
