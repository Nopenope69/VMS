/**
 * Camera-sabotage reports from the AI worker (ADR 0019).
 *
 * The worker measures every sampled substream frame (classical image measurements, no model) and reports a covered,
 * defocused, moved or blinded camera once the condition has lasted its hold time. Here the report is checked against
 * the camera registry and raised as a SCENE_CHANGE event (events.v1 `camera.degraded`, reason `TAMPER_<type>`), so
 * the rule engine's SCENE_CHANGE trigger turns it into an alarm. Nothing else changes: recording, live view and the
 * camera's state are untouched, and the event says what was measured.
 *
 * The event id is derived from camera, type and start time, so a report the worker repeats (a retry after a timeout)
 * is the same event and is evaluated once.
 */
import crypto from 'crypto';
import { EventSeverity, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { fromSceneChange } from '../incident/orchestrator/events';
import type { IngestResult, SceneChangeType, VigilOneEvent } from '../incident/orchestrator/types';

export const SABOTAGE_METHODS = ['classical-v1'] as const;

const MEASUREMENT_KEYS = ['meanLuma', 'stdLuma', 'darkFraction', 'brightFraction', 'sharpness', 'referenceSharpness', 'similarity'] as const;

export const CameraSabotageReportSchema = z
  .object({
    cameraId: z.string().uuid(),
    tenantId: z.string().min(1),
    changeType: z.enum(['OCCLUSION', 'DEFOCUS', 'DISPLACEMENT', 'BLINDED']),
    score: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
    startedAtUtc: z.string().datetime(),
    confirmedAtUtc: z.string().datetime(),
    method: z.enum(SABOTAGE_METHODS),
    measurements: z.object(Object.fromEntries(MEASUREMENT_KEYS.map((k) => [k, z.number().finite()])) as Record<(typeof MEASUREMENT_KEYS)[number], z.ZodNumber>).strict(),
  })
  .strict();

export type CameraSabotageReport = z.infer<typeof CameraSabotageReportSchema>;

export class CameraSabotageError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** A clock skew larger than this between the worker and the backend refuses the report (times would be wrong). */
const MAX_FUTURE_MS = 60_000;

const TITLES: Record<SceneChangeType, string> = {
  OCCLUSION: 'Camera view covered or blocked',
  DEFOCUS: 'Camera out of focus or lens obscured',
  DISPLACEMENT: 'Camera moved: the view differs from its reference',
  BLINDED: 'Camera blinded by bright light',
};

export function sabotageEventId(cameraId: string, changeType: string, startedAtUtc: string): string {
  const h = crypto.createHash('sha256').update(`camera-sabotage|${cameraId}|${changeType}|${new Date(startedAtUtc).toISOString()}`).digest('hex');
  return `ev_sabotage_${h.slice(0, 32)}`;
}

export function describeSabotage(r: CameraSabotageReport): string {
  const m = r.measurements;
  const held = Math.round((Date.parse(r.confirmedAtUtc) - Date.parse(r.startedAtUtc)) / 1000);
  const seen: Record<SceneChangeType, string> = {
    OCCLUSION: `the picture is flat (grey-level spread ${m.stdLuma}) and no longer resembles the camera's reference view (similarity ${m.similarity})`,
    DEFOCUS: `sharpness fell to ${m.sharpness} against a reference of ${m.referenceSharpness}`,
    DISPLACEMENT: `the picture is sharp but no longer resembles the camera's reference view (similarity ${m.similarity})`,
    BLINDED: `${Math.round(m.brightFraction * 100)}% of the picture is saturated`,
  };
  return `${TITLES[r.changeType]} for at least ${held} s: ${seen[r.changeType]}. Measured by ${r.method} on the camera's substream; advisory, check the live view.`;
}

export class CameraSabotageService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingest: (event: VigilOneEvent) => Promise<IngestResult>,
    private readonly now: () => number = Date.now
  ) {}

  async report(body: unknown): Promise<{ eventId: string; result: IngestResult }> {
    const parsed = CameraSabotageReportSchema.safeParse(body);
    if (!parsed.success) {
      throw new CameraSabotageError(400, 'INVALID_REPORT', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    }
    const r = parsed.data;
    const started = Date.parse(r.startedAtUtc);
    const confirmed = Date.parse(r.confirmedAtUtc);
    if (confirmed < started) throw new CameraSabotageError(400, 'INVALID_REPORT', 'confirmedAtUtc is before startedAtUtc');
    if (confirmed > this.now() + MAX_FUTURE_MS) throw new CameraSabotageError(400, 'CLOCK_SKEW', 'confirmedAtUtc is in the future');

    const camera = await this.prisma.camera.findUnique({ where: { id: r.cameraId }, select: { tenantId: true, siteId: true } });
    // A camera of another tenant is reported exactly like a missing one.
    if (!camera || camera.tenantId !== r.tenantId) throw new CameraSabotageError(404, 'CAMERA_NOT_FOUND', 'Camera not found');

    const event = fromSceneChange({
      id: sabotageEventId(r.cameraId, r.changeType, r.startedAtUtc),
      tenantId: r.tenantId,
      cameraId: r.cameraId,
      source: 'WATCHDOG',
      severity: EventSeverity.WARNING,
      title: TITLES[r.changeType],
      description: describeSabotage(r),
      score: r.score,
      threshold: r.threshold,
      changeType: r.changeType,
      method: r.method,
      startedAtUtc: new Date(started).toISOString(),
      measurements: { ...r.measurements },
    });
    event.timestampUtc = new Date(confirmed);
    if (camera.siteId) event.siteId = camera.siteId;
    const result = await this.ingest(event);
    return { eventId: event.id, result };
  }
}
