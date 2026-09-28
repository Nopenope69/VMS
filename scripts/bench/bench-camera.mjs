#!/usr/bin/env node
/**
 * P1.1 per-camera compatibility runner.
 *
 *   node scripts/bench/bench-camera.mjs \
 *     --source-kind camera --label "Hikvision gate cam" \
 *     --onvif-host 192.168.10.21 --onvif-port 80 --user admin --pass '***' \
 *     [--rtsp-url rtsp://...]            # otherwise taken from ONVIF GetStreamUri
 *     [--duration 600] [--seek-points 8] [--out docs/operations/bench-results]
 *
 * Steps: ONVIF probe -> RTSP validation -> N-second fMP4 record -> ffprobe/decode integrity ->
 * SHA-256 -> playback seek test. Writes <out>/<date>_<label>.json and .md. Exit 0 only if every
 * step passed.
 *
 * --source-kind is mandatory: `camera` for a physical camera, `simulated` for anything else
 * (ffmpeg test pattern, file loop, another NVR). Simulated reports are written as
 * SIMULATED_<...>.json, carry "SIMULATED" in every heading, and are never added to the
 * compatibility matrix.
 *
 * Requires Node >= 20 and ffmpeg/ffprobe on PATH. Credentials are never written to reports.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, redactUrl, slug, toolVersion } from '../lib/proc.mjs';
import { probeOnvif } from '../lib/onvif.mjs';
import { inspectFile, keyframeTimes, probeRtsp, recordFmp4, seekTest, sha256File } from '../lib/media.mjs';

const args = parseArgs(process.argv.slice(2));
const usage = () => {
  console.error('Usage: bench-camera.mjs --source-kind camera|simulated --label <name> (--onvif-host <ip> | --rtsp-url <url>) [--user u --pass p] [--duration 600]');
  process.exit(2);
};
if (!['camera', 'simulated'].includes(args['source-kind']) || !args.label) usage();
if (!args['onvif-host'] && !args['rtsp-url']) usage();

const simulated = args['source-kind'] === 'simulated';
const durationSec = Number(args.duration || 600);
const seekPoints = Number(args['seek-points'] || 8);
const outDir = path.resolve(args.out || 'docs/operations/bench-results');
const startedAt = new Date();
const base = `${simulated ? 'SIMULATED_' : ''}${startedAt.toISOString().slice(0, 10)}_${slug(args.label)}`;

const report = {
  schema: 'vigilone.bench.v1',
  sourceKind: args['source-kind'],
  label: args.label,
  simulated,
  startedAtUtc: startedAt.toISOString(),
  finishedAtUtc: null,
  host: { platform: `${os.platform()} ${os.release()}`, node: process.version },
  tools: {},
  camera: { onvif: null },
  requested: { durationSec, seekPoints },
  steps: {},
  failures: [],
  verdict: 'FAIL',
};
const fail = (step, why) => report.failures.push(`${step}: ${why}`);

async function main() {
  report.tools.ffmpeg = await toolVersion('ffmpeg');
  report.tools.ffprobe = await toolVersion('ffprobe');
  if (!report.tools.ffmpeg || !report.tools.ffprobe) {
    fail('tools', 'ffmpeg/ffprobe not found on PATH');
    return;
  }

  // 1. ONVIF probe
  let rtspUrl = args['rtsp-url'] || null;
  if (args['onvif-host']) {
    try {
      const o = await probeOnvif({ host: args['onvif-host'], port: Number(args['onvif-port'] || 80), username: args.user, password: args.pass });
      report.camera.onvif = { deviceInfo: o.deviceInfo, profileToken: o.profileToken, streamUriReported: Boolean(o.streamUri) };
      report.steps.onvif = { ok: true };
      if (!rtspUrl && o.streamUri) {
        rtspUrl = o.streamUri;
        if (args.user && !/@/.test(rtspUrl.split('//')[1] || '')) {
          rtspUrl = rtspUrl.replace(/^(rtsps?:\/\/)/i, `$1${encodeURIComponent(args.user)}:${encodeURIComponent(args.pass || '')}@`);
        }
      }
    } catch (err) {
      report.steps.onvif = { ok: false, error: String(err.message || err) };
      fail('onvif', report.steps.onvif.error);
    }
  } else {
    report.steps.onvif = { ok: null, skipped: 'no --onvif-host given' };
    if (!simulated) fail('onvif', 'physical camera benches must include the ONVIF probe (--onvif-host)');
  }
  if (!rtspUrl) {
    fail('rtsp', 'no RTSP URL (not given and not reported by ONVIF)');
    return;
  }
  report.rtspUrl = redactUrl(rtspUrl);

  // 2. RTSP validation
  const probe = await probeRtsp(rtspUrl);
  report.steps.rtsp = probe;
  if (!probe.ok) {
    fail('rtsp', probe.error);
    return;
  }

  // 3. Record
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-bench-'));
  const file = path.join(work, 'bench.mp4');
  console.log(`[bench] recording ${durationSec}s from ${report.rtspUrl} ...`);
  const rec = await recordFmp4(rtspUrl, file, durationSec);
  report.steps.record = rec;
  if (!rec.ok) {
    fail('record', rec.error || 'no output');
    return;
  }

  // 4. Integrity
  const info = await inspectFile(file);
  const kf = await keyframeTimes(file);
  const gaps = kf.slice(1).map((t, i) => t - kf[i]);
  const maxKeyframeIntervalSec = gaps.length ? Math.max(...gaps) : null;
  report.steps.integrity = { ...info, keyframes: kf.length, maxKeyframeIntervalSec };
  if (!info.ok) fail('integrity', info.error);
  else {
    // Stream copy must start on a keyframe, so up to one GOP before the first keyframe is dropped
    // legitimately. Allow the larger of 2% or one keyframe interval + 1 s; anything beyond is loss.
    const shortfallAllowance = Math.max(durationSec * 0.02, (maxKeyframeIntervalSec ?? 2) + 1);
    report.steps.integrity.minAcceptableDurationSec = Number((durationSec - shortfallAllowance).toFixed(3));
    if (info.durationSec < durationSec - shortfallAllowance) {
      fail('integrity', `recorded ${info.durationSec.toFixed(2)}s, expected >= ${(durationSec - shortfallAllowance).toFixed(2)}s`);
    }
    if (!info.fragmented) fail('integrity', 'output is not fragmented MP4 (no moof atoms)');
    if (info.decodeExitCode !== 0 || info.decodeErrorLines > 0) fail('integrity', `decode reported ${info.decodeErrorLines} error line(s)`);
  }

  // 5. SHA-256
  report.steps.sha256 = { ok: true, sha256: await sha256File(file), sizeBytes: fs.statSync(file).size };

  // 6. Seek
  const tolerance = Math.max(2, 1.5 * (maxKeyframeIntervalSec || 2));
  const seeks = info.ok ? await seekTest(file, info.durationSec, seekPoints) : [];
  const badSeeks = seeks.filter((s) => !s.ok || Math.abs(s.landedSec - s.targetSec) > tolerance);
  report.steps.seek = { ok: seeks.length > 0 && badSeeks.length === 0, toleranceSec: tolerance, points: seeks };
  if (!report.steps.seek.ok) fail('seek', `${badSeeks.length}/${seeks.length} seek point(s) failed or landed outside ±${tolerance.toFixed(2)}s`);

  if (args['keep-recording']) report.recordingKeptAt = file;
  else fs.rmSync(work, { recursive: true, force: true });
}

function renderMarkdown(r) {
  const t = simulated ? 'SIMULATED bench report (not a camera)' : 'Bench report';
  const d = r.camera.onvif?.deviceInfo || {};
  const v = r.steps.rtsp?.video || {};
  const lines = [
    `# ${t}: ${r.label}`,
    '',
    `Verdict: **${r.verdict}**. Started ${r.startedAtUtc}, finished ${r.finishedAtUtc}. Source kind: \`${r.sourceKind}\`.`,
    '',
    '| Item | Value |',
    '| --- | --- |',
    `| Manufacturer / model / firmware | ${d.manufacturer ?? 'n/a'} / ${d.model ?? 'n/a'} / ${d.firmwareVersion ?? 'n/a'} |`,
    `| Stream | ${v.codec ?? 'n/a'} ${v.width ?? '?'}x${v.height ?? '?'} @ ${v.fps ? v.fps.toFixed(2) : '?'} fps |`,
    `| Recorded | ${r.steps.integrity?.durationSec?.toFixed?.(2) ?? 'n/a'} s of ${r.requested.durationSec} s, fragmented=${r.steps.integrity?.fragmented ?? 'n/a'}, decode errors=${r.steps.integrity?.decodeErrorLines ?? 'n/a'} |`,
    `| Max keyframe interval | ${r.steps.integrity?.maxKeyframeIntervalSec?.toFixed?.(2) ?? 'n/a'} s |`,
    `| SHA-256 | \`${r.steps.sha256?.sha256 ?? 'n/a'}\` |`,
    `| Seek | ${r.steps.seek ? `${r.steps.seek.points.filter((p) => p.ok).length}/${r.steps.seek.points.length} ok (±${r.steps.seek.toleranceSec.toFixed(2)} s)` : 'n/a'} |`,
    `| Tools | ${r.tools.ffmpeg ?? 'n/a'} |`,
    '',
  ];
  if (r.failures.length) lines.push('## Failures', '', ...r.failures.map((f) => `- ${f}`), '');
  return lines.join('\n');
}

main()
  .catch((err) => fail('runner', String(err?.stack || err)))
  .finally(() => {
    report.finishedAtUtc = new Date().toISOString();
    const required = simulated ? ['rtsp', 'record', 'integrity', 'sha256', 'seek'] : ['onvif', 'rtsp', 'record', 'integrity', 'sha256', 'seek'];
    const allRan = required.every((s) => report.steps[s] && report.steps[s].ok === true);
    report.verdict = allRan && report.failures.length === 0 ? 'PASS' : 'FAIL';
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${base}.json`), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(outDir, `${base}.md`), renderMarkdown(report));
    console.log(`[bench] ${report.verdict}: ${path.join(outDir, base)}.{json,md}`);
    for (const f of report.failures) console.log(`[bench]   - ${f}`);
    process.exit(report.verdict === 'PASS' ? 0 : 1);
  });
