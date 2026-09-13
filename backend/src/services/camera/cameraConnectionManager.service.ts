import { EventEmitter } from 'events';
import net from 'net';
import prisma from '../../config/database';
import mediaProvider from '../media/mediamtx.provider';
import { decryptCredential } from '../../utils/crypto';

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

export type ReconnectionHandler = (cameraId: string) => Promise<{ success: boolean; error?: string }>;

export class CameraConnectionManager extends EventEmitter {
  private static instance: CameraConnectionManager;
  private cameras = new Map<string, CameraConnectionInfo>();
  private activeHandshakes = 0;
  public static readonly MAX_CONCURRENT_HANDSHAKES = 3;
  private queue: string[] = [];
  private processInterval: NodeJS.Timeout | null = null;
  private customHandler: ReconnectionHandler | null = null;

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

  public setReconnectionHandler(handler: ReconnectionHandler | null) {
    this.customHandler = handler;
  }

  public getActiveHandshakes(): number {
    return this.activeHandshakes;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  private startQueueProcessor(intervalMs = 1000) {
    if (this.processInterval) return;
    this.processInterval = setInterval(() => {
      this.processQueue();
    }, intervalMs);
    if (this.processInterval.unref) {
      this.processInterval.unref();
    }
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

  public getAllCameras(): CameraConnectionInfo[] {
    return Array.from(this.cameras.values());
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
   * T_wait = min(30s, 2^retries * 1s) + random(0, 3s)
   */
  public calculateBackoffMs(retries: number): number {
    // Contract Section 3.1: Reconnect <= 15s after network restoration; backoff capped at 30s
    const baseBackoff = Math.min(30000, Math.pow(2, retries) * 1000);
    const jitter = Math.floor(Math.random() * 3000); // 0-3s random jitter
    return baseBackoff + jitter;
  }

  public async processQueue() {
    if (this.activeHandshakes >= CameraConnectionManager.MAX_CONCURRENT_HANDSHAKES || this.queue.length === 0) {
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

    let finished = false;
    const safetyTimer = setTimeout(() => {
      finishHandshake(false, 'RECONNECTION_TIMEOUT');
    }, 15000);

    const finishHandshake = (success: boolean, errorMsg?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(safetyTimer);
      this.activeHandshakes = Math.max(0, this.activeHandshakes - 1);

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
    };

    // 1. If explicit listener attached via .on('connectRequest', ...), dispatch to it
    if (this.listenerCount('connectRequest') > 0) {
      this.emit('connectRequest', cameraId, finishHandshake);
    } else if (this.customHandler) {
      // 2. If custom handler set via setReconnectionHandler, invoke it
      this.customHandler(cameraId)
        .then((res) => finishHandshake(res.success, res.error))
        .catch((err) => finishHandshake(false, err.message));
    } else {
      // 3. Default built-in reconnection handler: probes network socket & re-registers path with MediaMTX
      this.defaultReconnectionHandler(cameraId)
        .then((res) => finishHandshake(res.success, res.error))
        .catch((err) => finishHandshake(false, err.message));
    }
  }

  /**
   * Default production camera reconnection handler:
   * 1. Fetches camera from database
   * 2. Tests TCP reachability to camera RTSP port
   * 3. If reachable, re-asserts MediaMTX path configuration
   */
  public async defaultReconnectionHandler(cameraId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const camera = await prisma.camera.findUnique({
        where: { id: cameraId },
      });

      if (!camera) {
        return { success: false, error: `Camera ${cameraId} not found` };
      }

      // Check TCP socket reachability on camera RTSP or ONVIF port
      const targetPort = camera.rtspPort || 554;
      const targetHost = camera.ipAddress;

      const isReachable = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2500);

        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });

        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });

        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });

        socket.connect(targetPort, targetHost);
      });

      if (!isReachable) {
        return {
          success: false,
          error: `Camera ${camera.name} (${targetHost}:${targetPort}) unreachable on network`,
        };
      }

      // Camera is alive: re-assert / inject path configuration into MediaMTX
      let creds = '';
      if (camera.encryptedAuth) {
        try {
          const parsed = JSON.parse(decryptCredential(camera.encryptedAuth));
          if (parsed.username && parsed.password) {
            creds = `${encodeURIComponent(parsed.username)}:${encodeURIComponent(parsed.password)}@`;
          }
        } catch {
          // Fallback without credentials if decryption fails
        }
      }

      const rtspUrl =
        camera.mainRtspUri || `rtsp://${creds}${camera.ipAddress}:${camera.rtspPort || 554}/live`;

      await mediaProvider.createOrUpdateStream({
        path: camera.streamPath,
        sourceRtspUrl: rtspUrl,
        record: camera.desiredRecorderState !== 'STOPPED',
      });

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
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
    this.activeHandshakes = 0;
  }
}

export const cameraConnectionManager = CameraConnectionManager.getInstance();
export default cameraConnectionManager;

