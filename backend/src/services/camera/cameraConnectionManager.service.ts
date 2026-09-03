import { EventEmitter } from 'events';

export type CameraConnectionState =
  | 'OFFLINE'
  | 'CONNECTING'
  | 'ONLINE'
  | 'DEGRADED'
  | 'RECONNECT_BACKOFF';

export interface CameraConnectionInfo {
  cameraId: string;
  state: CameraConnectionState;
  retries: number;
  lastConnectedAt?: Date;
  lastError?: string;
  nextAttemptAt?: Date;
}

export class CameraConnectionManager extends EventEmitter {
  private static instance: CameraConnectionManager;
  private cameras = new Map<string, CameraConnectionInfo>();
  private activeHandshakes = 0;
  private readonly MAX_CONCURRENT_HANDSHAKES = 3;
  private queue: string[] = [];
  private processInterval: NodeJS.Timeout | null = null;

  public static getInstance(): CameraConnectionManager {
    if (!this.instance) {
      this.instance = new CameraConnectionManager();
    }
    return this.instance;
  }

  constructor() {
    super();
    this.startQueueProcessor();
  }

  private startQueueProcessor(intervalMs = 1000) {
    if (this.processInterval) return;
    this.processInterval = setInterval(() => {
      this.processQueue();
    }, intervalMs);
  }

  public registerCamera(cameraId: string): CameraConnectionInfo {
    let info = this.cameras.get(cameraId);
    if (!info) {
      info = {
        cameraId,
        state: 'OFFLINE',
        retries: 0,
      };
      this.cameras.set(cameraId, info);
    }
    return info;
  }

  public getCameraStatus(cameraId: string): CameraConnectionInfo | undefined {
    return this.cameras.get(cameraId);
  }

  /**
   * Request connection/reconnection for a camera.
   * Pushes to jittered queue instead of immediately dialing the camera.
   */
  public enqueueConnection(cameraId: string, priority = false) {
    const info = this.registerCamera(cameraId);

    // If already online or connecting, don't double queue
    if (info.state === 'CONNECTING' || info.state === 'ONLINE') {
      return;
    }

    if (!this.queue.includes(cameraId)) {
      if (priority) {
        this.queue.unshift(cameraId);
      } else {
        this.queue.push(cameraId);
      }
    }
  }

  /**
   * Calculate exponential backoff with full randomized jitter.
   * T_wait = min(60s, 2^retries * 1s) + random(0, 3s)
   */
  public calculateBackoffMs(retries: number): number {
    const baseBackoff = Math.min(60000, Math.pow(2, retries) * 1000);
    const jitter = Math.floor(Math.random() * 3000); // 0-3s random jitter
    return baseBackoff + jitter;
  }

  private async processQueue() {
    if (this.activeHandshakes >= this.MAX_CONCURRENT_HANDSHAKES || this.queue.length === 0) {
      return;
    }

    const now = Date.now();

    // Find the next eligible camera whose backoff period has passed
    const eligibleIndex = this.queue.findIndex((id) => {
      const info = this.cameras.get(id);
      if (!info || !info.nextAttemptAt) return true;
      return info.nextAttemptAt.getTime() <= now;
    });

    if (eligibleIndex === -1) return;

    const [cameraId] = this.queue.splice(eligibleIndex, 1);
    const info = this.cameras.get(cameraId);
    if (!info) return;

    this.activeHandshakes++;
    info.state = 'CONNECTING';
    this.emit('stateChange', cameraId, 'CONNECTING');

    // Emit event so media / ONVIF layer performs connection
    this.emit('connectRequest', cameraId, (success: boolean, errorMsg?: string) => {
      this.activeHandshakes--;

      if (success) {
        info.state = 'ONLINE';
        info.retries = 0;
        info.lastConnectedAt = new Date();
        info.lastError = undefined;
        info.nextAttemptAt = undefined;
        this.emit('stateChange', cameraId, 'ONLINE');
      } else {
        info.retries++;
        const backoffMs = this.calculateBackoffMs(info.retries);
        info.state = 'RECONNECT_BACKOFF';
        info.lastError = errorMsg;
        info.nextAttemptAt = new Date(Date.now() + backoffMs);
        this.emit('stateChange', cameraId, 'RECONNECT_BACKOFF', backoffMs);

        // Re-queue with backoff delay
        this.queue.push(cameraId);
      }
    });
  }

  public reportDisconnect(cameraId: string, reason?: string) {
    const info = this.registerCamera(cameraId);
    info.state = 'DEGRADED';
    info.lastError = reason;
    this.emit('stateChange', cameraId, 'DEGRADED');
    this.enqueueConnection(cameraId);
  }

  public stop() {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
    this.queue = [];
    this.cameras.clear();
  }
}

export const cameraConnectionManager = CameraConnectionManager.getInstance();
export default cameraConnectionManager;
