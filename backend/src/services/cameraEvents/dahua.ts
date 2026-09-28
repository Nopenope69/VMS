import { EventEmitter } from 'events';
import { digestRequest } from './httpDigest';
import { boundaryFromContentType, MultipartStreamParser } from './multipart';
import { NormalizedCameraEvent } from './types';
import type { StreamClientOptions } from './hikvision';

/**
 * Dahua event manager (P3.2): GET /cgi-bin/eventManager.cgi?action=attach&codes=[All]&heartbeat=N
 * answers multipart/x-mixed-replace (boundary usually "myboundary"). Each part is text like
 *   Code=VideoMotion;action=Start;index=0;data={"RegionName":["Region1"]}
 * and "Heartbeat" parts arrive every N seconds. `data=` is taken as the rest of the part (it
 * is JSON and may itself contain ';'), unlike parsers that split the whole line on ';'.
 */
const DAHUA_TYPES: Record<string, string> = {
  VideoMotion: 'MOTION',
  SmartMotionHuman: 'PERSON',
  SmartMotionVehicle: 'VEHICLE',
  CrossLineDetection: 'LINE_CROSSING',
  CrossRegionDetection: 'INTRUSION',
  LeftDetection: 'OBJECT_LEFT',
  TakenAwayDetection: 'OBJECT_REMOVED',
  WanderDetection: 'LOITERING',
  VideoBlind: 'TAMPER',
  VideoLoss: 'VIDEO_LOSS',
  SceneChange: 'SCENE_CHANGE',
  VideoAbnormalDetection: 'SCENE_CHANGE',
  AlarmLocal: 'DIGITAL_INPUT',
  FaceDetection: 'FACE',
  AudioMutation: 'AUDIO',
  AudioAnomaly: 'AUDIO',
};

export interface DahuaParsed {
  heartbeat: boolean;
  events: NormalizedCameraEvent[];
}

export function parseDahuaEventText(textIn: string): DahuaParsed {
  const t = textIn.trim();
  if (/^Heartbeat\b/i.test(t)) return { heartbeat: true, events: [] };
  const events: NormalizedCameraEvent[] = [];
  // A part may carry several events on separate lines ("Code=..." each).
  const blocks = t.split(/\r?\n(?=Code=)/);
  for (const block of blocks) {
    const start = block.indexOf('Code=');
    if (start < 0) continue;
    let rest = block.slice(start);
    let dataJson: unknown = undefined;
    const d = rest.indexOf(';data=');
    if (d >= 0) {
      const raw = rest.slice(d + 6).trim();
      rest = rest.slice(0, d);
      try {
        dataJson = JSON.parse(raw);
      } catch {
        dataJson = raw;
      }
    }
    const kv: Record<string, string> = {};
    for (const pair of rest.split(';')) {
      const i = pair.indexOf('=');
      if (i > 0) kv[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    const code = kv.Code;
    if (!code) continue;
    const action = (kv.action || '').toLowerCase();
    const data: any = dataJson && typeof dataJson === 'object' ? dataJson : {};
    const ruleName = typeof data.Name === 'string' ? data.Name : Array.isArray(data.RegionName) ? String(data.RegionName[0]) : undefined;
    const objectType = typeof data.Object?.ObjectType === 'string' ? data.Object.ObjectType : undefined;
    const index = Number(kv.index);
    const utc = typeof data.UTC === 'number' ? new Date(data.UTC * 1000) : null;
    events.push({
      protocol: 'DAHUA_EVENT_MANAGER',
      analyticType: DAHUA_TYPES[code] ?? 'VENDOR_OTHER',
      state: action === 'start' ? true : action === 'stop' ? false : null,
      vendorTopic: code,
      // Dahua's data.UTC is device local time expressed as epoch seconds on many firmwares, so
      // it is not trusted as UTC; the appliance receive time is used for the event.
      cameraTimeUtc: null,
      ...(Number.isFinite(index) ? { channel: index } : {}),
      ...(ruleName ? { ruleName } : {}),
      ...(objectType ? { objectType } : {}),
      raw: { action: kv.action, ...(utc ? { deviceUTCField: data.UTC } : {}) },
    });
  }
  return { heartbeat: false, events };
}

export class DahuaEventStream extends EventEmitter {
  private ctl = new AbortController();

  constructor(private opts: StreamClientOptions & { heartbeatSeconds?: number }) {
    super();
  }

  async start(): Promise<void> {
    const hb = this.opts.heartbeatSeconds ?? 5;
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/cgi-bin/eventManager.cgi?action=attach&codes=%5BAll%5D&heartbeat=${hb}`;
    const res = await digestRequest(url, this.opts.credentials, { signal: this.ctl.signal, idleTimeoutMs: this.opts.idleTimeoutMs ?? Math.max(30000, hb * 4000), timeoutMs: 10000 });
    const boundary = boundaryFromContentType(res.headers['content-type']) || 'myboundary';
    const parser = new MultipartStreamParser(boundary, (part) => {
      const r = parseDahuaEventText(part.body.toString('utf8'));
      if (r.heartbeat) this.emit('heartbeat');
      for (const e of r.events) this.emit('event', e);
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
