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
 * is the same event and is evaluated once. Each confirmed condition is also kept as a CameraSabotageCondition row for
 * the footage-integrity page; when the worker reports it gone, the row is closed and an informational SYSTEM_ALERT
 * (`CAMERA_TAMPER_CLEARED`, no rule trigger) records that the camera was restored.
 */
import crypto from 'crypto';
import { CameraSabotageCondition, EventSeverity, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { fromSceneChange, fromSystemAlert } from '../incident/orchestrator/events';
import type { IngestResult, SceneChangeType, VigilOneEvent } from '../incident/orchestrator/types';

export const SABOTAGE_METHODS = ['classical-v1'] as const;

const MEASUREMENT_KEYS = ['meanLuma', 'stdLuma', 'darkFraction', 'brightFraction', 'sharpness', 'referenceSharpness', 'similarity'] as const;

const CHANGE_TYPES = ['OCCLUSION', 'DEFOCUS', 'DISPLACEMENT', 'BLINDED'] as const;

export const CameraSabotageReportSchema = z
  .object({
    state: z.literal('CONFIRMED').default('CONFIRMED'),
    cameraId: z.string().uuid(),
    tenantId: z.string().min(1),
    changeType: z.enum(CHANGE_TYPES),
    score: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
    startedAtUtc: z.string().datetime(),
    confirmedAtUtc: z.string().datetime(),
    method: z.enum(SABOTAGE_METHODS),
    measurements: z.object(Object.fromEntries(MEASUREMENT_KEYS.map((k) => [k, z.number().finite()])) as Record<(typeof MEASUREMENT_KEYS)[number], z.ZodNumber>).strict(),
  })
  .strict();

export type CameraSabotageReport = z.infer<typeof CameraSabotageReportSchema>;

/** The worker saw the condition end: the picture is normal again, or a moved camera's new view became its reference. */
export const CameraSabotageClearedSchema = z
  .object({
    state: z.literal('CLEARED'),
    cameraId: z.string().uuid(),
    tenantId: z.string().min(1),
    changeType: z.enum(CHANGE_TYPES),
    startedAtUtc: z.string().datetime(),
    clearedAtUtc: z.string().datetime(),
    clearReason: z.enum(['RESTORED', 'RELEARNED']),
    method: z.enum(SABOTAGE_METHODS),
  })
  .strict();

export type CameraSabotageCleared = z.infer<typeof CameraSabotageClearedSchema>;

export class CameraSabotageError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

/** A clock skew larger than this between the worker and the backend refuses the report (times would be wrong). */
const MAX_FUTURE_MS = 60_000;

export const SABOTAGE_TITLES: Record<SceneChangeType, string> = {
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
  return `${SABOTAGE_TITLES[r.changeType]} for at least ${held} s: ${seen[r.changeType]}. Measured by ${r.method} on the camera's substream; advisory, check the live view.`;
}

export class CameraSabotageService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ingest: (event: VigilOneEvent) => Promise<IngestResult>,
    private readonly now: () => number = Date.now
  ) {}

  /** Queries open sabotage conditions for the appliance or a specific tenant. */
  async getOpenConditions(tenantId?: string): Promise<CameraSabotageCondition[]> {
    return this.prisma.cameraSabotageCondition.findMany({
      where: {
        clearedAt: null,
        ...(tenantId ? { tenantId } : {}),
      },
      orderBy: { startedAt: 'asc' },
    });
  }

  /** A confirmed condition (raises SCENE_CHANGE) or the end of one (closes it); `state` tells which. */
  async report(body: unknown): Promise<{ eventId: string; result: IngestResult; duplicate?: boolean }> {
    if ((body as { state?: unknown } | null)?.state === 'CLEARED') return this.cleared(body);
    const parsed = CameraSabotageReportSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const r = parsed.data;
    const started = Date.parse(r.startedAtUtc);
    const confirmed = Date.parse(r.confirmedAtUtc);
    if (confirmed < started) throw new CameraSabotageError(400, 'INVALID_REPORT', 'confirmedAtUtc is before startedAtUtc');
    if (confirmed > this.now() + MAX_FUTURE_MS) throw new CameraSabotageError(400, 'CLOCK_SKEW', 'confirmedAtUtc is in the future');
    const camera = await this.camera(r.cameraId, r.tenantId);

    const eventId = sabotageEventId(r.cameraId, r.changeType, r.startedAtUtc);
    // The condition row first: a retry after a failed ingest finds it and still raises the event (both are idempotent).
    await this.prisma.cameraSabotageCondition.upsert({
      where: { eventId },
      create: {
        tenantId: r.tenantId,
        cameraId: r.cameraId,
        changeType: r.changeType,
        startedAt: new Date(started),
        confirmedAt: new Date(confirmed),
        score: r.score,
        method: r.method,
        measurementsJson: r.measurements,
        eventId,
      },
      update: {},
    });
    const event = fromSceneChange({
      id: eventId,
      tenantId: r.tenantId,
      cameraId: r.cameraId,
      source: 'WATCHDOG',
      severity: EventSeverity.WARNING,
      title: SABOTAGE_TITLES[r.changeType],
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

  private async cleared(body: unknown): Promise<{ eventId: string; result: IngestResult; duplicate?: boolean }> {
    const parsed = CameraSabotageClearedSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error);
    const r = parsed.data;
    const cleared = Date.parse(r.clearedAtUtc);
    if (cleared > this.now() + MAX_FUTURE_MS) throw new CameraSabotageError(400, 'CLOCK_SKEW', 'clearedAtUtc is in the future');
    const camera = await this.camera(r.cameraId, r.tenantId);

    const conditionEventId = sabotageEventId(r.cameraId, r.changeType, r.startedAtUtc);
    const row = await this.prisma.cameraSabotageCondition.findUnique({ where: { eventId: conditionEventId } });
    if (!row || row.cameraId !== r.cameraId) {
      throw new CameraSabotageError(404, 'CONDITION_NOT_FOUND', 'No reported condition matches this camera, type and start');
    }
    if (cleared < row.startedAt.getTime()) throw new CameraSabotageError(400, 'INVALID_REPORT', 'clearedAtUtc is before the condition began');
    const eventId = `${conditionEventId}_cleared`;
    // Only the first report closes it: a retry leaves the recorded time as it was.
    const closed = await this.prisma.cameraSabotageCondition.updateMany({
      where: { id: row.id, clearedAt: null },
      data: { clearedAt: new Date(cleared), clearReason: r.clearReason },
    });
    const duplicate = closed.count === 0;

    const seconds = Math.max(0, Math.round((cleared - row.startedAt.getTime()) / 1000));
    const what = SABOTAGE_TITLES[r.changeType].split(':')[0].toLowerCase();
    const event = fromSystemAlert({
      id: eventId,
      tenantId: r.tenantId,
      cameraId: r.cameraId,
      source: 'WATCHDOG',
      severity: EventSeverity.INFO,
      title: r.clearReason === 'RESTORED' ? 'Camera view restored' : 'Moved camera: new view accepted',
      subsystem: 'camera-sabotage',
      alertCode: 'CAMERA_TAMPER_CLEARED',
      message:
        r.clearReason === 'RESTORED'
          ? `The picture is normal again after ${seconds} s (${what}).`
          : `The camera stayed moved for ${seconds} s; its new view is now the reference it is compared with.`,
      details: { changeType: r.changeType, clearReason: r.clearReason, conditionEventId, startedAtUtc: row.startedAt.toISOString() },
    });
    event.timestampUtc = new Date(cleared);
    if (camera.siteId) event.siteId = camera.siteId;
    const result = await this.ingest(event);
    return { eventId, result, ...(duplicate ? { duplicate: true } : {}) };
  }

  /** A camera of another tenant is reported exactly like a missing one. */
  private async camera(cameraId: string, tenantId: string): Promise<{ siteId: string | null }> {
    const camera = await this.prisma.camera.findUnique({ where: { id: cameraId }, select: { tenantId: true, siteId: true } });
    if (!camera || camera.tenantId !== tenantId) throw new CameraSabotageError(404, 'CAMERA_NOT_FOUND', 'Camera not found');
    return { siteId: camera.siteId };
  }
}

function invalid(error: z.ZodError): CameraSabotageError {
  return new CameraSabotageError(400, 'INVALID_REPORT', error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
}
