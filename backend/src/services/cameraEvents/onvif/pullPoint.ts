import { EventEmitter } from 'events';
import { Credentials } from '../httpDigest';
import { soapCall, OnvifFault } from './soap';
import { parseNotificationMessages } from './notifications';
import { onvifUtcDateTime, skewFromCameraTime, SkewResult } from './clockSkew';

/**
 * ONVIF PullPoint event client (P3.1): GetSystemDateAndTime (clock skew) -> GetCapabilities
 * (event service address) -> CreatePullPointSubscription -> PullMessages loop with Renew before
 * termination -> Unsubscribe on stop. Emits 'skew', 'connected', 'event', 'heartbeat' (every
 * pull that returned, with or without messages), 'error'.
 */
export interface PullPointOptions {
  deviceServiceUrl: string;
  credentials: Credentials | null;
  pullTimeoutSeconds?: number;
  messageLimit?: number;
  terminationSeconds?: number;
  skewThresholdMs?: number;
}

const ACTIONS = {
  getSystemDateAndTime: 'http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime',
  getCapabilities: 'http://www.onvif.org/ver10/device/wsdl/GetCapabilities',
  createPullPoint: 'http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest',
  pull: 'http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest',
  renew: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest',
  unsubscribe: 'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest',
};

export class OnvifPullPointClient extends EventEmitter {
  private stopped = false;
  private skewMs = 0;
  private subscriptionUrl: string | null = null;
  private terminationAt = 0;

  constructor(private opts: PullPointOptions) {
    super();
  }

  private cameraNow(): Date {
    return new Date(Date.now() + this.skewMs);
  }

  async measureSkew(): Promise<SkewResult> {
    const t0 = Date.now();
    // GetSystemDateAndTime is callable without authentication (ONVIF Core); send none, so an
    // unknown skew cannot make the token itself invalid.
    const res = await soapCall(this.opts.deviceServiceUrl, '<tds:GetSystemDateAndTime/>', { creds: null, action: ACTIONS.getSystemDateAndTime });
    const t1 = Date.now();
    const cam = onvifUtcDateTime(res.body?.GetSystemDateAndTimeResponse?.SystemDateAndTime?.UTCDateTime);
    if (!cam) throw new OnvifFault('MALFORMED', 'GetSystemDateAndTime returned no UTCDateTime', false);
    const r = skewFromCameraTime(cam, t0, t1, this.opts.skewThresholdMs ?? 100);
    this.skewMs = r.estimateMs;
    this.emit('skew', r);
    return r;
  }

  async eventServiceUrl(): Promise<string> {
    const res = await soapCall(this.opts.deviceServiceUrl, '<tds:GetCapabilities><tds:Category>Events</tds:Category></tds:GetCapabilities>', {
      creds: this.opts.credentials,
      cameraNow: this.cameraNow(),
      action: ACTIONS.getCapabilities,
    });
    const x = res.body?.GetCapabilitiesResponse?.Capabilities?.Events?.XAddr;
    if (typeof x !== 'string' || !/^https?:\/\//.test(x)) throw new OnvifFault('NO_EVENT_SERVICE', 'camera advertises no ONVIF event service', true);
    return this.rebase(x);
  }

  /** Cameras behind NAT often advertise their internal address; keep the configured host. */
  private rebase(advertised: string): string {
    const a = new URL(advertised);
    const d = new URL(this.opts.deviceServiceUrl);
    a.protocol = d.protocol;
    a.host = d.host;
    return a.toString();
  }

  async subscribe(eventUrl: string): Promise<void> {
    const term = this.opts.terminationSeconds ?? 60;
    const res = await soapCall(eventUrl, `<tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT${term}S</tev:InitialTerminationTime></tev:CreatePullPointSubscription>`, {
      creds: this.opts.credentials,
      cameraNow: this.cameraNow(),
      action: ACTIONS.createPullPoint,
      to: eventUrl,
    });
    const r = res.body?.CreatePullPointSubscriptionResponse;
    const addr = r?.SubscriptionReference?.Address;
    if (typeof addr !== 'string') throw new OnvifFault('MALFORMED', 'CreatePullPointSubscription returned no subscription address', false);
    this.subscriptionUrl = this.rebase(addr);
    this.setTermination(r?.TerminationTime, r?.CurrentTime, term);
  }

  private setTermination(termination: any, current: any, fallbackSeconds: number) {
    const t = Date.parse(String(termination ?? ''));
    const c = Date.parse(String(current ?? ''));
    // Relative to the camera's own CurrentTime when it reports both, so clock skew cancels out.
    this.terminationAt = Number.isFinite(t) && Number.isFinite(c) ? Date.now() + (t - c) : Date.now() + fallbackSeconds * 1000;
  }

  private async renewIfDue(): Promise<void> {
    if (!this.subscriptionUrl || this.terminationAt - Date.now() > 20_000) return;
    const term = this.opts.terminationSeconds ?? 60;
    const res = await soapCall(this.subscriptionUrl, `<wsnt:Renew><wsnt:TerminationTime>PT${term}S</wsnt:TerminationTime></wsnt:Renew>`, {
      creds: this.opts.credentials,
      cameraNow: this.cameraNow(),
      action: ACTIONS.renew,
      to: this.subscriptionUrl,
    });
    this.setTermination(res.body?.RenewResponse?.TerminationTime, res.body?.RenewResponse?.CurrentTime, term);
  }

  async pullOnce(): Promise<number> {
    if (!this.subscriptionUrl) throw new Error('not subscribed');
    const timeout = this.opts.pullTimeoutSeconds ?? 10;
    const res = await soapCall(
      this.subscriptionUrl,
      `<tev:PullMessages><tev:Timeout>PT${timeout}S</tev:Timeout><tev:MessageLimit>${this.opts.messageLimit ?? 50}</tev:MessageLimit></tev:PullMessages>`,
      { creds: this.opts.credentials, cameraNow: this.cameraNow(), action: ACTIONS.pull, to: this.subscriptionUrl, timeoutMs: (timeout + 10) * 1000 }
    );
    const r = res.body?.PullMessagesResponse;
    if (!r) throw new OnvifFault('MALFORMED', 'PullMessages returned no PullMessagesResponse', false);
    if (r.TerminationTime) this.setTermination(r.TerminationTime, r.CurrentTime, this.opts.terminationSeconds ?? 60);
    const events = parseNotificationMessages(r);
    this.emit('heartbeat');
    for (const e of events) this.emit('event', e);
    return events.length;
  }

  /** Runs until stop() or an error (the caller reconnects with backoff). */
  async start(): Promise<void> {
    this.stopped = false;
    await this.measureSkew();
    const eventUrl = await this.eventServiceUrl();
    await this.subscribe(eventUrl);
    this.emit('connected');
    while (!this.stopped) {
      await this.pullOnce();
      await this.renewIfDue();
    }
    await this.unsubscribe();
  }

  async unsubscribe(): Promise<void> {
    if (!this.subscriptionUrl) return;
    const url = this.subscriptionUrl;
    this.subscriptionUrl = null;
    await soapCall(url, '<wsnt:Unsubscribe/>', { creds: this.opts.credentials, cameraNow: this.cameraNow(), action: ACTIONS.unsubscribe, to: url, timeoutMs: 5000 }).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
  }
}
