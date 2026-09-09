import api from './api';

export interface WhepConnectionOptions {
  cameraId: string;
  videoElement: HTMLVideoElement;
  onStatusChange?: (status: 'connecting' | 'connected' | 'reconnecting' | 'failed') => void;
  onError?: (err: Error) => void;
}

export class WhepClient {
  private peerConnection: RTCPeerConnection | null = null;
  private isDestroyed = false;
  private reconnectTimer: any = null;
  private options: WhepConnectionOptions;

  constructor(options: WhepConnectionOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.isDestroyed) return;

    this.options.onStatusChange?.('connecting');

    try {
      // 1. Fetch fresh short-lived media token and dynamic ICE config from backend
      const [tokenRes, iceRes] = await Promise.all([
        api.post(`/cameras/${this.options.cameraId}/media-token`),
        api.get('/webrtc/ice-config').catch(() => ({ data: { iceServers: [] } })),
      ]);
      const { token, whepUrl } = tokenRes.data;
      const iceServers = iceRes.data?.iceServers?.length > 0 ? iceRes.data.iceServers : undefined;

      // 2. Initialize RTCPeerConnection with dynamic appliance ICE configuration
      const pc = new RTCPeerConnection({
        iceServers,
      });
      this.peerConnection = pc;

      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.ontrack = (event) => {
        if (this.options.videoElement && event.streams[0]) {
          this.options.videoElement.srcObject = event.streams[0];
          this.options.videoElement.play().catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (this.isDestroyed) return;

        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
          this.options.onStatusChange?.('connected');
        } else if (state === 'disconnected' || state === 'failed') {
          this.options.onStatusChange?.('reconnecting');
          this.scheduleReconnect();
        }
      };

      // 3. Create SDP Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 4. Send Offer to MediaMTX WHEP endpoint with Bearer token
      const response = await fetch(whepUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: `Bearer ${token}`,
        },
        body: offer.sdp,
      });

      if (!response.ok) {
        throw new Error(`WHEP endpoint returned status ${response.status}: ${await response.text()}`);
      }

      // 5. Set SDP Answer
      const answerSdp = await response.text();
      await pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });
    } catch (err: any) {
      if (this.isDestroyed) return;
      this.options.onError?.(err);
      this.options.onStatusChange?.('reconnecting');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isDestroyed) return;

      this.cleanupPeerConnection();
      await this.start();
    }, 3000); // Reconnect after 3 seconds with a freshly minted token
  }

  private cleanupPeerConnection() {
    if (this.peerConnection) {
      this.peerConnection.ontrack = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }
  }

  destroy() {
    this.isDestroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanupPeerConnection();
  }
}
