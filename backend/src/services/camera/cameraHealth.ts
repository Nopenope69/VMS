import { LIVE_WINDOW_MS, isLive } from './liveness';

/**
 * Per-camera health, derived read-only from facts the appliance already records. Nothing here is stored or
 * simulated: a field the system does not record is not reported (there is no reconnect or retry counter today).
 *
 *  - NOT_MONITORED  the camera is not watched by the stream and recording watchdogs
 *  - UNKNOWN        monitored, but the stream watchdog has never reported on it
 *  - DOWN           stream not ready for longer than the liveness window, or the recorder is in ERROR
 *  - DEGRADED       reachable, but recording is not as configured (recorder not running, degraded mode,
 *                   a degraded stream measurement, or no new segment for too long)
 *  - HEALTHY        none of the above
 *
 * Reasons are always listed, so a state is never shown without the facts behind it.
 */
export type CameraHealthState = 'NOT_MONITORED' | 'UNKNOWN' | 'DOWN' | 'DEGRADED' | 'HEALTHY';

export interface CameraHealthInput {
  monitored: boolean;
  lastSeenAt: Date | null;
  desiredRecorderState: string;
  observedRecorderState: string;
  lastRecorderError: string | null;
  lastReconciledAt: Date | null;
  lastStateChangeAt: Date | null;
  recordingMode: string;
  effectiveRecordingMode: string;
  degradationReason: string;
  degradationSince: Date | null;
  latestSegment: { status: string; startTime: Date; endTime: Date } | null;
  latestDiagnostic: { isDegraded: boolean; degradedReason: string | null; checkedAt: Date } | null;
}

export interface CameraHealth {
  state: CameraHealthState;
  reasons: string[];
  stream: { live: boolean; lastSeenAt: string | null; secondsSinceSeen: number | null };
  recorder: {
    desired: string;
    observed: string;
    lastError: string | null;
    lastReconciledAt: string | null;
    lastStateChangeAt: string | null;
  };
  recording: {
    configuredMode: string;
    effectiveMode: string;
    degradationReason: string;
    degradedSince: string | null;
    lastSegment: { status: string; startTime: string; endTime: string; secondsSinceActivity: number } | null;
    staleAfterSeconds: number;
  };
  diagnostic: { degraded: boolean; reason: string | null; checkedAt: string } | null;
}

/** "10m", "90s", "1h" to milliseconds; null when it cannot be read. */
export function parseDurationMs(v: string | undefined | null): number | null {
  const m = /^\s*(\d+)\s*(s|m|h)\s*$/i.exec(v ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000);
}

/** A segment is overdue after two segment lengths plus a minute for finalisation and indexing. */
export function segmentStaleAfterMs(segmentDurationMs: number): number {
  return 2 * segmentDurationMs + 60_000;
}

const secs = (ms: number) => Math.max(0, Math.round(ms / 1000));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function deriveCameraHealth(i: CameraHealthInput, segmentDurationMs: number, now = Date.now()): CameraHealth {
  const staleMs = segmentStaleAfterMs(segmentDurationMs);
  const live = isLive(i.lastSeenAt, now);
  const reasons: string[] = [];
  let down = false;
  let degraded = false;

  const lastActivity = i.latestSegment
    ? i.latestSegment.status === 'RECORDING'
      ? i.latestSegment.startTime.getTime()
      : i.latestSegment.endTime.getTime()
    : null;

  if (i.monitored) {
    if (!i.lastSeenAt) {
      reasons.push('the stream watchdog has never reported this camera');
    } else if (!live) {
      down = true;
      reasons.push(`stream not seen for ${secs(now - i.lastSeenAt.getTime())}s (liveness window ${secs(LIVE_WINDOW_MS)}s)`);
    }

    if (i.observedRecorderState === 'ERROR') {
      down = true;
      reasons.push(`recorder in ERROR${i.lastRecorderError ? `: ${i.lastRecorderError}` : ''}`);
    } else if (i.desiredRecorderState === 'RUNNING' && i.observedRecorderState !== 'RUNNING') {
      degraded = true;
      reasons.push(`recorder should be RUNNING but is ${i.observedRecorderState}`);
    }

    if (i.degradationReason !== 'NONE' || i.effectiveRecordingMode !== i.recordingMode) {
      degraded = true;
      reasons.push(
        `recording mode ${i.effectiveRecordingMode} instead of ${i.recordingMode} (${i.degradationReason})`
      );
    }

    if (i.latestDiagnostic?.isDegraded) {
      degraded = true;
      reasons.push(`stream measurement degraded${i.latestDiagnostic.degradedReason ? `: ${i.latestDiagnostic.degradedReason}` : ''}`);
    }

    if (i.desiredRecorderState === 'RUNNING') {
      if (lastActivity === null) {
        degraded = true;
        reasons.push('no recording segment has been indexed yet');
      } else if (now - lastActivity > staleMs) {
        degraded = true;
        reasons.push(`no new segment for ${secs(now - lastActivity)}s (overdue after ${secs(staleMs)}s)`);
      }
    }
  }

  let state: CameraHealthState;
  if (!i.monitored) state = 'NOT_MONITORED';
  else if (down) state = 'DOWN';
  else if (!i.lastSeenAt) state = degraded ? 'DEGRADED' : 'UNKNOWN';
  else if (degraded) state = 'DEGRADED';
  else state = 'HEALTHY';

  return {
    state,
    reasons,
    stream: {
      live,
      lastSeenAt: iso(i.lastSeenAt),
      secondsSinceSeen: i.lastSeenAt ? secs(now - i.lastSeenAt.getTime()) : null,
    },
    recorder: {
      desired: i.desiredRecorderState,
      observed: i.observedRecorderState,
      lastError: i.lastRecorderError,
      lastReconciledAt: iso(i.lastReconciledAt),
      lastStateChangeAt: iso(i.lastStateChangeAt),
    },
    recording: {
      configuredMode: i.recordingMode,
      effectiveMode: i.effectiveRecordingMode,
      degradationReason: i.degradationReason,
      degradedSince: iso(i.degradationSince),
      lastSegment: i.latestSegment
        ? {
            status: i.latestSegment.status,
            startTime: i.latestSegment.startTime.toISOString(),
            endTime: i.latestSegment.endTime.toISOString(),
            secondsSinceActivity: secs(now - (lastActivity as number)),
          }
        : null,
      staleAfterSeconds: secs(staleMs),
    },
    diagnostic: i.latestDiagnostic
      ? {
          degraded: i.latestDiagnostic.isDegraded,
          reason: i.latestDiagnostic.degradedReason,
          checkedAt: i.latestDiagnostic.checkedAt.toISOString(),
        }
      : null,
  };
}
