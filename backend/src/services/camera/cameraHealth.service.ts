import { PrismaClient } from '@prisma/client';
import { CameraHealth, CameraHealthInput, deriveCameraHealth, parseDurationMs } from './cameraHealth';

const DEFAULT_SEGMENT_MS = 600_000;

export interface CameraHealthRow {
  cameraId: string;
  name: string;
  health: CameraHealth;
}

/**
 * Read-only health of the tenant's cameras (or of one). One query for the cameras, then the newest segment and
 * the newest stream measurement of each through the existing (cameraId, time) indexes. Writes nothing and never
 * touches recording.
 */
export async function loadCameraHealth(
  prisma: PrismaClient,
  tenantId: string,
  opts: { cameraId?: string; segmentDuration?: string; now?: number } = {}
): Promise<CameraHealthRow[]> {
  const segmentMs = parseDurationMs(opts.segmentDuration) ?? DEFAULT_SEGMENT_MS;
  const rows = await prisma.camera.findMany({
    where: { tenantId, ...(opts.cameraId ? { id: opts.cameraId } : {}) },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      monitored: true,
      lastSeenAt: true,
      desiredRecorderState: true,
      observedRecorderState: true,
      lastRecorderError: true,
      lastReconciledAt: true,
      lastStateChangeAt: true,
      recordingMode: true,
      effectiveRecordingMode: true,
      degradationReason: true,
      degradationSince: true,
    },
  });

  return Promise.all(
    rows.map(async (c) => {
      const [seg, diag] = await Promise.all([
        prisma.recordingSegment.findFirst({
          where: { cameraId: c.id },
          orderBy: { startTime: 'desc' },
          select: { status: true, startTime: true, endTime: true },
        }),
        prisma.streamDiagnostic.findFirst({
          where: { cameraId: c.id },
          orderBy: { checkedAt: 'desc' },
          select: { isDegraded: true, degradedReason: true, checkedAt: true },
        }),
      ]);
      const input: CameraHealthInput = {
        monitored: c.monitored,
        lastSeenAt: c.lastSeenAt,
        desiredRecorderState: c.desiredRecorderState,
        observedRecorderState: c.observedRecorderState,
        lastRecorderError: c.lastRecorderError,
        lastReconciledAt: c.lastReconciledAt,
        lastStateChangeAt: c.lastStateChangeAt,
        recordingMode: c.recordingMode,
        effectiveRecordingMode: c.effectiveRecordingMode,
        degradationReason: c.degradationReason,
        degradationSince: c.degradationSince,
        latestSegment: seg,
        latestDiagnostic: diag,
      };
      return { cameraId: c.id, name: c.name, health: deriveCameraHealth(input, segmentMs, opts.now) };
    })
  );
}

/** Counts per state, for a fleet summary. */
export function summariseHealth(rows: CameraHealthRow[]): Record<string, number> {
  const out: Record<string, number> = { HEALTHY: 0, DEGRADED: 0, DOWN: 0, UNKNOWN: 0, NOT_MONITORED: 0 };
  for (const r of rows) out[r.health.state]++;
  return out;
}
