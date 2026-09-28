import fs from 'fs';
import path from 'path';
import { parseXml } from './soap';

/**
 * ONVIF analytics metadata (tt:MetadataStream / tt:VideoAnalytics / tt:Frame, as streamed by
 * Profile M devices on the RTSP metadata track) -> normalised object frames, plus an
 * append-only JSONL archive. Live capture of the RTSP metadata track is not implemented yet
 * (docs/BACKLOG.md); this module parses and stores documents it is given.
 *
 * Coordinates: ONVIF uses a normalised space x, y in [-1, 1] with y pointing up; a Frame may
 * carry a tt:Transformation (Translate, Scale) mapping object coordinates into that space.
 * Output boxes are [0,1] with origin top-left, as everywhere else in VigilOne.
 */
export interface MetadataObject {
  objectId: string;
  bbox: { x: number; y: number; width: number; height: number } | null;
  classes: Array<{ type: string; likelihood: number | null }>;
}

export interface MetadataFrame {
  utcTime: string;
  objects: MetadataObject[];
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const num = (v: any): number => Number(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function classesOf(cls: any): MetadataObject['classes'] {
  if (!cls) return [];
  const out: MetadataObject['classes'] = [];
  // ONVIF 2.x: <tt:ClassCandidate><tt:Type>Human</tt:Type><tt:Likelihood>0.8</tt:Likelihood></tt:ClassCandidate>
  for (const c of arr(cls.ClassCandidate)) {
    const type = typeof c?.Type === 'string' ? c.Type : c?.Type?._;
    if (type) out.push({ type, likelihood: c?.Likelihood !== undefined ? num(c.Likelihood) : null });
  }
  // Newer schema: <tt:Type Likelihood="0.8">Human</tt:Type>
  for (const t of arr(cls.Type)) {
    const type = typeof t === 'string' ? t : t?._;
    if (type) out.push({ type, likelihood: t?.$?.Likelihood !== undefined ? num(t.$.Likelihood) : null });
  }
  return out;
}

export async function parseMetadataStream(xml: string): Promise<MetadataFrame[]> {
  const doc = await parseXml(xml);
  const root = doc?.MetadataStream;
  if (!root) throw new Error('not a tt:MetadataStream document');
  const frames: MetadataFrame[] = [];
  for (const va of arr(root.VideoAnalytics)) {
    for (const f of arr((va as any).Frame)) {
      const fr: any = f;
      const utc = fr?.$?.UtcTime;
      if (!utc || isNaN(Date.parse(utc))) continue;
      const tr = fr.Transformation;
      const tx = tr?.Translate?.$ ? num(tr.Translate.$.x) : 0;
      const ty = tr?.Translate?.$ ? num(tr.Translate.$.y) : 0;
      const sx = tr?.Scale?.$ ? num(tr.Scale.$.x) : 1;
      const sy = tr?.Scale?.$ ? num(tr.Scale.$.y) : 1;
      const objects: MetadataObject[] = [];
      for (const o of arr(fr.Object)) {
        const ob: any = o;
        const bb = ob?.Appearance?.Shape?.BoundingBox?.$;
        let bbox: MetadataObject['bbox'] = null;
        if (bb) {
          const left = num(bb.left) * sx + tx;
          const right = num(bb.right) * sx + tx;
          const top = num(bb.top) * sy + ty;
          const bottom = num(bb.bottom) * sy + ty;
          if ([left, right, top, bottom].every(Number.isFinite)) {
            const x0 = clamp01((Math.min(left, right) + 1) / 2);
            const x1 = clamp01((Math.max(left, right) + 1) / 2);
            const y0 = clamp01((1 - Math.max(top, bottom)) / 2);
            const y1 = clamp01((1 - Math.min(top, bottom)) / 2);
            bbox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
          }
        }
        objects.push({ objectId: String(ob?.$?.ObjectId ?? ''), bbox, classes: classesOf(ob?.Appearance?.Class) });
      }
      frames.push({ utcTime: new Date(utc).toISOString(), objects });
    }
  }
  return frames;
}

/** Append-only archive: <dir>/<cameraId>/<YYYY-MM-DD>.jsonl, one frame per line. */
export class MetadataArchive {
  constructor(private dir: string, private retentionDays = 30) {}

  async append(cameraId: string, frames: MetadataFrame[]): Promise<number> {
    if (!/^[A-Za-z0-9_-]+$/.test(cameraId)) throw new Error('invalid cameraId for archive path');
    const byDay = new Map<string, string[]>();
    for (const f of frames) {
      const day = f.utcTime.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) || []), JSON.stringify({ cameraId, ...f })]);
    }
    const camDir = path.join(this.dir, cameraId);
    await fs.promises.mkdir(camDir, { recursive: true });
    for (const [day, lines] of byDay) await fs.promises.appendFile(path.join(camDir, `${day}.jsonl`), lines.join('\n') + '\n');
    return frames.length;
  }

  async prune(now = new Date()): Promise<string[]> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 86400_000).toISOString().slice(0, 10);
    const removed: string[] = [];
    if (!fs.existsSync(this.dir)) return removed;
    for (const cam of await fs.promises.readdir(this.dir)) {
      for (const f of await fs.promises.readdir(path.join(this.dir, cam)).catch(() => [] as string[])) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < cutoff) {
          await fs.promises.unlink(path.join(this.dir, cam, f));
          removed.push(path.join(cam, f));
        }
      }
    }
    return removed;
  }
}
