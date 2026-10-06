/**
 * ADR 0016 on the real database and the real app: facts are collected only from rows that exist, the summary cites them, it
 * is stored immutably (a snapshot per set of facts), audited into the chain, permission-checked, tenant-scoped and flagged.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTenantWithCamera, createUserWithToken, startApp } from './helpers/realDb';
import { verifyIncidentSummaryRecord } from '../services/incidentSummary/summary';

jest.setTimeout(60000);

const prisma = new PrismaClient();
let app: { url: string; close: () => Promise<void> };
let tenantId = '';
let cameraId = '';
let siteId = '';
let cam2 = '';
let otherTenant = '';
let admin = { userId: '', token: '' };
let operator = { userId: '', token: '' };
let viewer = { userId: '', token: '' };
let otherAdmin = { userId: '', token: '' };
const PLATE = 'MH12AB1234';
const HEX = 'c'.repeat(64);
const T0 = Date.parse('2026-10-05T19:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000);

async function call(user: { token: string }, method: string, p: string) {
  const r = await fetch(`${app.url}/api/v1/incident-summaries${p}`, { method, headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' } });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

async function ruleAlarm(over: Record<string, any> = {}, payload: Record<string, any> = {}, eventType = 'LOITERING_DWELL') {
  const rule = await prisma.automationRule.create({
    data: { tenantId, name: `r-${crypto.randomBytes(3).toString('hex')}`, triggerType: 'LOITERING_DWELL', triggerConfigJson: {}, conditionsJson: {}, actionsJson: [{ id: 'a', type: 'TRIGGER_ALARM', config: {} }] },
  });
  const ev = await prisma.canonicalEvent.create({
    data: {
      id: `ev_${crypto.randomUUID()}`, tenantId, cameraId, type: eventType, source: 'edge', severity: 'WARNING', timestampUtc: at(100), correlationId: `corr_${crypto.randomUUID()}`,
      payloadJson: { payload: { kind: 'LOITERING_DWELL', trackId: 'trk-9', zoneId: 'zone-a', dwellTimeSeconds: 95, thresholdSeconds: 60, ...payload }, title: 'x' },
    },
  });
  return prisma.alarm.create({ data: { tenantId, cameraId, title: 'Loitering at gate', severity: 'WARNING', triggeredAt: at(101), automationRuleId: rule.id, canonicalEventId: ev.id, ...over } });
}

beforeAll(async () => {
  process.env.VIGILONE_FEATURE_INCIDENT_SUMMARY = 'true';
  ({ tenantId, cameraId, siteId } = await createTenantWithCamera(prisma, 'isum'));
  ({ tenantId: otherTenant } = await createTenantWithCamera(prisma, 'isum-other'));
  cam2 = (await prisma.camera.create({ data: { tenantId, siteId, name: 'Loading bay', streamPath: `lb_${Date.now()}`, ipAddress: '127.0.0.2', mainRtspUri: 'rtsp://127.0.0.2/x' } })).id;
  admin = await createUserWithToken(prisma, tenantId, 'TENANT_ADMIN');
  operator = await createUserWithToken(prisma, tenantId, 'OPERATOR');
  viewer = await createUserWithToken(prisma, tenantId, 'VIEWER');
  otherAdmin = await createUserWithToken(prisma, otherTenant, 'TENANT_ADMIN');
  app = await startApp();
});
afterAll(async () => {
  delete process.env.VIGILONE_FEATURE_INCIDENT_SUMMARY;
  for (const id of [tenantId, otherTenant]) await prisma.tenant.delete({ where: { id } }).catch(() => undefined);
  await app?.close();
  await prisma.$disconnect();
});
afterEach(async () => {
  await prisma.alarm.deleteMany({ where: { tenantId } });
  await prisma.automationRule.deleteMany({ where: { tenantId } });
  await prisma.canonicalEvent.deleteMany({ where: { tenantId } });
  await prisma.objectTrack.deleteMany({ where: { tenantId } });
});

describe('incident summary API (ADR 0016)', () => {
  it('answers 501 FEATURE_DISABLED while the flag is off', async () => {
    const a = await ruleAlarm();
    delete process.env.VIGILONE_FEATURE_INCIDENT_SUMMARY;
    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    process.env.VIGILONE_FEATURE_INCIDENT_SUMMARY = 'true';
    expect([r.status, r.json.code]).toEqual([501, 'FEATURE_DISABLED']);
  });

  it('tells the story of a rule alarm from recorded rows, cites every fact, and the record verifies', async () => {
    const a = await ruleAlarm({ occurrenceCount: 3, lastActivityAt: at(160), state: 'RESOLVED', acknowledgedAt: at(200), acknowledgedById: operator.userId, resolvedAt: at(400), resolvedById: operator.userId, resolutionNotes: `saw ${PLATE} leave` });
    await prisma.vlmVerification.create({
      data: { tenantId, alarmId: a.id, cameraId, imageSource: 'SNAPSHOT', imageSha256: 'a'.repeat(64), targetClass: 'person', answer: 'yes', reason: `reads ${PLATE}`, promptSha256: 'b'.repeat(64), modelName: 'smolvlm2', modelVersion: '2.2b', modelSha256: HEX, adapterId: 'x', inferenceId: crypto.randomUUID(), provenanceJson: {}, latencyMs: 5, createdAt: at(110) },
    });
    await prisma.alarmFeedback.create({ data: { tenantId, alarmId: a.id, verdict: 'TRUE_ALARM', reason: `plate ${PLATE}`, userId: operator.userId, cameraId, updatedAt: at(300) } });
    await prisma.incidentEvidenceHold.create({ data: { tenantId, alarmId: a.id, cameraId, windowStart: at(40), windowEnd: at(400), expiresAt: at(86400), status: 'COMPLETE', createdAt: at(102) } });

    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    expect(r.status).toBe(201);
    const rec = r.json.record;
    expect(verifyIncidentSummaryRecord(rec)).toEqual([]);
    expect(rec.facts.timeline.map((f: any) => f.kind)).toEqual(['TRIGGER_EVENT', 'ALARM_RAISED', 'EVIDENCE_HOLD', 'SECOND_OPINION', 'ALARM_REPEATED', 'ACKNOWLEDGED', 'VERDICT', 'RESOLVED']);
    const cited = new Set(rec.sentences.flatMap((s: any) => s.cites));
    expect(rec.facts.timeline.every((f: any) => cited.has(f.id))).toBe(true);
    expect(rec.text).toContain('stayed in zone "zone-a" for 95 seconds');
    expect(rec.text).toContain('with a written reason (not repeated here)');
    expect(rec.text).toContain('with resolution notes (not repeated here)');
    // Nothing a person typed, and no plate, anywhere in the stored record.
    expect(JSON.stringify(rec)).not.toContain(PLATE);
    const row = await prisma.incidentSummary.findFirstOrThrow({ where: { alarmId: a.id } });
    expect(row.summaryId).toBe(rec.summaryId);
    expect(row.recordSha256).toBe(rec.recordSha256);
  });

  it('writes the record hash into the audit chain', async () => {
    const a = await ruleAlarm();
    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    const entry = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId, action: 'INCIDENT_SUMMARY_CREATED', resourceId: a.id } });
    expect((entry.metadataJson as any).recordSha256).toBe(r.json.record.recordSha256);
    expect((entry.metadataJson as any).summaryId).toBe(r.json.record.summaryId);
    expect(entry.userId).toBe(operator.userId);
  });

  it('never repeats a plate that is in the trigger payload', async () => {
    const a = await ruleAlarm({}, { kind: 'ANPR_MATCH', plateText: PLATE, confidence: 0.97, watchlistCategory: 'BLOCKED' }, 'ANPR_MATCH');
    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    expect(r.status).toBe(201);
    expect(r.json.record.text).toMatch(/number plate was read.*withheld/);
    expect(JSON.stringify(r.json.record)).not.toContain(PLATE);
  });

  it('generating twice for the same facts returns the same record; a changed incident gets a new snapshot, and the old one stays', async () => {
    const a = await ruleAlarm();
    const first = await call(operator, 'POST', `/alarms/${a.id}`);
    const again = await call(operator, 'POST', `/alarms/${a.id}`);
    expect([again.status, again.json.created, again.json.record.summaryId]).toEqual([200, false, first.json.record.summaryId]);
    await prisma.alarm.update({ where: { id: a.id }, data: { state: 'ACKNOWLEDGED', acknowledgedAt: at(500), acknowledgedById: operator.userId } });
    const next = await call(operator, 'POST', `/alarms/${a.id}`);
    expect(next.status).toBe(201);
    expect(next.json.record.summaryId).not.toBe(first.json.record.summaryId);
    expect(await prisma.incidentSummary.count({ where: { alarmId: a.id } })).toBe(2);
    const latest = await call(viewer, 'GET', `/alarms/${a.id}`);
    expect(latest.json.record.summaryId).toBe(next.json.record.summaryId);
  });

  it('a journey alarm: its tracks with their zones and the operator-confirmed link, by id and method only', async () => {
    const mk = (cam: string, name: string, from: number, to: number, extra: any = {}) =>
      prisma.objectTrack.create({ data: { tenantId, cameraId: cam, trackId: `w-${name}`, objectClass: 'person', classVotesJson: {}, firstSeenAt: at(from), lastSeenAt: at(to), dwellSeconds: to - from, pathJson: [], zonesJson: [], colourVotesJson: {}, upperColour: 'red', ...extra } });
    const t1 = await mk(cameraId, 'a', 10, 50, { direction: 'RIGHT', zonesJson: [{ zoneId: 'z1', name: 'Gate', enteredAt: at(15).toISOString(), exitedAt: at(40).toISOString() }] });
    const t2 = await mk(cam2, 'b', 80, 120);
    const [x, y] = [t1.id, t2.id].sort();
    const link = await prisma.trackLink.create({ data: { tenantId, fromTrackId: x, toTrackId: y, method: 'APPEARANCE', status: 'CONFIRMED', evidenceJson: { plate: PLATE }, decidedByUserId: operator.userId, decidedAt: at(130) } });
    const a = await prisma.alarm.create({
      data: {
        tenantId, cameraId, title: 'Journey', severity: 'WARNING', triggeredAt: at(140),
        metadataJson: { source: 'JOURNEY', objectClass: 'person', steps: [{ trackId: t1.id, cameraId, firstSeenAt: at(10).toISOString(), lastSeenAt: at(50).toISOString() }, { trackId: t2.id, cameraId: cam2, firstSeenAt: at(80).toISOString(), lastSeenAt: at(120).toISOString() }], linkIds: [link.id] },
      },
    });
    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    expect(r.status).toBe(201);
    const text: string = r.json.record.text;
    expect(text).toMatch(/was seen on camera "[^"]+" from .*moving RIGHT, visiting zone "Gate"/);
    expect(text).toContain('on camera "Loading bay"');
    expect(text).toMatch(/confirmed by appearance that tracks/);
    expect(text).toMatch(/opened from a confirmed journey/);
    expect(JSON.stringify(r.json.record)).not.toContain(PLATE);
    expect(text).not.toMatch(/\bred\b/); // the track's recorded appearance is not repeated
    expect(verifyIncidentSummaryRecord(r.json.record)).toEqual([]);
  });

  it('a journey whose track row has since been deleted still states the sighting recorded in the alarm', async () => {
    const a = await prisma.alarm.create({
      data: { tenantId, cameraId, title: 'Journey', severity: 'WARNING', triggeredAt: at(140), metadataJson: { source: 'JOURNEY', objectClass: 'vehicle', steps: [{ trackId: crypto.randomUUID(), cameraId, firstSeenAt: at(10).toISOString(), lastSeenAt: at(50).toISOString() }], linkIds: [] } },
    });
    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    expect(r.status).toBe(201);
    expect(r.json.record.text).toMatch(/\(vehicle\) was seen on camera/);
  });

  it('permissions: a viewer may read but not generate; another tenant sees nothing', async () => {
    const a = await ruleAlarm();
    expect((await call(viewer, 'POST', `/alarms/${a.id}`)).status).toBe(403);
    await call(operator, 'POST', `/alarms/${a.id}`);
    expect((await call(viewer, 'GET', `/alarms/${a.id}`)).status).toBe(200);
    expect((await call(otherAdmin, 'POST', `/alarms/${a.id}`)).status).toBe(404);
    expect((await call(otherAdmin, 'GET', `/alarms/${a.id}`)).status).toBe(404);
    expect((await call(admin, 'GET', `/alarms/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('reading an alarm with no summary yet answers 404 NO_SUMMARY, not an empty record', async () => {
    const a = await ruleAlarm();
    const r = await call(viewer, 'GET', `/alarms/${a.id}`);
    expect([r.status, r.json.code]).toEqual([404, 'NO_SUMMARY']);
  });

  it('refuses to summarise an alarm whose recorded values cannot be stated, instead of patching them', async () => {
    const a = await prisma.alarm.create({
      data: { tenantId, cameraId, title: 'Journey', severity: 'WARNING', triggeredAt: at(140), metadataJson: { source: 'JOURNEY', objectClass: 'person', steps: [{ trackId: crypto.randomUUID(), cameraId }], linkIds: [] } },
    });
    const r = await call(operator, 'POST', `/alarms/${a.id}`);
    expect(r.status).toBe(422);
    expect(r.json.code).toBe('SUMMARY_FACTS_REJECTED');
    expect(await prisma.incidentSummary.count({ where: { alarmId: a.id } })).toBe(0);
  });
});
