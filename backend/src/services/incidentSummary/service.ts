import { PrismaClient } from '@prisma/client';
import { AuditChainService } from '../audit/auditChain.service';
import { buildIncidentSummaryRecord, IncidentSummaryFactsError } from './summary';
import { collectIncidentSummaryFacts, IncidentSummaryError } from './collect';
import { INCIDENT_SUMMARY_TEMPLATE_V1, IncidentSummaryRecordV1 } from './types';

export { IncidentSummaryError } from './collect';

export interface GenerateOutcome {
  record: IncidentSummaryRecordV1;
  /** False when a stored record already existed for the same facts (returned unchanged, nothing audited). */
  created: boolean;
}

/**
 * Generates a snapshot of the incident's story and stores it, with an audit-chain entry that carries the record hash.
 * Records are immutable: the same facts return the stored record; changed facts (the incident moved on) make a new one.
 */
export async function generateIncidentSummary(
  prisma: PrismaClient,
  ctx: { tenantId: string; userId: string; clientIp?: string; userAgent?: string },
  alarmId: string,
  now: Date = new Date()
): Promise<GenerateOutcome> {
  const factsInput = await collectIncidentSummaryFacts(prisma, ctx.tenantId, alarmId);
  let record: IncidentSummaryRecordV1;
  try {
    record = buildIncidentSummaryRecord(factsInput, now, INCIDENT_SUMMARY_TEMPLATE_V1);
  } catch (err) {
    if (err instanceof IncidentSummaryFactsError) throw new IncidentSummaryError(422, 'SUMMARY_FACTS_REJECTED', err.message);
    throw err;
  }

  const existing = await prisma.incidentSummary.findUnique({ where: { summaryId: record.summaryId } });
  if (existing) return { record: existing.recordJson as unknown as IncidentSummaryRecordV1, created: false };

  const raised = record.facts.timeline.find((f) => f.kind === 'ALARM_RAISED')!;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.incidentSummary.create({
        data: {
          tenantId: ctx.tenantId,
          alarmId,
          cameraId: record.facts.subject.cameraId,
          alarmTriggeredAt: new Date(raised.atUtc),
          summaryId: record.summaryId,
          templateVersion: record.templateVersion,
          factsSha256: record.factsSha256,
          recordSha256: record.recordSha256,
          recordJson: record as any,
          generatedById: ctx.userId,
          generatedAt: new Date(record.generatedAtUtc),
        },
      });
      await AuditChainService.record(tx, {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: 'INCIDENT_SUMMARY_CREATED',
        resourceType: 'Alarm',
        resourceId: alarmId,
        ipAddress: ctx.clientIp || '127.0.0.1',
        userAgent: ctx.userAgent || null,
        metadata: { alarmId, summaryId: record.summaryId, templateVersion: record.templateVersion, factsSha256: record.factsSha256, recordSha256: record.recordSha256, facts: record.facts.timeline.length },
      });
    });
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err;
    const stored = await prisma.incidentSummary.findUnique({ where: { summaryId: record.summaryId } });
    if (!stored) throw err;
    return { record: stored.recordJson as unknown as IncidentSummaryRecordV1, created: false };
  }
  return { record, created: true };
}

/** The newest stored snapshot for an alarm, or null. */
export async function latestIncidentSummary(prisma: PrismaClient, tenantId: string, alarmId: string): Promise<IncidentSummaryRecordV1 | null> {
  const alarm = await prisma.alarm.findUnique({ where: { id: alarmId }, select: { tenantId: true } });
  if (!alarm || alarm.tenantId !== tenantId) throw new IncidentSummaryError(404, 'ALARM_NOT_FOUND', 'Alarm not found');
  const row = await prisma.incidentSummary.findFirst({ where: { tenantId, alarmId }, orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }] });
  if (!row) return null;
  const rec = row.recordJson as unknown as IncidentSummaryRecordV1;
  if (rec?.summaryId !== row.summaryId || rec?.recordSha256 !== row.recordSha256) {
    throw new IncidentSummaryError(500, 'SUMMARY_ROW_MISMATCH', `stored summary ${row.id} does not match its own row (summaryId or recordSha256)`);
  }
  return rec;
}

/** The newest snapshot per alarm for alarms raised on a camera inside [start, end], for an evidence export. */
export async function loadIncidentSummaryRecords(prisma: PrismaClient, tenantId: string, cameraId: string, start: Date, end: Date): Promise<IncidentSummaryRecordV1[]> {
  const rows = await prisma.incidentSummary.findMany({
    where: { tenantId, cameraId, alarmTriggeredAt: { gte: start, lte: end } },
    orderBy: [{ generatedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.alarmId)) latest.set(r.alarmId, r);
  return [...latest.values()].map((r) => {
    const rec = r.recordJson as unknown as IncidentSummaryRecordV1;
    if (!rec || rec.summaryId !== r.summaryId || rec.recordSha256 !== r.recordSha256) {
      throw new IncidentSummaryError(500, 'SUMMARY_ROW_MISMATCH', `stored summary ${r.id} does not match its own row (summaryId or recordSha256)`);
    }
    return rec;
  });
}
