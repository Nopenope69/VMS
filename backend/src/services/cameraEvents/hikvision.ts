import { EventEmitter } from 'events';
import { parseStringPromise, processors } from 'xml2js';
import { digestRequest, Credentials } from './httpDigest';
import { boundaryFromContentType, MultipartStreamParser } from './multipart';
import { NormalizedCameraEvent } from './types';

/**
 * Hikvision ISAPI alert stream (P3.2): GET /ISAPI/Event/notification/alertStream is a
 * long-lived multipart/mixed response; each XML part is an EventNotificationAlert
 * (namespace http://www.hikvision.com/ver20/XMLSchema). Image and JSON parts are skipped.
 * Devices send "videoloss / inactive" alerts as a keep-alive: those count as heartbeats, not
 * events. Event-type names follow the vendor strings seen in the field (cross-checked with the
 * MIT-licensed pyHik SENSOR_MAP).
 */
const HIK_TYPES: Record<string, string> = {
  vmd: 'MOTION',
  linedetection: 'LINE_CROSSING',
  fielddetection: 'INTRUSION',
  regionentrance: 'REGION_ENTRANCE',
  regionexiting: 'REGION_EXIT',
  loitering: 'LOITERING',
  tamperdetection: 'TAMPER',
  shelteralarm: 'TAMPER',
  defocus: 'DEFOCUS',
  videoloss: 'VIDEO_LOSS',
  scenechangedetection: 'SCENE_CHANGE',
  io: 'DIGITAL_INPUT',
  facedetection: 'FACE',
  unattendedbaggage: 'OBJECT_LEFT',
  attendedbaggage: 'OBJECT_REMOVED',
  audioexception: 'AUDIO',
  pir: 'MOTION',
};

export interface HikParseResult {
  heartbeat: boolean;
  event: NormalizedCameraEvent | null;
}

const text = (v: any): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'object' ? (v._ ?? undefined) : String(v));

export async function parseHikvisionAlert(xml: string): Promise<HikParseResult> {
  const doc = await parseStringPromise(xml, { explicitArray: false, tagNameProcessors: [processors.stripPrefix], attrkey: '$' });
  const a = doc?.EventNotificationAlert;
  if (!a) throw new Error('not an EventNotificationAlert document');
  const vendorType = String(text(a.eventType) || '').trim();
  const stateStr = String(text(a.eventState) || '').trim().toLowerCase();
  const key = vendorType.toLowerCase();
  if (key === 'videoloss' && stateStr === 'inactive') return { heartbeat: true, event: null };
  const channel = Number(text(a.channelID) ?? text(a.dynChannelID) ?? text(a.channelIndex));
  const t = text(a.dateTime);
  const when = t ? new Date(t) : null;
  const region = a.DetectionRegionList?.DetectionRegionEntry;
  const firstRegion = Array.isArray(region) ? region[0] : region;
  const target = text(firstRegion?.detectionTarget) ?? text(a.targetType);
  return {
    heartbeat: false,
    event: {
      protocol: 'HIKVISION_ISAPI',
      analyticType: HIK_TYPES[key] ?? 'VENDOR_OTHER',
      // Hikvision reports active / inactive; alerts without a state are instantaneous.
      state: stateStr === 'active' ? true : stateStr === 'inactive' ? false : null,
      vendorTopic: vendorType,
      cameraTimeUtc: when && !isNaN(when.getTime()) ? when : null,
      ...(Number.isFinite(channel) ? { channel } : {}),
      ...(text(firstRegion?.regionID) ? { ruleName: `region ${text(firstRegion?.regionID)}` } : {}),
      ...(target ? { objectType: target } : {}),
      raw: { eventDescription: text(a.eventDescription), activePostCount: text(a.activePostCount) },
    },
  };
}

export interface StreamClientOptions {
  baseUrl: string;
  credentials: Credentials | null;
  /** Reconnect when nothing (event or heartbeat) arrived for this long. */
  idleTimeoutMs?: number;
}

/**
 * Emits 'event' (NormalizedCameraEvent), 'heartbeat', 'error' and 'end'. One connection per
 * start(); the caller (CameraEventManager) owns reconnect and backoff.
 */
export class HikvisionAlertStream extends EventEmitter {
  private ctl = new AbortController();

  constructor(private opts: StreamClientOptions) {
    super();
  }

  async start(): Promise<void> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/ISAPI/Event/notification/alertStream`;
    const res = await digestRequest(url, this.opts.credentials, { signal: this.ctl.signal, idleTimeoutMs: this.opts.idleTimeoutMs ?? 90000, timeoutMs: 10000 });
    const boundary = boundaryFromContentType(res.headers['content-type']);
    if (!boundary) {
      res.destroy();
      throw new Error(`alertStream answered ${res.headers['content-type']} without a multipart boundary`);
    }
    const parser = new MultipartStreamParser(boundary, (part) => {
      const ct = (part.headers['content-type'] || '').toLowerCase();
      if (ct && !ct.includes('xml')) return; // snapshots and JSON attachments
      const body = part.body.toString('utf8');
      if (!body.includes('EventNotificationAlert')) return;
      parseHikvisionAlert(body)
        .then((r) => (r.heartbeat ? this.emit('heartbeat') : r.event && this.emit('event', r.event)))
        .catch((e) => this.emit('parse_error', e));
    });
    this.emit('connected');
    await new Promise<void>((resolve, reject) => {
      res.on('data', (c: Buffer) => {
        try {
          parser.feed(c);
        } catch (e) {
          res.destroy(e as Error);
        }
      });
      res.on('end', () => resolve());
      res.on('error', (e) => (this.ctl.signal.aborted ? resolve() : reject(e)));
      res.on('close', () => resolve());
    });
  }

  stop(): void {
    this.ctl.abort();
  }
}
