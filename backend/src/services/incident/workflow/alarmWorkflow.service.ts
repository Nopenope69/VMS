import { PrismaClient, EventSeverity, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditChainService } from '../../audit/auditChain.service';
import { MetricsService } from '../../observability/metrics.service';
import { NotificationAdapter } from '../orchestrator/adapters/notificationAdapter';
import { RecordingCatalog } from '../../recording/catalog/recordingCatalog.service';
import { hasPermission, Permission } from '../../rbac/permissions';

/**
 * Incident workflow (P3.4): assignment, acknowledge/resolve SLAs, escalation and automatic
 * evidence holds. One sweeper drives the time-based parts so every alarm source (rules, AI,
 * watchdogs, storage) is covered, not only alarms created through the orchestrator.
 *
 * Idempotency comes from the database, not from memory: an escalation step is a unique
 * (alarm, policy, step) row, a hold is a unique (alarm, camera) row, a segment is pinned once per
 * hold (exportJobId = incident-hold:<holdId>). A crashed sweep re-runs safely.
 */
export const EscalationStepsSchema = z
  .array(
    z
      .object({
        afterMinutes: z.number().int().min(0).max(7 * 24 * 60),
        channelIds: z.array(z.string().uuid()).min(1).max(20),
      })
      .strict()
  )
  .min(1)
  .max(10)
  .refine((steps) => steps.every((s, i) => i === 0 || s.afterMinutes > steps[i - 1].afterMinutes), 'steps must have increasing afterMinutes');

export interface WorkflowConfig {
  /** Seconds of video kept before / after a CRITICAL alarm. */
  holdPreSeconds: number;
  holdPostSeconds: number;
  holdDays: number;
  /** Time after windowEnd for the recorder to finalize the last segment before a hold is closed. */
  holdFinalizeGraceSeconds: number;
  /** Alarms older than this are not given new holds (a hold on long-rotated video pins nothing). */
  holdLookbackHours: number;
}

export function workflowConfigFromEnv(env = process.env): WorkflowConfig {
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  return {
    holdPreSeconds: n('INCIDENT_HOLD_PRE_SECONDS', 60),
    holdPostSeconds: n('INCIDENT_HOLD_POST_SECONDS', 120),
    holdDays: n('INCIDENT_HOLD_DAYS', 90),
    holdFinalizeGraceSeconds: n('INCIDENT_HOLD_FINALIZE_GRACE_SECONDS', 120),
    holdLookbackHours: n('INCIDENT_HOLD_LOOKBACK_HOURS', 24),
  };
}

export class WorkflowError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface SweepResult {
  slaStamped: number;
  ackBreaches: number;
  resolveBreaches: number;
  escalationsFired: number;
  holdsCreated: number;
  segmentsPinned: number;
  holdsCompleted: number;
  holdsFailed: number;
}

export class AlarmWorkflowService {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private prisma: PrismaClient,
    private notifications = new NotificationAdapter(prisma),
    private catalog = new RecordingCatalog(prisma),
    private cfg: WorkflowConfig = workflowConfigFromEnv()
  ) {}

  start(intervalMs = 15000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep().catch((e) => {
        MetricsService.incCounter('vigilone_alarm_workflow_sweep_failures_total', 'Alarm workflow sweeps that threw');
        console.error('[AlarmWorkflow] sweep failed:', e);
      });
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- assignment

  async assign(alarmId: string, assigneeUserId: string | null, ctx: { tenantId: string; actorUserId: string; clientIp?: string }) {
    const alarm = await this.prisma.alarm.findUnique({ where: { id: alarmId } });
    if (!alarm || alarm.tenantId !== ctx.tenantId) throw new WorkflowError(404, 'Alarm not found');
    if (alarm.state === 'RESOLVED') throw new WorkflowError(409, 'A resolved alarm cannot be reassigned');
    if (assigneeUserId) {
      const user = await this.prisma.user.findUnique({ where: { id: assigneeUserId } });
      if (!user || user.tenantId !== ctx.tenantId || (user as any).isActive === false) throw new WorkflowError(400, 'Assignee is not an active user of this tenant');
      if (!hasPermission(user.role, Permission.ALARM_MANAGE)) throw new WorkflowError(400, `Assignee role ${user.role} cannot manage alarms`);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.alarm.update({
        where: { id: alarmId },
        data: { assignedToUserId: assigneeUserId, assignedAt: assigneeUserId ? new Date() : null },
      });
      await AuditChainService.record(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.actorUserId,
        action: assigneeUserId ? 'ALARM_ASSIGN' : 'ALARM_UNASSIGN',
        resourceType: 'Alarm',
        resourceId: alarmId,
        ipAddress: ctx.clientIp || '127.0.0.1',
        metadata: { previousAssignee: alarm.assignedToUserId, assignee: assigneeUserId },
      });
      return updated;
    });
  }

  // ---------------------------------------------------------------- policies

  async upsertSlaPolicy(tenantId: string, actorUserId: string, input: { severity: EventSeverity; ackWithinMinutes: number; resolveWithinMinutes?: number | null }, ip?: string) {
    const parsed = z
      .object({
        severity: z.nativeEnum(EventSeverity),
        ackWithinMinutes: z.number().int().min(1).max(10080),
        resolveWithinMinutes: z.number().int().min(1).max(43200).nullable().optional(),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success) throw new WorkflowError(400, `Invalid SLA policy: ${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    const d = parsed.data;
    if (d.resolveWithinMinutes && d.resolveWithinMinutes < d.ackWithinMinutes) throw new WorkflowError(400, 'resolveWithinMinutes must be >= ackWithinMinutes');
    const row = await this.prisma.alarmSlaPolicy.upsert({
      where: { tenantId_severity: { tenantId, severity: d.severity } },
      create: { tenantId, severity: d.severity, ackWithinMinutes: d.ackWithinMinutes, resolveWithinMinutes: d.resolveWithinMinutes ?? null },
      update: { ackWithinMinutes: d.ackWithinMinutes, resolveWithinMinutes: d.resolveWithinMinutes ?? null },
    });
    await AuditChainService.record(this.prisma, {
      tenantId, userId: actorUserId, action: 'ALARM_SLA_POLICY_SET', resourceType: 'AlarmSlaPolicy', resourceId: row.id, ipAddress: ip || '127.0.0.1', metadata: d,
    });
    return row;
  }

  async createEscalationPolicy(tenantId: string, actorUserId: string, input: { name: string; minSeverity?: EventSeverity; steps: unknown; enabled?: boolean }, ip?: string) {
    if (!input?.name || typeof input.name !== 'string') throw new WorkflowError(400, 'name is required');
    const steps = EscalationStepsSchema.safeParse(input.steps);
    if (!steps.success) throw new WorkflowError(400, `Invalid escalation steps: ${steps.error.issues[0].path.join('.')}: ${steps.error.issues[0].message}`);
    const ids = [...new Set(steps.data.flatMap((s) => s.channelIds))];
    const owned = await this.prisma.notificationChannel.count({ where: { id: { in: ids }, tenantId } });
    if (owned !== ids.length) throw new WorkflowError(400, 'Every escalation channel must be a notification channel of this tenant');
    const minSeverity = input.minSeverity ?? EventSeverity.WARNING;
    if (!Object.values(EventSeverity).includes(minSeverity)) throw new WorkflowError(400, 'Invalid minSeverity');
    const row = await this.prisma.escalationPolicy.create({
      data: { tenantId, name: input.name.slice(0, 200), minSeverity, enabled: input.enabled !== false, stepsJson: steps.data },
    });
    await AuditChainService.record(this.prisma, {
      tenantId, userId: actorUserId, action: 'ESCALATION_POLICY_CREATE', resourceType: 'EscalationPolicy', resourceId: row.id, ipAddress: ip || '127.0.0.1',
      metadata: { name: row.name, minSeverity, steps: steps.data },
    });
    return row;
  }

  // ---------------------------------------------------------------- sweep

  async sweep(now = new Date()): Promise<SweepResult> {
    if (this.sweeping) return { slaStamped: 0, ackBreaches: 0, resolveBreaches: 0, escalationsFired: 0, holdsCreated: 0, segmentsPinned: 0, holdsCompleted: 0, holdsFailed: 0 };
    this.sweeping = true;
    try {
      const slaStamped = await this.stampSlaDeadlines();
      const { ack, resolve } = await this.markSlaBreaches(now);
      const escalationsFired = await this.fireEscalations(now);
      const holdsCreated = await this.createEvidenceHolds(now);
      const holds = await this.processEvidenceHolds(now);
      const r = { slaStamped, ackBreaches: ack, resolveBreaches: resolve, escalationsFired, holdsCreated, ...holds };
      const open = await this.prisma.alarm.count({ where: { state: 'ACTIVE', ackSlaBreachedAt: { not: null } } });
      MetricsService.setGauge('vigilone_alarms_ack_sla_breached_open', 'Unacknowledged alarms past their acknowledge deadline', undefined, open);
      return r;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Deadlines come from the tenant's policy for the alarm's severity. Policies are not
   * retroactive: alarms raised before the policy existed keep no deadline.
   */
  async stampSlaDeadlines(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE "Alarm" a
         SET "ackDueAt" = a."triggeredAt" + make_interval(mins => p."ackWithinMinutes"),
             "resolveDueAt" = CASE WHEN p."resolveWithinMinutes" IS NULL THEN NULL
                                   ELSE a."triggeredAt" + make_interval(mins => p."resolveWithinMinutes") END
        FROM "AlarmSlaPolicy" p
       WHERE p."tenantId" = a."tenantId" AND p."severity" = a."severity"
         AND a."ackDueAt" IS NULL AND a."state" <> 'RESOLVED'
         AND a."triggeredAt" >= p."createdAt"`;
  }

  private async markSlaBreaches(now: Date): Promise<{ ack: number; resolve: number }> {
    const ackRows = await this.prisma.alarm.findMany({
      where: { state: 'ACTIVE', ackDueAt: { lt: now }, ackSlaBreachedAt: null },
      select: { id: true, tenantId: true, severity: true, ackDueAt: true },
      take: 200,
    });
    let ack = 0;
    for (const a of ackRows) {
      const res = await this.prisma.alarm.updateMany({ where: { id: a.id, ackSlaBreachedAt: null, state: 'ACTIVE' }, data: { ackSlaBreachedAt: now } });
      if (res.count !== 1) continue;
      ack++;
      MetricsService.incCounter('vigilone_alarm_sla_breaches_total', 'Alarm SLA breaches', { kind: 'acknowledge', severity: a.severity });
      await AuditChainService.record(this.prisma, {
        tenantId: a.tenantId, userId: null, action: 'ALARM_SLA_BREACHED', resourceType: 'Alarm', resourceId: a.id, ipAddress: '127.0.0.1',
        metadata: { kind: 'acknowledge', dueAt: a.ackDueAt, detectedAt: now },
      });
    }
    const resRows = await this.prisma.alarm.findMany({
      where: { state: { not: 'RESOLVED' }, resolveDueAt: { lt: now }, resolveSlaBreachedAt: null },
      select: { id: true, tenantId: true, severity: true, resolveDueAt: true },
      take: 200,
    });
    let resolve = 0;
    for (const a of resRows) {
      const res = await this.prisma.alarm.updateMany({ where: { id: a.id, resolveSlaBreachedAt: null, state: { not: 'RESOLVED' } }, data: { resolveSlaBreachedAt: now } });
      if (res.count !== 1) continue;
      resolve++;
      MetricsService.incCounter('vigilone_alarm_sla_breaches_total', 'Alarm SLA breaches', { kind: 'resolve', severity: a.severity });
      await AuditChainService.record(this.prisma, {
        tenantId: a.tenantId, userId: null, action: 'ALARM_SLA_BREACHED', resourceType: 'Alarm', resourceId: a.id, ipAddress: '127.0.0.1',
        metadata: { kind: 'resolve', dueAt: a.resolveDueAt, detectedAt: now },
      });
    }
    return { ack, resolve };
  }

  /** Steps fire while the alarm stays ACTIVE (unacknowledged); acknowledging stops escalation. */
  private async fireEscalations(now: Date): Promise<number> {
    const rank: Record<EventSeverity, number> = { INFO: 1, WARNING: 2, CRITICAL: 3 };
    const policies = await this.prisma.escalationPolicy.findMany({ where: { enabled: true } });
    let fired = 0;
    for (const policy of policies) {
      const steps = EscalationStepsSchema.safeParse(policy.stepsJson);
      if (!steps.success) {
        MetricsService.incCounter('vigilone_escalation_policy_invalid_total', 'Escalation policies skipped because stepsJson is invalid', { policy_id: policy.id });
        continue;
      }
      const severities = (Object.keys(rank) as EventSeverity[]).filter((s) => rank[s] >= rank[policy.minSeverity]);
      const maxAfter = steps.data[steps.data.length - 1].afterMinutes;
      const alarms = await this.prisma.alarm.findMany({
        where: {
          tenantId: policy.tenantId,
          state: 'ACTIVE',
          severity: { in: severities },
          // The policy applies to alarms raised after it existed, and only until its last step.
          triggeredAt: { gte: policy.createdAt, lte: now },
        },
        include: { camera: { select: { name: true } } },
        take: 500,
      });
      for (const alarm of alarms) {
        const elapsedMin = (now.getTime() - alarm.triggeredAt.getTime()) / 60000;
        if (elapsedMin > maxAfter + 24 * 60) continue;
        for (let i = 0; i < steps.data.length; i++) {
          const step = steps.data[i];
          if (elapsedMin < step.afterMinutes) break;
          try {
            await this.prisma.alarmEscalation.create({ data: { alarmId: alarm.id, policyId: policy.id, stepIndex: i, channelIds: step.channelIds } });
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue; // already fired
            throw e;
          }
          const queued = await this.notifications.enqueueAlarmNotifications({
            tenantId: alarm.tenantId,
            alarmId: alarm.id,
            title: alarm.title,
            description: alarm.description,
            severity: alarm.severity,
            cameraName: alarm.camera?.name,
            channelIds: step.channelIds,
            escalationStep: i,
          });
          await this.prisma.alarmEscalation.update({
            where: { alarmId_policyId_stepIndex: { alarmId: alarm.id, policyId: policy.id, stepIndex: i } },
            data: { notificationsQueued: queued },
          });
          fired++;
          MetricsService.incCounter('vigilone_alarm_escalations_total', 'Escalation steps fired', { step: String(i) });
          await AuditChainService.record(this.prisma, {
            tenantId: alarm.tenantId, userId: null, action: 'ALARM_ESCALATED', resourceType: 'Alarm', resourceId: alarm.id, ipAddress: '127.0.0.1',
            metadata: { policyId: policy.id, stepIndex: i, afterMinutes: step.afterMinutes, channelIds: step.channelIds, notificationsQueued: queued },
          });
        }
      }
    }
    return fired;
  }

  /** Every CRITICAL alarm on a camera gets a hold over [triggeredAt - pre, triggeredAt + post]. */
  private async createEvidenceHolds(now: Date): Promise<number> {
    const since = new Date(now.getTime() - this.cfg.holdLookbackHours * 3600_000);
    return this.prisma.$executeRaw`
      INSERT INTO "IncidentEvidenceHold" ("id", "tenantId", "alarmId", "cameraId", "windowStart", "windowEnd", "expiresAt", "status")
      SELECT gen_random_uuid()::text, a."tenantId", a."id", a."cameraId",
             a."triggeredAt" - make_interval(secs => ${this.cfg.holdPreSeconds}::double precision),
             a."triggeredAt" + make_interval(secs => ${this.cfg.holdPostSeconds}::double precision),
             a."triggeredAt" + make_interval(days => ${Math.round(this.cfg.holdDays)}::int),
             'PENDING'
        FROM "Alarm" a
       WHERE a."severity" = 'CRITICAL' AND a."cameraId" IS NOT NULL AND a."triggeredAt" >= ${since}
      ON CONFLICT ("alarmId", "cameraId") DO NOTHING`;
  }

  /**
   * Pins every segment overlapping a pending hold's window. Segments still being written are
   * pinned on a later sweep; the hold closes once the window plus the finalize grace has passed.
   */
  private async processEvidenceHolds(now: Date): Promise<{ segmentsPinned: number; holdsCompleted: number; holdsFailed: number }> {
    const holds = await this.prisma.incidentEvidenceHold.findMany({ where: { status: 'PENDING' }, orderBy: { windowEnd: 'asc' }, take: 100 });
    let segmentsPinned = 0;
    let holdsCompleted = 0;
    let holdsFailed = 0;
    for (const hold of holds) {
      const jobId = `incident-hold:${hold.id}`;
      try {
        const segments = await this.catalog.findSegments(hold.cameraId, hold.windowStart, hold.windowEnd);
        const already = new Set(
          (await this.prisma.evidencePin.findMany({ where: { exportJobId: jobId }, select: { segmentId: true } })).map((p) => p.segmentId)
        );
        const days = Math.max(1, Math.ceil((hold.expiresAt.getTime() - now.getTime()) / 86400_000));
        for (const seg of segments) {
          if (already.has(seg.id)) continue;
          await this.catalog.pinSegment(hold.tenantId, seg.id, jobId, `Incident hold for alarm ${hold.alarmId}`, days, 'INCIDENT_HOLD');
          already.add(seg.id);
          segmentsPinned++;
        }
        const closed = now.getTime() > hold.windowEnd.getTime() + this.cfg.holdFinalizeGraceSeconds * 1000;
        if (!closed) {
          if (already.size !== hold.segmentsPinned) await this.prisma.incidentEvidenceHold.update({ where: { id: hold.id }, data: { segmentsPinned: already.size } });
          continue;
        }
        if (already.size === 0) {
          holdsFailed++;
          await this.prisma.incidentEvidenceHold.update({
            where: { id: hold.id },
            data: { status: 'FAILED', lastError: 'NO_RECORDING_SEGMENTS_IN_WINDOW: nothing was recorded for this camera around the alarm', completedAt: now },
          });
          MetricsService.incCounter('vigilone_incident_holds_total', 'Incident evidence holds closed', { result: 'failed' });
          await AuditChainService.record(this.prisma, {
            tenantId: hold.tenantId, userId: null, action: 'INCIDENT_HOLD_FAILED', resourceType: 'Alarm', resourceId: hold.alarmId, ipAddress: '127.0.0.1',
            metadata: { holdId: hold.id, cameraId: hold.cameraId, windowStart: hold.windowStart, windowEnd: hold.windowEnd, reason: 'NO_RECORDING_SEGMENTS_IN_WINDOW' },
          });
          continue;
        }
        holdsCompleted++;
        await this.prisma.incidentEvidenceHold.update({ where: { id: hold.id }, data: { status: 'COMPLETE', segmentsPinned: already.size, completedAt: now, lastError: null } });
        MetricsService.incCounter('vigilone_incident_holds_total', 'Incident evidence holds closed', { result: 'complete' });
        await AuditChainService.record(this.prisma, {
          tenantId: hold.tenantId, userId: null, action: 'INCIDENT_HOLD_APPLIED', resourceType: 'Alarm', resourceId: hold.alarmId, ipAddress: '127.0.0.1',
          metadata: { holdId: hold.id, cameraId: hold.cameraId, windowStart: hold.windowStart, windowEnd: hold.windowEnd, segmentsPinned: already.size, expiresAt: hold.expiresAt },
        });
      } catch (e: any) {
        // Keep PENDING and retry next sweep; the error is visible on the hold.
        await this.prisma.incidentEvidenceHold.update({ where: { id: hold.id }, data: { lastError: String(e.message).slice(0, 500) } }).catch(() => undefined);
        MetricsService.incCounter('vigilone_incident_hold_errors_total', 'Errors while applying incident evidence holds');
      }
    }
    return { segmentsPinned, holdsCompleted, holdsFailed };
  }
}
