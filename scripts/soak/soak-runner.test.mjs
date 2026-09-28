import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, parseDuration, parsePrometheus, slope } from './soak-runner.mjs';

test('parses durations', () => {
  assert.equal(parseDuration('72h'), 72 * 3600000);
  assert.equal(parseDuration('90s'), 90000);
  assert.throws(() => parseDuration('soon'));
});

test('parses Prometheus text including labelled series', () => {
  const m = parsePrometheus('# HELP x\nvigilone_process_resident_memory_bytes 1024\nvigilone_event_loop_lag_seconds{quantile="0.99"} 0.012\n');
  assert.equal(m.vigilone_process_resident_memory_bytes, 1024);
  assert.equal(m['vigilone_event_loop_lag_seconds{quantile="0.99"}'], 0.012);
});

test('slope of a linear series', () => {
  assert.equal(slope([{ t: 0, y: 0 }, { t: 1, y: 2 }, { t: 2, y: 4 }]), 2);
});

test('memory growth is FAIL above 5 %/24h and never PASS without metrics', async () => {
  const H = 3600000;
  const mk = (i, rss) => ({ t: i * H, backend: { uptimeSec: i * 3600, rssBytes: rss, cpuSeconds: i, eventLoopMaxSec: 0.01, eventLoopP99Sec: 0.005 }, recordingsBytes: i * 1e9 });
  const meta = { sourceKind: 'simulated', simulated: true, cameras: [], segmentSeconds: 600, warmupMs: H, startedAtMs: 0 };
  // 100 MB growing 1 MB/h -> ~24 %/24h
  const leaking = Array.from({ length: 30 }, (_, i) => mk(i, 100e6 + i * 1e6));
  const r1 = await buildReport(meta, leaking, '/nonexistent');
  assert.equal(r1.label, 'SIMULATED-CAMERAS');
  assert.equal(r1.acceptance.find((a) => a.criterion.startsWith('backend memory')).status, 'FAIL');
  const flat = Array.from({ length: 30 }, (_, i) => mk(i, 100e6));
  const r2 = await buildReport(meta, flat, '/nonexistent');
  assert.equal(r2.acceptance.find((a) => a.criterion.startsWith('backend memory')).status, 'PASS');
  const r3 = await buildReport(meta, flat.map(({ backend, ...s }) => s), '/nonexistent');
  assert.equal(r3.acceptance.find((a) => a.criterion.startsWith('backend memory')).status, 'NOT_VERIFIED');
});

test('a short run never judges memory growth', async () => {
  const H = 3600000;
  const meta = { sourceKind: 'simulated', simulated: true, cameras: [], segmentSeconds: 600, warmupMs: 60000, startedAtMs: 0 };
  const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 10000, backend: { uptimeSec: i * 10, rssBytes: 100e6 + i * 5e6, cpuSeconds: i, eventLoopMaxSec: 0.01, eventLoopP99Sec: 0.005 }, recordingsBytes: 0 }));
  const r = await buildReport(meta, samples, '/nonexistent');
  const mem = r.acceptance.find((a) => a.criterion.startsWith('backend memory'));
  assert.equal(mem.status, 'NOT_VERIFIED');
  assert.match(mem.measured, /too short to judge/);
  void H;
});

