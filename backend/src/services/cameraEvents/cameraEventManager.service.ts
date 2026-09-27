import { PrismaClient } from '@prisma/client';
import { EventEmitter } from 'events';
import { decryptCredential } from '../../utils/crypto';
import { MetricsService } from '../observability/metrics.service';
import { createVigilOneEvent } from '../incident/orchestrator/events';
import type { VigilOneEvent, CameraAnalyticPayload } from '../incident/orchestrator/types';
import { Credentials, CameraHttpError } from './httpDigest';
import { HikvisionAlertStream } from './hikvision';
import { DahuaEventStream } from './dahua';
import { OnvifPullPointClient } from './onvif/pullPoint';
import { OnvifFault } from './onvif/soap';
import type { SkewResult } from './onvif/clockSkew';
import { CameraEventProtocol, NormalizedCameraEvent } from './types';

/**
 * Supervises camera-native event feeds (P3.1/P3.2), one runner per enabled CameraEventSource:
 * connect -> RUNNING -> on error BACKOFF (1 s doubling to 60 s) -> reconnect; a permanent error
 * (bad credentials, unsupported device) -> FAILED until the source is changed. Vendor streams
 * repeat "active" while a condition lasts; the manager emits transitions only, so one intrusion
 * is one event. Only runs when VIGILONE_FEATURE_CAMERA_EVENTS is on (server.ts).
 */
export interface StreamClient extends EventEmitter {
  start(): Promise<void>;
  stop(): void;
}

export interface SourceTarget {
  protocol: CameraEventProtocol;
  baseUrl: string;
  credentials: Credentials | null;
}

export type ClientFactory = (t: SourceTarget) => StreamClient;

export const defaultClientFactory: ClientFactory = (t) => {
  switch (t.protocol) {
    case 'ONVIF_PULLPOINT':
      return new OnvifPullPointClient({ deviceServiceUrl: `${t.baseUrl}/onvif/device_service`, credentials: t.credentials });
    case 'HIKVISION_ISAPI':
      return new HikvisionAlertStream({ baseUrl: t.baseUrl, credentials: t.credentials });
    case 'DAHUA_EVENT_MANAGER':
      return new DahuaEventStream({ baseUrl: t.baseUrl, credentials: t.credentials });
  }
};

export type Ingest = (ev: VigilOneEvent) => Promise<unknown>;

interface Runner {
  sourceId: string;
  version: string;
  client: StreamClient | null;
  stopped: boolean;
  skew: SkewResult | null;
  lastState: Map<string, { state: boolean | null; at: number }>;
}

const MAX_BACKOFF_MS = 60_000;
/** Hikvision repeats "active" about once a second; without a repeat for this long the condition ended. */
const STALE_ACTIVE_MS = 10_000;
/** Instantaneous events (state null) with the same key closer than this are one event. */
const INSTANT_DEDUP_MS = 1_000;

export class CameraEventManager {
  private runners = new Map<string, Runner>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private prisma: PrismaClient,
    private ingest: Ingest,
    private factory: ClientFactory = defaultClientFactory,
    private backoffBaseMs = 1000
  ) {}

  start(reconcileMs = 15000): void {
    if (this.timer) return;
    const tick = () => this.reconcile().catch((e) => console.error('[CameraEvents] reconcile failed:', e.message));
    tick();
    this.timer = setInterval(tick, reconcileMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const id of [...this.runners.keys()]) await this.stopRunner(id, 'STOPPED');
  }

  /** In-memory detail for the API (skew interval, not only the stored estimate). */
  runtime(sourceId: string): { skew: SkewResult | null } | null {
    const r = this.runners.get(sourceId);
    return r ? { skew: r.skew } : null;
  }

  async reconcile(): Promise<void> {
    const sources = await this.prisma.cameraEventSource.findMany({ where: { enabled: true } });
    const wanted = new Map(sources.map((s) => [s.id, s]));
    for (const id of [...this.runners.keys()]) {
      const s = wanted.get(id);
      if (!s || s.updatedAt.toISOString() !== this.runners.get(id)!.version) await this.stopRunner(id, s ? 'STOPPED' : null);
    }
    for (const s of sources) {
      if (this.runners.has(s.id)) continue;
      // A FAILED source stays failed until someone changes it (updatedAt moves on edit).
      if (s.status === 'FAILED') continue;
      const runner: Runner = { sourceId: s.id, version: s.updatedAt.toISOString(), client: null, stopped: false, skew: null, lastState: new Map() };
      this.runners.set(s.id, runner);
      this.run(runner).catch((e) => console.error(`[CameraEvents] runner ${s.id} crashed:`, e));
    }
    MetricsService.setGauge('vigilone_camera_event_sources_running', 'Camera event sources with a live runner', undefined, this.runners.size);
  }

  private async stopRunner(id: string, status: string | null) {
    const r = this.runners.get(id);
    if (!r) return;
    r.stopped = true;
    r.client?.stop();
    this.runners.delete(id);
    if (status) await this.setStatus(id, { status }).catch(() => undefined);
  }

  private async setStatus(id: string, data: Record<string, unknown>) {
    await this.prisma.cameraEventSource.update({ where: { id }, data });
  }

  private async target(sourceId: string) {
    const s = await this.prisma.cameraEventSource.findUnique({ where: { id: sourceId }, include: { camera: true } });
    if (!s) return null;
    let credentials: Credentials | null = null;
    if (s.camera.encryptedAuth) {
      const parsed = JSON.parse(decryptCredential(s.camera.encryptedAuth));
      if (parsed?.username) credentials = { username: String(parsed.username), password: String(parsed.password ?? '') };
    }
    const host = s.camera.ipAddress.includes(':') && !s.camera.ipAddress.startsWith('[') ? `[${s.camera.ipAddress}]` : s.camera.ipAddress;
    return { source: s, target: { protocol: s.protocol as CameraEventProtocol, baseUrl: `http://${host}:${s.camera.onvifPort}`, credentials } };
  }

  private async run(r: Runner): Promise<void> {
    let attempt = 0;
    while (!r.stopped) {
      const t = await this.target(r.sourceId);
      if (!t) return;
      const { source, target } = t;
      const labels = { protocol: target.protocol };
      await this.setStatus(r.sourceId, { status: attempt === 0 ? 'CONNECTING' : 'BACKOFF' }).catch(() => undefined);
      const client = this.factory(target);
      r.client = client;
      let connectedAt = 0;
      client.on('connected', () => {
        connectedAt = Date.now();
        this.setStatus(r.sourceId, { status: 'RUNNING', lastError: null }).catch(() => undefined);
        MetricsService.incCounter('vigilone_camera_event_connects_total', 'Camera event stream connections established', labels);
      });
      client.on('skew', (s: SkewResult) => {
        r.skew = s;
        MetricsService.setGauge('vigilone_camera_clock_skew_ms', 'Camera clock minus appliance clock (estimate)', { source_id: r.sourceId }, s.estimateMs);
        if (s.verdict === 'DRIFT') {
          MetricsService.incCounter('vigilone_camera_clock_drift_warnings_total', 'Camera clocks off by more than the threshold', labels);
          console.warn(`[CameraEvents] camera ${source.cameraId} clock is off by ${s.lowerMs}..${s.upperMs} ms (threshold ${s.thresholdMs} ms); check NTP`);
        }
        this.setStatus(r.sourceId, { clockSkewMs: s.estimateMs }).catch(() => undefined);
      });
      client.on('event', (e: NormalizedCameraEvent) => {
        this.handle(r, source.tenantId, source.cameraId, e).catch((err) => console.error('[CameraEvents] ingest failed:', err.message));
      });
      client.on('parse_error', () => MetricsService.incCounter('vigilone_camera_event_parse_errors_total', 'Camera event parts that could not be parsed', labels));
      let error: any = null;
      try {
        await client.start();
      } catch (e) {
        error = e;
      }
      r.client = null;
      if (r.stopped) return;
      const permanent = (error instanceof CameraHttpError || error instanceof OnvifFault) && error.permanent;
      const message = error ? String(error.message).slice(0, 500) : 'stream ended';
      MetricsService.incCounter('vigilone_camera_event_disconnects_total', 'Camera event stream disconnects', { ...labels, permanent: String(permanent) });
      if (permanent) {
        await this.setStatus(r.sourceId, { status: 'FAILED', lastError: message }).catch(() => undefined);
        this.runners.delete(r.sourceId);
        return;
      }
      // A connection that stayed up for a minute resets the backoff.
      attempt = connectedAt && Date.now() - connectedAt > 60_000 ? 1 : attempt + 1;
      await this.setStatus(r.sourceId, { status: 'BACKOFF', lastError: message }).catch(() => undefined);
      const delay = Math.min(MAX_BACKOFF_MS, this.backoffBaseMs * 2 ** Math.min(attempt - 1, 10));
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  /** Transition filter + orchestrator ingestion. Exposed for tests. */
  async handle(r: Runner | { lastState: Map<string, { state: boolean | null; at: number }> }, tenantId: string, cameraId: string, e: NormalizedCameraEvent): Promise<boolean> {
    const now = Date.now();
    const key = [e.protocol, e.analyticType, e.vendorTopic, e.channel ?? '', e.ruleName ?? ''].join('|');
    const prev = r.lastState.get(key);
    if (e.state === null) {
      if (prev && now - prev.at < INSTANT_DEDUP_MS) return false;
    } else if (prev && prev.state === e.state) {
      const stale = e.state === true && now - prev.at > STALE_ACTIVE_MS;
      prev.at = now;
      if (!stale) return false;
    } else if (!prev && e.state === false) {
      // A stop without a known start (e.g. right after connecting) carries no information.
      r.lastState.set(key, { state: false, at: now });
      return false;
    }
    r.lastState.set(key, { state: e.state, at: now });
    const payload: CameraAnalyticPayload = {
      kind: 'CAMERA_ANALYTIC',
      protocol: e.protocol,
      analyticType: e.analyticType,
      state: e.state,
      vendorTopic: e.vendorTopic,
      ...(e.ruleName ? { ruleName: e.ruleName } : {}),
      ...(e.objectType ? { objectType: e.objectType } : {}),
      ...(e.channel !== undefined ? { channel: e.channel } : {}),
      ...(e.cameraTimeUtc ? { cameraTimeUtc: e.cameraTimeUtc.toISOString() } : {}),
    };
    const ev = createVigilOneEvent({
      tenantId,
      cameraId,
      source: 'CAMERA_ANALYTICS',
      type: 'CAMERA_ANALYTIC',
      severity: 'INFO',
      title: `Camera ${e.analyticType.toLowerCase().replace(/_/g, ' ')}${e.state === true ? ' started' : e.state === false ? ' ended' : ''}`,
      payload,
    } as any);
    MetricsService.incCounter('vigilone_camera_events_total', 'Camera analytic events ingested', { protocol: e.protocol, analytic_type: e.analyticType });
    await this.ingest(ev);
    if ('sourceId' in r) await this.setStatus((r as Runner).sourceId, { lastEventAt: new Date(now) }).catch(() => undefined);
    return true;
  }
}
