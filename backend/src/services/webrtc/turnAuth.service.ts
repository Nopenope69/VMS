import crypto from 'crypto';
import config from '../../config/env';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export class TurnAuthService {
  private turnSecret: string;
  private turnServerHost: string;
  private turnPort: number;

  constructor(secret?: string, host?: string, port?: number) {
    this.turnSecret = secret || process.env.COTURN_SECRET || config.COTURN_SECRET;
    this.turnServerHost = host || process.env.COTURN_HOST || config.COTURN_HOST;
    this.turnPort = port || Number(process.env.COTURN_PORT || config.COTURN_PORT);
  }

  /**
   * Generates time-limited ephemeral TURN credentials according to the TURN REST API standard.
   * Format: username = timestamp:username, password = HMAC-SHA1(secret, username)
   */
  public generateIceServers(userId: string, ttlSeconds: number = 86400): {
    iceServers: IceServerConfig[];
    expiresAt: Date;
  } {
    const expiryTimestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expiryTimestamp}:${userId}`;

    const credential = crypto
      .createHmac('sha1', this.turnSecret)
      .update(username)
      .digest('base64');

    const iceServers: IceServerConfig[] = [
      // Edge appliance STUN server for NAT traversal without external dependency
      {
        urls: [
          `stun:${this.turnServerHost}:${this.turnPort}`,
        ],
      },
      // Ephemeral TURN relay servers (UDP and TCP)
      {
        urls: [
          `turn:${this.turnServerHost}:${this.turnPort}?transport=udp`,
          `turn:${this.turnServerHost}:${this.turnPort}?transport=tcp`,
        ],
        username,
        credential,
      },
    ];

    return {
      iceServers,
      expiresAt: new Date(expiryTimestamp * 1000),
    };
  }

  /**
   * Validates if a provided username & credential pair is valid and unexpired
   */
  public validateTurnCredentials(username: string, credential: string): boolean {
    const parts = username.split(':');
    if (parts.length < 2) return false;

    const expiryTimestamp = Number(parts[0]);
    if (isNaN(expiryTimestamp) || expiryTimestamp < Math.floor(Date.now() / 1000)) {
      return false; // Expired
    }

    const expected = crypto
      .createHmac('sha1', this.turnSecret)
      .update(username)
      .digest('base64');

    const credBuf = Buffer.from(credential);
    const expBuf = Buffer.from(expected);
    if (credBuf.length !== expBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(credBuf, expBuf);
  }
}

export default new TurnAuthService();
