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
});
