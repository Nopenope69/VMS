import { TurnAuthService } from '../services/webrtc/turnAuth.service';
import crypto from 'crypto';

describe('WebRTC TurnAuthService (RFC 5766 REST API)', () => {
  let turnAuthService: TurnAuthService;
  const mockSecret = 'test_turn_secret_xyz123';

  beforeEach(() => {
    process.env.COTURN_SECRET = mockSecret;
    process.env.COTURN_HOST = 'turn.test.vigilone.local';
    process.env.COTURN_PORT = '3478';
    turnAuthService = new TurnAuthService();
  });

  it('should generate standard STUN and TURN server configurations with ephemeral credentials', () => {
    const userId = 'usr_operator_99';
    const result = turnAuthService.generateIceServers(userId, 3600);

    expect(result.iceServers).toHaveLength(2);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // STUN config
    const stunConfig = result.iceServers[0];
    expect(stunConfig.urls).toContain('stun:turn.test.vigilone.local:3478');
    expect(stunConfig.urls).toContain('stun:stun.l.google.com:19302');
    expect(stunConfig.username).toBeUndefined();

    // TURN config
    const turnConfig = result.iceServers[1];
    expect(turnConfig.urls).toContain('turn:turn.test.vigilone.local:3478?transport=udp');
    expect(turnConfig.urls).toContain('turn:turn.test.vigilone.local:3478?transport=tcp');
    expect(turnConfig.username).toBeDefined();
    expect(turnConfig.credential).toBeDefined();

    // Username format: timestamp:userId
    const parts = turnConfig.username!.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[1]).toBe(userId);
    const expiry = Number(parts[0]);
    expect(expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('should generate valid HMAC-SHA1 credential matching coturn REST API specification', () => {
    const userId = 'usr_sec_1';
    const result = turnAuthService.generateIceServers(userId, 7200);
    const turnConfig = result.iceServers[1];

    const expectedHmac = crypto
      .createHmac('sha1', mockSecret)
      .update(turnConfig.username!)
      .digest('base64');

    expect(turnConfig.credential).toBe(expectedHmac);
  });

  it('should validate valid unexpired credentials', () => {
    const userId = 'usr_valid';
    const result = turnAuthService.generateIceServers(userId, 3600);
    const turnConfig = result.iceServers[1];

    const isValid = turnAuthService.validateTurnCredentials(
      turnConfig.username!,
      turnConfig.credential!
    );
    expect(isValid).toBe(true);
  });

  it('should reject expired credentials', () => {
    // Timestamp from 1 hour in the past
    const pastTimestamp = Math.floor(Date.now() / 1000) - 3600;
    const expiredUsername = `${pastTimestamp}:usr_expired`;
    const credential = crypto
      .createHmac('sha1', mockSecret)
      .update(expiredUsername)
      .digest('base64');

    const isValid = turnAuthService.validateTurnCredentials(expiredUsername, credential);
    expect(isValid).toBe(false);
  });

  it('should reject tampered credential or modified username', () => {
    const userId = 'usr_tamper';
    const result = turnAuthService.generateIceServers(userId, 3600);
    const turnConfig = result.iceServers[1];

    // Altered credential
    const isValidBadCred = turnAuthService.validateTurnCredentials(
      turnConfig.username!,
      'corrupted_base64_credential=='
    );
    expect(isValidBadCred).toBe(false);

    // Altered username
    const isValidBadUser = turnAuthService.validateTurnCredentials(
      turnConfig.username! + '_evil',
      turnConfig.credential!
    );
    expect(isValidBadUser).toBe(false);
  });

  it('should reject malformed username with no colon delimiter', () => {
    const isValid = turnAuthService.validateTurnCredentials('malformedusername', 'anycred');
    expect(isValid).toBe(false);
  });
});
