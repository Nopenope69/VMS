// ffprobe/ffmpeg helpers for bench and soak.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { run } from './proc.mjs';

const parseRate = (r) => {
  if (!r || r === '0/0') return null;
  const [n, d] = r.split('/').map(Number);
  return d ? n / d : n;
};

export async function probeRtsp(url, timeoutMs = 20000) {
  const r = await run(
    'ffprobe',
    ['-v', 'error', '-rtsp_transport', 'tcp', '-show_streams', '-show_format', '-of', 'json', url],
    { timeoutMs }
  );
  if (r.code !== 0) return { ok: false, error: (r.timedOut ? 'TIMEOUT ' : '') + r.stderr.trim().slice(0, 500) };
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) return { ok: false, error: 'no video stream' };
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  return {
    ok: true,
    video: { codec: v.codec_name, profile: v.profile || null, width: v.width, height: v.height, fps: parseRate(v.avg_frame_rate) ?? parseRate(v.r_frame_rate) },
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate) || null } : null,
  };
}

/** Records `durationSec` of the RTSP source into fragmented MP4 (1 s fragments, like the recorder). */
export async function recordFmp4(url, outFile, durationSec) {
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-rtsp_transport', 'tcp', '-i', url,
      '-t', String(durationSec),
      '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
      '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000',
      outFile,
    ],
    { timeoutMs: (durationSec + 60) * 1000 }
  );
  return { ok: r.code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 0, wallMs: r.ms, error: r.code === 0 ? null : r.stderr.trim().slice(0, 500) };
}

export async function inspectFile(file) {
  const probe = await run('ffprobe', ['-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', file], { timeoutMs: 120000 });
  if (probe.code !== 0) return { ok: false, error: probe.stderr.trim().slice(0, 500) };
  const j = JSON.parse(probe.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video');
  const decode = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeoutMs: 600000 });
  const decodeErrors = decode.stderr.split('\n').filter((l) => l.trim()).length;
  const head = Buffer.alloc(Math.min(fs.statSync(file).size, 8 * 1024 * 1024));
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  return {
    ok: true,
    durationSec: Number(j.format?.duration) || 0,
    sizeBytes: Number(j.format?.size) || fs.statSync(file).size,
    videoPackets: v ? Number(v.nb_read_packets) || 0 : 0,
    fragmented: head.includes(Buffer.from('moof')),
    decodeExitCode: decode.code,
    decodeErrorLines: decodeErrors,
  };
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Seeks to each offset and reports the first decodable video frame's timestamp. */
export async function seekTest(file, durationSec, points = 8) {
  const results = [];
  for (let i = 1; i <= points; i++) {
    const target = (durationSec * i) / (points + 1);
    const r = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', `${target.toFixed(3)}%+#1`, '-show_entries', 'frame=pts_time,best_effort_timestamp_time,key_frame', '-of', 'json', file],
      { timeoutMs: 30000 }
    );
    let landed = null;
    if (r.code === 0) {
      const f = (JSON.parse(r.stdout).frames || [])[0];
      landed = f ? Number(f.pts_time ?? f.best_effort_timestamp_time) : null;
    }
    results.push({ targetSec: Number(target.toFixed(3)), landedSec: landed, ms: r.ms, ok: r.code === 0 && landed !== null });
  }
  return results;
}

/** Keyframe timestamps (seconds) of the first video stream. */
export async function keyframeTimes(file) {
  const r = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file],
    { timeoutMs: 300000 }
  );
  if (r.code !== 0) return [];
  return r.stdout.split('\n').map((l) => Number(l.trim().replace(/,$/, ''))).filter((n) => Number.isFinite(n));
}
