// Recording-segment analysis shared by fault drills, soak and acceptance.
// MediaMTX names segments %Y-%m-%d_%H-%M-%S-%f (UTC, microseconds), see mediamtx.yml recordPath.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';

const NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})\.mp4$/;

export function parseSegmentStart(fileName) {
  const m = NAME.exec(fileName);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, us] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + Math.floor(+us / 1000);
}

export async function probeDurationSec(file) {
  const r = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeoutMs: 60000 });
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

/**
 * Lists segments in a camera directory with start (from the file name) and end (start + probed
 * duration). Unreadable segments get durationSec=null and count as coverage holes.
 */
export async function listSegments(dir, { sinceMs = 0, untilMs = Infinity } = {}) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const startMs = parseSegmentStart(f);
    if (startMs === null || startMs < sinceMs - 15 * 60 * 1000 || startMs > untilMs) continue;
    const full = path.join(dir, f);
    const durationSec = await probeDurationSec(full);
    out.push({ file: f, startMs, endMs: durationSec === null ? startMs : startMs + durationSec * 1000, durationSec, sizeBytes: fs.statSync(full).size });
  }
  return out;
}

/** Gaps between consecutive segments (and at the window edges) longer than thresholdSec. */
export function findGaps(segments, { thresholdSec = 5, windowStartMs, windowEndMs } = {}) {
  const gaps = [];
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  let cursor = windowStartMs ?? (sorted[0]?.startMs ?? 0);
  for (const s of sorted) {
    if (s.endMs <= cursor) continue;
    if (s.startMs - cursor > thresholdSec * 1000) gaps.push({ fromMs: cursor, toMs: s.startMs, seconds: (s.startMs - cursor) / 1000 });
    cursor = Math.max(cursor, s.endMs);
  }
  if (windowEndMs !== undefined && windowEndMs - cursor > thresholdSec * 1000) {
    gaps.push({ fromMs: cursor, toMs: windowEndMs, seconds: (windowEndMs - cursor) / 1000 });
  }
  return gaps;
}

// CLI: node scripts/lib/segments.mjs gaps <cameraDir> [--since ISO] [--until ISO] [--threshold 5]
if (process.argv[1] && process.argv[1].endsWith('segments.mjs') && process.argv[2] === 'gaps') {
  const dir = process.argv[3];
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const sinceMs = arg('--since') ? Date.parse(arg('--since')) : undefined;
  const untilMs = arg('--until') ? Date.parse(arg('--until')) : undefined;
  const segs = await listSegments(dir, { sinceMs: sinceMs ?? 0, untilMs: untilMs ?? Infinity });
  const gaps = findGaps(segs, { thresholdSec: Number(arg('--threshold') || 5), windowStartMs: sinceMs, windowEndMs: untilMs });
  const maxGapSec = gaps.reduce((m, g) => Math.max(m, g.seconds), 0);
  console.log(JSON.stringify({ dir, segments: segs.length, unreadable: segs.filter((s) => s.durationSec === null).length, maxGapSec, gaps }, null, 2));
}
