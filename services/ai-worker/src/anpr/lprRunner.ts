import { EventEmitter } from 'events';
import { FrameExtractor, probeStreamResolution } from '../frameExtractor';
import { buildLoopbackRtspUrl } from '../rtspUrlBuilder';
import { AuthenticatedInternalApiClient as ApiClient } from '../apiClient';
import { AnprAdapterCore } from './anprAdapterCore';
import { AdapterError } from '../adapter/adapterCore';

/**
 * Runs ANPR on every camera the backend has in LPR mode (P4.1): frames come from the MediaMTX
 * loopback (single-RTSP-stream invariant), at the camera's configured rate, scaled to at most
 * maxWidth with the aspect ratio kept, so plate boxes map back to camera pixels exactly. A frame
 * arriving while the previous one is still being read is dropped (never queued without bound).
 * Recording never depends on this: a failing runner only affects plate reads.
 */
interface CamState {
  extractor: FrameExtractor | null;
  busy: boolean;
  key: string;
}

export class LprRunner extends EventEmitter {
  private cams = new Map<string, CamState>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private api: ApiClient, private core: AnprAdapterCore, private opts: { syncMs?: number; rtspPort?: number } = {}) {
    super();
  }

  async start() {
    await this.sync().catch((e) => this.emit('warn', `LPR camera sync failed: ${e.message}`));
    this.timer = setInterval(() => this.sync().catch((e) => this.emit('warn', `LPR camera sync failed: ${e.message}`)), this.opts.syncMs ?? 30000);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.cams.values()) s.extractor?.stop();
    this.cams.clear();
  }

  private async sync() {
    const cams = await this.api.getLprCameras();
    const wanted = new Set(cams.map((c) => c.cameraId));
    for (const [id, s] of this.cams) {
      if (!wanted.has(id)) {
        s.extractor?.stop();
        this.cams.delete(id);
      }
    }
    for (const c of cams as Array<{ cameraId: string; tenantId: string; streamPath: string; lpr: any }>) {
      const key = JSON.stringify(c.lpr ?? {});
      const cur = this.cams.get(c.cameraId);
      if (cur && cur.key === key) continue;
      cur?.extractor?.stop();
      const state: CamState = { extractor: null, busy: false, key };
      this.cams.set(c.cameraId, state);
      this.startCamera(c, state).catch((e) => {
        // Retried on the next sync: a camera that was not reachable yet must not stay dead.
        if (this.cams.get(c.cameraId) === state) state.key = '';
        this.emit('streamError', { cameraId: c.cameraId, error: e.message });
      });
    }
  }

  private async startCamera(c: { cameraId: string; tenantId: string; streamPath: string; lpr: any }, state: CamState) {
    const url = buildLoopbackRtspUrl(c.streamPath, this.opts.rtspPort);
    const src = await probeStreamResolution(url, 10000);
    const maxW = Math.min(c.lpr?.maxWidth ?? 1280, src.width);
    const width = maxW - (maxW % 2);
    let height = Math.round((src.height * width) / src.width);
    height -= height % 2;
    const fps = Math.max(0.5, Math.min(5, Number(c.lpr?.fps ?? 2)));
    const ex = new FrameExtractor({
      cameraId: c.cameraId,
      tenantId: c.tenantId,
      streamPath: c.streamPath,
      fps,
      width,
      height,
      sourceWidth: src.width,
      sourceHeight: src.height,
      letterbox: false,
      rtspPort: this.opts.rtspPort,
    });
    state.extractor = ex;
    const roi = Array.isArray(c.lpr?.roi) && c.lpr.roi.length === 4 ? (c.lpr.roi.map((v: number, i: number) => v * (i % 2 === 0 ? width : height)) as [number, number, number, number]) : undefined;
    ex.on('frame', async (frame: any) => {
      if (state.busy) {
        this.core.metrics.inc('vigilone_anpr_frames_dropped_total', 'LPR frames dropped because the previous read was still running');
        return;
      }
      state.busy = true;
      const ts = frame.sampledAt.toISOString();
      try {
        const r = await this.core.recognize({ data: new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.length), width, height }, ts, 5000, {
          roi,
          minConfidence: c.lpr?.minConfidence ?? 0.5,
        });
        if (r.plates.length === 0) return;
        await this.api.postAnprObservations({
          tenantId: c.tenantId,
          cameraId: c.cameraId,
          frameTimestampUtc: ts,
          plates: r.plates.map((p) => ({
            plateText: p.plate.normalized,
            rawText: p.rawText,
            confidence: Math.max(0, Math.min(1, p.confidence)),
            bbox: { x: p.box[0] / width, y: p.box[1] / height, width: (p.box[2] - p.box[0]) / width, height: (p.box[3] - p.box[1]) / height },
            lines: p.lines,
            format: p.plate.format,
          })),
          provenance: r.provenance,
        });
        this.emit('plates', { cameraId: c.cameraId, plates: r.plates.map((p) => p.plate.normalized) });
      } catch (e: any) {
        if (!(e instanceof AdapterError && e.code === 'OVERLOADED')) this.emit('inferenceError', { cameraId: c.cameraId, error: e.message });
      } finally {
        state.busy = false;
      }
    });
    ex.on('error', (e: Error) => this.emit('streamError', { cameraId: c.cameraId, error: e.message }));
    ex.on('exit', () => {
      // Restart on the next sync (the key is cleared so the camera is re-probed).
      if (this.cams.get(c.cameraId) === state) state.key = '';
    });
    ex.start();
  }
}
