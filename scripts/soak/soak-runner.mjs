#!/usr/bin/env node
/**
 * P1.3 soak runner. Samples the appliance for a fixed duration and writes a report on recording
 * gaps, restarts, memory/CPU growth, disk growth and event-loop lag.
 *
 *   node scripts/soak/soak-runner.mjs --duration 72h --interval 60s \
 *     --recordings-dir /var/lib/vigilone/recordings \
 *     --metrics-url http://127.0.0.1:4000/metrics [--metrics-token ...] \
 *     [--mediamtx-metrics-url http://127.0.0.1:9998/metrics] [--docker] \
 *     [--cameras cam_a,cam_b] [--warmup 1h] --source-kind camera|simulated --out soak-results/<name>
 *
 *   node scripts/soak/soak-runner.mjs --report-only soak-results/<name>   # re-render from samples
 *
 * --source-kind is mandatory. `simulated` (e.g. scripts/sim/sim-camera-rig.sh) labels every
 * output SIMULATED-CAMERAS; such a run rehearses the software path and establishes nothing about
 * real cameras or capacity.
 *
 * Acceptance thresholds (action plan, Phase 1 real soak): no unexplained recording gap > 5 s per
 * camera per 24 h; memory growth < 5 % per 24 h after warm-up. Reconnect time, power-cut loss,
 * disk-full and export verification come from scripts/fault and vigilonectl acceptance.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, run } from '../lib/proc.mjs';
import { findGaps, listSegments } from '../lib/segments.mjs';

const args = parseArgs(process.argv.slice(2));

export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] || 's'];
  return Number(m[1]) * mult;
}

/** Parses Prometheus text exposition into { 'name{labels}': value }. */
export function parsePrometheus(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*(?:\{[^}]*\})?)\s+(-?[\d.eE+-]+|NaN|\+Inf|-Inf)/.exec(line);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

/** Least-squares slope (units per ms) of y over t. */
export function slope(points) {
  const n = points.length;
  if (n < 2) return null;
  const mt = points.reduce((a, p) => a + p.t, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.y - my);
    den += (p.t - mt) ** 2;
  }
  return den === 0 ? null : num / den;
}

async function fetchText(url, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function dirBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(full);
    else if (e.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

async function dockerSample() {
  const stats = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeoutMs: 20000 });
  const restarts = await run('docker', ['ps', '-q'], { timeoutMs: 10000 });
  const containers = {};
  if (stats.code === 0) {
    for (const l of stats.stdout.split('\n').filter(Boolean)) {
      const j = JSON.parse(l);
      containers[j.Name] = { cpuPercent: parseFloat(j.CPUPerc), mem: j.MemUsage };
    }
  }
  if (restarts.code === 0 && restarts.stdout.trim()) {
    const ids = restarts.stdout.trim().split('\n');
    const insp = await run('docker', ['inspect', '--format', '{{.Name}} {{.RestartCount}}', ...ids], { timeoutMs: 10000 });
    for (const l of insp.stdout.split('\n').filter(Boolean)) {
      const [name, count] = l.trim().split(' ');
      const key = name.replace(/^\//, '');
      containers[key] = { ...(containers[key] || {}), restartCount: Number(count) };
    }
  }
  return containers;
}

function listCameras(recordingsDir) {
  if (args.cameras) return String(args.cameras).split(',').map((s) => s.trim()).filter(Boolean);
  if (!fs.existsSync(recordingsDir)) return [];
  return fs.readdirSync(recordingsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'exports').map((e) => e.name);
}

async function takeSample(cfg) {
  const t = Date.now();
  const sample = { t, iso: new Date(t).toISOString() };
  if (cfg.metricsUrl) {
    const text = await fetchText(cfg.metricsUrl, cfg.metricsToken);
    sample.metricsOk = text !== null;
    if (text) {
      const m = parsePrometheus(text);
      sample.backend = {
        uptimeSec: m.vigilone_process_uptime_seconds ?? null,
        rssBytes: m.vigilone_process_resident_memory_bytes ?? null,
        heapBytes: m.vigilone_process_heap_used_bytes ?? null,
        cpuSeconds: m.vigilone_process_cpu_seconds_total ?? null,
        eventLoopP99Sec: m['vigilone_event_loop_lag_seconds{quantile="0.99"}'] ?? null,
        eventLoopMaxSec: m['vigilone_event_loop_lag_seconds{quantile="1"}'] ?? null,
        storageFillRatio: m.vigilone_storage_fill_ratio ?? null,
        segmentQueueDepth: m.vigilone_segment_queue_depth ?? null,
      };
    }
  }
  if (cfg.mediamtxMetricsUrl) {
    const text = await fetchText(cfg.mediamtxMetricsUrl);
    sample.mediamtxOk = text !== null;
    if (text) {
      const m = parsePrometheus(text);
      sample.mediamtx = {
        pathsReady: Object.entries(m).filter(([k, v]) => k.startsWith('paths{') && k.includes('state="ready"') && v === 1).length,
      };
    }
  }
  try {
    const st = fs.statfsSync(cfg.recordingsDir);
    sample.disk = { totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize };
  } catch {
    sample.disk = null;
  }
  sample.recordingsBytes = dirBytes(cfg.recordingsDir);
  if (cfg.docker) sample.containers = await dockerSample();
  return sample;
}

export async function buildReport(meta, samples, recordingsDir) {
  const start = samples[0]?.t ?? meta.startedAtMs;
  const end = samples[samples.length - 1]?.t ?? start;
  const hours = Math.max((end - start) / 3600000, 1e-9);
  const warmupEnd = start + meta.warmupMs;
  const report = {
    schema: 'vigilone.soak.v1',
    label: meta.simulated ? 'SIMULATED-CAMERAS' : 'REAL-CAMERAS',
    sourceKind: meta.sourceKind,
    startedAtUtc: new Date(start).toISOString(),
    endedAtUtc: new Date(end).toISOString(),
    durationHours: Number(hours.toFixed(3)),
    samples: samples.length,
    warmupHours: meta.warmupMs / 3600000,
    cameras: [],
    backend: null,
    disk: null,
    restarts: {},
    acceptance: [],
  };

  // Recording coverage per camera over [start, end - one segment] (the open segment is excluded).
  const windowEnd = end - meta.segmentSeconds * 1000;
  for (const cam of meta.cameras) {
    const segs = await listSegments(path.join(recordingsDir, cam), { sinceMs: start, untilMs: windowEnd });
    const gaps = windowEnd > start ? findGaps(segs, { thresholdSec: 5, windowStartMs: start, windowEndMs: windowEnd }) : [];
    report.cameras.push({
      camera: cam,
      segments: segs.length,
      unreadableSegments: segs.filter((s) => s.durationSec === null).length,
      gapsOver5s: gaps.length,
      gapsOver5sPer24h: Number(((gaps.length / hours) * 24).toFixed(2)),
      maxGapSec: Number(gaps.reduce((m, g) => Math.max(m, g.seconds), 0).toFixed(2)),
      gaps: gaps.map((g) => ({ fromUtc: new Date(g.fromMs).toISOString(), toUtc: new Date(g.toMs).toISOString(), seconds: Number(g.seconds.toFixed(2)) })),
    });
  }

  const withBackend = samples.filter((s) => s.backend && s.backend.rssBytes !== null);
  if (withBackend.length) {
    const post = withBackend.filter((s) => s.t >= warmupEnd);
    const pts = post.map((s) => ({ t: s.t, y: s.backend.rssBytes }));
    const sl = slope(pts);
    const mean = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : null;
    const growthPct24h = sl !== null && mean ? (sl * 86400000 * 100) / mean : null;
    const first = withBackend[0].backend;
    const last = withBackend[withBackend.length - 1].backend;
    const uptimeResets = withBackend.slice(1).filter((s, i) => s.backend.uptimeSec < withBackend[i].backend.uptimeSec).length;
    const lags = withBackend.map((s) => s.backend.eventLoopMaxSec).filter((v) => typeof v === 'number');
    report.backend = {
      scrapeFailures: samples.filter((s) => s.metricsOk === false).length,
      rssStartMB: Number((first.rssBytes / 1048576).toFixed(1)),
      rssEndMB: Number((last.rssBytes / 1048576).toFixed(1)),
      rssGrowthPctPer24hAfterWarmup: growthPct24h === null ? null : Number(growthPct24h.toFixed(2)),
      postWarmupSamples: pts.length,
      avgCpuPercent:
        last.cpuSeconds !== null && first.cpuSeconds !== null && uptimeResets === 0
          ? Number((((last.cpuSeconds - first.cpuSeconds) / ((end - start) / 1000)) * 100).toFixed(2))
          : null,
      eventLoopLagMaxSec: lags.length ? Math.max(...lags) : null,
      eventLoopLagP99MaxSec: (() => {
        const v = withBackend.map((s) => s.backend.eventLoopP99Sec).filter((x) => typeof x === 'number');
        return v.length ? Math.max(...v) : null;
      })(),
      processRestarts: uptimeResets,
    };
  }

  const withDisk = samples.filter((s) => typeof s.recordingsBytes === 'number');
  if (withDisk.length >= 2) {
    const sl = slope(withDisk.map((s) => ({ t: s.t, y: s.recordingsBytes })));
    report.disk = {
      recordingsGrowthGBPerHour: sl === null ? null : Number(((sl * 3600000) / 1e9).toFixed(3)),
      freeBytesEnd: withDisk[withDisk.length - 1].disk?.freeBytes ?? null,
    };
  }

  const withContainers = samples.filter((s) => s.containers);
  if (withContainers.length >= 2) {
    const a = withContainers[0].containers;
    const b = withContainers[withContainers.length - 1].containers;
    for (const name of Object.keys(b)) {
      if (typeof b[name].restartCount === 'number') report.restarts[name] = b[name].restartCount - (a[name]?.restartCount ?? 0);
    }
  }

  // Acceptance (only what a soak can measure).
  const covered = hours >= 24;
  for (const c of report.cameras) {
    report.acceptance.push({
      criterion: `no recording gap > 5 s (${c.camera})`,
      measured: `${c.gapsOver5s} gap(s), max ${c.maxGapSec} s, ${c.unreadableSegments} unreadable segment(s)`,
      status: c.gapsOver5s === 0 && c.unreadableSegments === 0 ? (covered ? 'PASS' : 'PASS_SHORT_RUN') : 'FAIL',
    });
  }
  // A per-24h growth rate extrapolated from a short window is noise (JIT warm-up, GC cycles), so
  // the criterion is only judged on at least MIN_GROWTH_WINDOW_HOURS of post-warm-up samples.
  const MIN_GROWTH_WINDOW_HOURS = 6;
  const g = report.backend?.rssGrowthPctPer24hAfterWarmup;
  const postWindowHours = report.backend ? Math.max(0, (end - warmupEnd) / 3600000) : 0;
  let memStatus;
  if (g === null || g === undefined) memStatus = 'NOT_VERIFIED';
  else if (postWindowHours < MIN_GROWTH_WINDOW_HOURS) memStatus = 'NOT_VERIFIED';
  else memStatus = g < 5 ? (covered ? 'PASS' : 'PASS_SHORT_RUN') : 'FAIL';
  report.acceptance.push({
    criterion: 'backend memory growth < 5 % per 24 h after warm-up',
    measured:
      g === null || g === undefined
        ? 'not measured (no backend metrics after warm-up)'
        : `${g} %/24h over ${report.backend.postWarmupSamples} sample(s) spanning ${postWindowHours.toFixed(2)} h` +
          (postWindowHours < MIN_GROWTH_WINDOW_HOURS ? ` (window < ${MIN_GROWTH_WINDOW_HOURS} h: too short to judge)` : ''),
    status: memStatus,
  });
  if (!covered) {
    report.acceptance.push({ criterion: 'run covers at least 24 h', measured: `${report.durationHours} h`, status: 'NOT_VERIFIED' });
  }
  return report;
}

export function renderMarkdown(r) {
  const title = r.label === 'SIMULATED-CAMERAS' ? 'SIMULATED-CAMERAS soak rehearsal (not a camera soak)' : 'Soak report';
  const lines = [
    `# ${title}`,
    '',
    `${r.startedAtUtc} to ${r.endedAtUtc} (${r.durationHours} h, ${r.samples} samples, warm-up ${r.warmupHours} h). Source kind: \`${r.sourceKind}\`.`,
    '',
    '## Acceptance',
    '',
    '| Criterion | Measured | Status |',
    '| --- | --- | --- |',
    ...r.acceptance.map((a) => `| ${a.criterion} | ${a.measured} | ${a.status} |`),
    '',
    '## Cameras',
    '',
    '| Camera | Segments | Unreadable | Gaps > 5 s | Per 24 h | Max gap (s) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.cameras.map((c) => `| ${c.camera} | ${c.segments} | ${c.unreadableSegments} | ${c.gapsOver5s} | ${c.gapsOver5sPer24h} | ${c.maxGapSec} |`),
    '',
  ];
  if (r.backend) {
    lines.push(
      '## Backend',
      '',
      `RSS ${r.backend.rssStartMB} MB to ${r.backend.rssEndMB} MB; growth after warm-up ${r.backend.rssGrowthPctPer24hAfterWarmup ?? 'n/a'} %/24h; ` +
        `average CPU ${r.backend.avgCpuPercent ?? 'n/a'} %; event-loop lag max ${r.backend.eventLoopLagMaxSec ?? 'n/a'} s (p99 max ${r.backend.eventLoopLagP99MaxSec ?? 'n/a'} s); ` +
        `process restarts ${r.backend.processRestarts}; metric scrape failures ${r.backend.scrapeFailures}.`,
      ''
    );
  } else {
    lines.push('## Backend', '', 'No backend metrics were collected (no --metrics-url, or every scrape failed).', '');
  }
  if (r.disk) lines.push('## Disk', '', `Recordings growth ${r.disk.recordingsGrowthGBPerHour} GB/h; free at end ${r.disk.freeBytesEnd ?? 'n/a'} bytes.`, '');
  if (Object.keys(r.restarts).length) lines.push('## Container restarts', '', ...Object.entries(r.restarts).map(([k, v]) => `- ${k}: ${v}`), '');
  return lines.join('\n');
}

async function main() {
  if (args['report-only']) {
    const dir = path.resolve(args['report-only']);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const samples = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const report = await buildReport(meta, samples, meta.recordingsDir);
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'report.md'), renderMarkdown(report));
    console.log(renderMarkdown(report));
    return;
  }
  if (!['camera', 'simulated'].includes(args['source-kind']) || !args['recordings-dir'] || !args.duration || !args.out) {
    console.error('Usage: soak-runner.mjs --source-kind camera|simulated --recordings-dir <dir> --duration 72h --out <dir> [--interval 60s] [--metrics-url ...] [--docker]');
    process.exit(2);
  }
  const simulated = args['source-kind'] === 'simulated';
  const outDir = path.resolve(simulated && !path.basename(args.out).startsWith('SIMULATED') ? path.join(path.dirname(args.out), `SIMULATED-CAMERAS_${path.basename(args.out)}`) : args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const cfg = {
    recordingsDir: path.resolve(args['recordings-dir']),
    metricsUrl: args['metrics-url'] || null,
    metricsToken: args['metrics-token'] || process.env.METRICS_AUTH_TOKEN || null,
    mediamtxMetricsUrl: args['mediamtx-metrics-url'] || null,
    docker: Boolean(args.docker),
  };
  const durationMs = parseDuration(args.duration);
  const intervalMs = parseDuration(args.interval || '60s');
  const meta = {
    sourceKind: args['source-kind'],
    simulated,
    recordingsDir: cfg.recordingsDir,
    cameras: listCameras(cfg.recordingsDir),
    segmentSeconds: Number(args['segment-seconds'] || 600),
    warmupMs: parseDuration(args.warmup || '1h'),
    startedAtMs: Date.now(),
    durationMs,
    intervalMs,
    metricsUrl: cfg.metricsUrl,
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const samplesPath = path.join(outDir, 'samples.jsonl');
  const samples = [];
  console.log(`[soak] ${simulated ? 'SIMULATED-CAMERAS ' : ''}soak for ${args.duration} every ${args.interval || '60s'} -> ${outDir}`);
  const deadline = meta.startedAtMs + durationMs;
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  while (!stopping) {
    const s = await takeSample(cfg);
    samples.push(s);
    fs.appendFileSync(samplesPath, JSON.stringify(s) + '\n');
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  meta.cameras = listCameras(cfg.recordingsDir);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const report = await buildReport(meta, samples, cfg.recordingsDir);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(report));
  console.log(renderMarkdown(report));
  process.exit(report.acceptance.some((a) => a.status === 'FAIL') ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('soak', 'soak-runner.mjs'))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
