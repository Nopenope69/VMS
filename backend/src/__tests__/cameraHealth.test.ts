import { deriveCameraHealth, parseDurationMs, segmentStaleAfterMs, CameraHealthInput } from '../services/camera/cameraHealth';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const SEG = 600_000; // 10 minute segments
const ago = (ms: number) => new Date(NOW - ms);

/** A camera that is fully healthy; each test breaks one thing. */
const healthy = (over: Partial<CameraHealthInput> = {}): CameraHealthInput => ({
  monitored: true,
  lastSeenAt: ago(10_000),
  desiredRecorderState: 'RUNNING',
  observedRecorderState: 'RUNNING',
  lastRecorderError: null,
  lastReconciledAt: ago(30_000),
  lastStateChangeAt: ago(3_600_000),
  recordingMode: 'CONTINUOUS',
  effectiveRecordingMode: 'CONTINUOUS',
  degradationReason: 'NONE',
  degradationSince: null,
  latestSegment: { status: 'FINALIZED', startTime: ago(900_000), endTime: ago(300_000) },
  latestDiagnostic: { isDegraded: false, degradedReason: null, checkedAt: ago(60_000) },
  ...over,
});

const h = (over: Partial<CameraHealthInput> = {}) => deriveCameraHealth(healthy(over), SEG, NOW);

describe('deriveCameraHealth', () => {
  it('is HEALTHY with no reasons when everything is as configured', () => {
    const r = h();
    expect(r.state).toBe('HEALTHY');
    expect(r.reasons).toEqual([]);
    expect(r.stream.live).toBe(true);
    expect(r.recording.lastSegment?.secondsSinceActivity).toBe(300);
  });

  it('is NOT_MONITORED for an unwatched camera, even if its stream looks dead', () => {
    const r = h({ monitored: false, lastSeenAt: null });
    expect(r.state).toBe('NOT_MONITORED');
    expect(r.reasons).toEqual([]);
  });

  it('is UNKNOWN, not HEALTHY, when the watchdog never reported the camera', () => {
    const r = h({ lastSeenAt: null });
    expect(r.state).toBe('UNKNOWN');
    expect(r.reasons[0]).toMatch(/never reported/);
  });

  it('is DOWN when the stream has not been seen within the liveness window', () => {
    const r = h({ lastSeenAt: ago(120_000) });
    expect(r.state).toBe('DOWN');
    expect(r.stream.live).toBe(false);
    expect(r.reasons.join()).toMatch(/stream not seen for 120s/);
  });

  it('is DOWN when the recorder is in ERROR and shows the last error', () => {
    const r = h({ observedRecorderState: 'ERROR', lastRecorderError: 'disk full' });
    expect(r.state).toBe('DOWN');
    expect(r.reasons.join()).toMatch(/recorder in ERROR: disk full/);
  });

  it('is DEGRADED when the recorder should be running but is not', () => {
    const r = h({ observedRecorderState: 'STOPPED' });
    expect(r.state).toBe('DEGRADED');
    expect(r.reasons.join()).toMatch(/should be RUNNING but is STOPPED/);
  });

  it('does not complain about a stopped recorder that was meant to be stopped', () => {
    const r = h({ desiredRecorderState: 'STOPPED', observedRecorderState: 'STOPPED', latestSegment: null });
    expect(r.state).toBe('HEALTHY');
  });

  it('is DEGRADED when recording runs in a degraded mode', () => {
    const r = h({ effectiveRecordingMode: 'MOTION_ONLY', degradationReason: 'STORAGE_PRESSURE_CRITICAL', degradationSince: ago(60_000) });
    expect(r.state).toBe('DEGRADED');
    expect(r.recording.degradationReason).toBe('STORAGE_PRESSURE_CRITICAL');
    expect(r.recording.degradedSince).toBe(ago(60_000).toISOString());
  });

  it('is DEGRADED when the latest stream measurement is degraded', () => {
    const r = h({ latestDiagnostic: { isDegraded: true, degradedReason: 'fps 3 vs baseline 15', checkedAt: ago(1000) } });
    expect(r.state).toBe('DEGRADED');
    expect(r.reasons.join()).toMatch(/fps 3 vs baseline 15/);
  });

  describe('segment staleness', () => {
    it('allows a segment up to two lengths plus a minute old', () => {
      const edge = segmentStaleAfterMs(SEG);
      expect(h({ latestSegment: { status: 'FINALIZED', startTime: ago(edge + SEG), endTime: ago(edge) } }).state).toBe('HEALTHY');
    });

    it('is DEGRADED once the newest segment is overdue', () => {
      const old = segmentStaleAfterMs(SEG) + 1000;
      const r = h({ latestSegment: { status: 'FINALIZED', startTime: ago(old + SEG), endTime: ago(old) } });
      expect(r.state).toBe('DEGRADED');
      expect(r.reasons.join()).toMatch(/no new segment for/);
    });

    it('is DEGRADED when a recording camera has no indexed segment at all', () => {
      const r = h({ latestSegment: null });
      expect(r.state).toBe('DEGRADED');
      expect(r.reasons.join()).toMatch(/no recording segment has been indexed/);
    });

    it('measures an in-progress segment from its start, so a stuck RECORDING row goes stale', () => {
      const old = segmentStaleAfterMs(SEG) + 1000;
      const r = h({ latestSegment: { status: 'RECORDING', startTime: ago(old), endTime: ago(0) } });
      expect(r.state).toBe('DEGRADED');
    });
  });

  it('DOWN outranks DEGRADED and lists every reason', () => {
    const r = h({ lastSeenAt: ago(500_000), observedRecorderState: 'STOPPED', latestSegment: null });
    expect(r.state).toBe('DOWN');
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('never invents reconnect or retry counters', () => {
    const json = JSON.stringify(h());
    expect(json).not.toMatch(/retry|reconnect/i);
  });
});

describe('parseDurationMs', () => {
  it.each([['10m', 600_000], ['90s', 90_000], ['1h', 3_600_000], [' 5M ', 300_000]])('%s', (v, ms) => {
    expect(parseDurationMs(v as string)).toBe(ms);
  });
  it.each(['', 'ten', '10', '1d', undefined])('rejects %p', (v) => {
    expect(parseDurationMs(v as any)).toBeNull();
  });
});
