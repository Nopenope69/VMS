import { PrismaClient, Role, SessionState } from '@prisma/client';
import crypto from 'crypto';

export interface PkceBundle {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export interface OidcDiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

export interface OidcTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  name?: string;
  groups?: string[];
  roles?: string[];
}

export class OidcService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Generates cryptographically secure PKCE verifier, challenge, state, and nonce
   */
  public generatePkceBundle(): PkceBundle {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const nonce = crypto.randomBytes(16).toString('hex');

    return { codeVerifier, codeChallenge, state, nonce };
  }

  /**
   * Verifies PKCE code challenge matches code verifier
   */
  public verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return expectedChallenge === codeChallenge;
  }

  /**
   * Validates OIDC discovery document format and issuer consistency
   */
  public validateDiscoveryDoc(doc: OidcDiscoveryDoc, expectedIssuer: string): boolean {
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
      return false;
    }
    const cleanDocIssuer = doc.issuer.replace(/\/$/, '');
    const cleanExpected = expectedIssuer.replace(/\/$/, '');
    return cleanDocIssuer === cleanExpected;
  }

  /**
   * Validates ID token claims (issuer, audience, expiry, nonce)
   */
  public validateTokenClaims(
    claims: OidcTokenClaims,
    expectedIssuer: string,
    expectedClientId: string,
    expectedNonce?: string,
    nowEpochSec: number = Math.floor(Date.now() / 1000)
  ): { valid: boolean; error?: string } {
    const cleanDocIssuer = claims.iss.replace(/\/$/, '');
    const cleanExpected = expectedIssuer.replace(/\/$/, '');
    if (cleanDocIssuer !== cleanExpected) {
      return { valid: false, error: `Issuer mismatch: expected ${expectedIssuer}, received ${claims.iss}` };
    }

    const audArray = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audArray.includes(expectedClientId)) {
      return { valid: false, error: `Audience mismatch: client ID ${expectedClientId} not in token aud` };
    }

    if (claims.exp <= nowEpochSec) {
      return { valid: false, error: 'Token has expired' };
    }

    if (expectedNonce && claims.nonce !== expectedNonce) {
      return { valid: false, error: 'Nonce mismatch in token claims' };
    }

    return { valid: true };
  }

  /**
   * Maps IdP groups/roles claims to VigilOne fine-grained Role
   */
  public mapClaimsToRole(claims: OidcTokenClaims): Role {
    const extractedGroups = [
      ...(claims.groups || []),
      ...(claims.roles || []),
    ].map((g) => g.toLowerCase());

    if (
      extractedGroups.some((g) =>
        ['super_admin', 'superadmin', 'cctv_superadmins', 'security_directors'].includes(g)
      )
    ) {
      return Role.SUPER_ADMIN;
    }

    if (
      extractedGroups.some((g) =>
        ['tenant_admin', 'admin', 'cctv_admins', 'soc_managers'].includes(g)
      )
    ) {
      return Role.TENANT_ADMIN;
    }

    if (
      extractedGroups.some((g) =>
        ['operator', 'cctv_operators', 'security_guards', 'surveillance_operators'].includes(g)
      )
    ) {
      return Role.OPERATOR;
    }

    return Role.VIEWER;
  }

  /**
   * Creates a tenant-isolated application user session after successful SSO
   */
  public async createSession(
    tenantId: string,
    userId: string,
    sessionTtlMinutes: number = 480
  ) {
    const expiresAt = new Date(Date.now() + sessionTtlMinutes * 60 * 1000);
    return this.prisma.userSession.create({
      data: {
        tenantId,
        userId,
        state: SessionState.ACTIVE,
        expiresAt,
        lastActivityAt: new Date(),
      },
    });
  }

  /**
   * Validates session state, checking expiry and inactivity timeout
   */
  public async validateSession(
    sessionId: string,
    inactivityTimeoutMinutes: number = 30,
    currentTime: Date = new Date()
  ): Promise<{ state: SessionState; session?: any; error?: string }> {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });

    if (!session) {
      return { state: SessionState.EXPIRED, error: 'Session not found' };
    }

    if (session.state === SessionState.REVOKED) {
      return { state: SessionState.REVOKED, session, error: 'Session has been revoked' };
    }

    if (session.expiresAt.getTime() <= currentTime.getTime()) {
      await this.prisma.userSession.update({
        where: { id: sessionId },
        data: { state: SessionState.EXPIRED },
      });
      return { state: SessionState.EXPIRED, session, error: 'Session has expired' };
    }

    // Check inactivity lock threshold
    const idleDurationMs = currentTime.getTime() - session.lastActivityAt.getTime();
    if (idleDurationMs > inactivityTimeoutMinutes * 60 * 1000) {
      if (session.state !== SessionState.LOCKED) {
        await this.prisma.userSession.update({
          where: { id: sessionId },
          data: { state: SessionState.LOCKED },
        });
      }
      return { state: SessionState.LOCKED, session, error: 'Session locked due to inactivity' };
    }

    // Session is active: refresh lastActivityAt
    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { lastActivityAt: currentTime },
    });

    return { state: SessionState.ACTIVE, session };
  }

  /**
   * Unlocks a locked workstation session
   */
  public async unlockSession(sessionId: string) {
    return this.prisma.userSession.update({
      where: { id: sessionId },
      data: {
        state: SessionState.ACTIVE,
        lastActivityAt: new Date(),
      },
    });
  }

  /**
   * Revokes a session immediately
   */
  public async revokeSession(sessionId: string) {
    return this.prisma.userSession.update({
      where: { id: sessionId },
      data: {
        state: SessionState.REVOKED,
        revokedAt: new Date(),
      },
    });
  }

  /**
   * Revokes all active sessions for a user (e.g. on role change or compromise)
   */
  public async revokeAllUserSessions(userId: string) {
    return this.prisma.userSession.updateMany({
      where: {
        userId,
        state: { in: [SessionState.ACTIVE, SessionState.LOCKED] },
      },
      data: {
        state: SessionState.REVOKED,
        revokedAt: new Date(),
      },
    });
  }
}
