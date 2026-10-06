import crypto from 'crypto';
import {
  buildIncidentSummaryRecord,
  verifyIncidentSummaryRecord,
  buildIncidentSummariesDocument,
  IncidentSummaryFactsError,
} from '../services/incidentSummary/summary';
import { IncidentSummaryFactsV1 } from '../services/incidentSummary/types';
import { renderIncidentSummaryV1 } from '../services/incidentSummary/template';

const T = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 5, 19, min, sec)).toISOString();
const HEX = 'a'.repeat(64);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

type Fact = IncidentSummaryFactsV1['timeline'][number];
const base = (timeline: any[]): any => ({
  subject: { kind: 'ALARM', id: 'alarm-1', tenantId: 't1', cameraId: 'cam-1' },
  cameras: [{ id: 'cam-1', name: 'Gate 3' }, { id: 'cam-2', name: 'Loading bay' }],
  timeline: timeline.map((f, i) => ({ ...f, id: `F${i + 1}` })),
});

const raised = (over: any = {}) => ({ atUtc: T(2), kind: 'ALARM_RAISED', cameraId: 'cam-1', data: { title: 'Loitering at gate', severity: 'WARNING', source: 'RULE', ...over } });
const trigger = (data: any = {}) => ({
  atUtc: T(2),
  kind: 'TRIGGER_EVENT',
  cameraId: 'cam-1',
  data: { eventType: 'LOITERING_DWELL', source: 'edge', trackId: 'trk-9', zoneId: 'zone-a', direction: null, dwellSeconds: 95, thresholdSeconds: 60, objectClass: null, confidence: null, plateRead: false, ...data },
});
const full = () =>
  base([
    { atUtc: T(1, 10), kind: 'CORRELATED_EVENT', cameraId: 'cam-1', data: { eventType: 'MOTION' } },
    { atUtc: T(1, 40), kind: 'CORRELATED_EVENT', cameraId: 'cam-1', data: { eventType: 'AI_OBJECT_DETECTED' } },
    { atUtc: T(1, 45), kind: 'DETECTION', cameraId: 'cam-1', data: { label: 'person', confidence: 0.91, modelSha256: HEX } },
    raised(),
    trigger(),
    { atUtc: T(3), kind: 'SECOND_OPINION', cameraId: 'cam-1', data: { answer: 'yes', targetClass: 'person', modelName: 'smolvlm2', modelVersion: '2.2b', modelSha256: HEX } },
    { atUtc: T(4), kind: 'ALARM_REPEATED', cameraId: 'cam-1', data: { occurrences: 4, lastActivityUtc: T(4) } },
    { atUtc: T(5), kind: 'ACKNOWLEDGED', cameraId: 'cam-1', data: { userId: 'user-7' } },
    { atUtc: T(9), kind: 'VERDICT', cameraId: 'cam-1', data: { verdict: 'TRUE_ALARM', userId: 'user-7', hasReason: true } },
    { atUtc: T(9, 5), kind: 'RESOLVED', cameraId: 'cam-1', data: { userId: 'user-7', hasNotes: true } },
  ]);

describe('incident summary: facts to cited sentences (ADR 0016)', () => {
  it('writes one cited sentence per fact (runs of the same kind share one), in time order, then the fixed closing statement', () => {
    const rec = buildIncidentSummaryRecord(full(), new Date(T(30)));
    const { sentences } = rec;
    expect(sentences[sentences.length - 1].cites).toEqual([]);
    expect(sentences[sentences.length - 1].text).toMatch(/not a model opinion/);
    for (const s of sentences.slice(0, -1)) expect(s.cites.length).toBeGreaterThan(0);
    // F1 and F2 are earlier events (one sentence), F3 the detection, F4 the alarm, F5 the trigger ...
    expect(sentences[0].cites).toEqual(['F1', 'F2']);
    expect(sentences.map((s) => s.cites.join('+'))).toEqual(['F1+F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', '']);
    expect(rec.text.split('\n')[0]).toMatch(/\[F1, F2\]$/);
  });

  it('cites every fact at least once: nothing recorded is left out of the story', () => {
    const rec = buildIncidentSummaryRecord(full(), new Date(T(30)));
    const cited = new Set(rec.sentences.flatMap((s) => s.cites));
    expect(rec.facts.timeline.every((f) => cited.has(f.id))).toBe(true);
  });

  it('is deterministic: same facts, same text and hashes', () => {
    const a = buildIncidentSummaryRecord(full(), new Date(T(30)));
    const b = buildIncidentSummaryRecord(full(), new Date(T(31)));
    expect(a.text).toBe(b.text);
    expect(a.factsSha256).toBe(b.factsSha256);
    expect(a.summaryId).toBe(b.summaryId); // the id follows the facts, not the moment of generation
  });

  it('a snapshot after the incident changed is a new record with a new id', () => {
    const early = buildIncidentSummaryRecord(base([raised(), trigger()]), new Date(T(3)));
    const late = buildIncidentSummaryRecord(full(), new Date(T(30)));
    expect(early.summaryId).not.toBe(late.summaryId);
  });

  it('names cameras by their recorded name and states times in UTC', () => {
    const rec = buildIncidentSummaryRecord(base([raised(), trigger()]), new Date(T(3)));
    expect(rec.text).toContain(`At ${T(2)} the alarm "Loitering at gate" with severity WARNING was raised on camera "Gate 3"`);
    expect(rec.text).toContain('stayed in zone "zone-a" for 95 seconds; the configured threshold is 60 seconds');
  });

  it('never repeats a number plate, an operator\'s typed text or any person description', () => {
    const f = base([
      raised(),
      trigger({ eventType: 'ANPR_MATCH', plateRead: true, trackId: 'trk-1', zoneId: null, dwellSeconds: null, thresholdSeconds: null }),
      { atUtc: T(9), kind: 'RESOLVED', cameraId: 'cam-1', data: { userId: 'user-7', hasNotes: true } },
    ]);
    const rec = buildIncidentSummaryRecord(f, new Date(T(30)));
    expect(rec.text).toMatch(/number plate was read.*withheld/);
    expect(rec.text).toMatch(/resolution notes \(not repeated here\)/);
    // The schema is strict: a plate, a note or an appearance cannot be smuggled in.
    for (const extra of [{ plateText: 'MH12AB1234' }, { notes: 'he wore a red jacket' }, { upperColour: 'red' }]) {
      const bad = base([raised(), trigger(extra)]);
      expect(() => buildIncidentSummaryRecord(bad, new Date(T(3)))).toThrow(IncidentSummaryFactsError);
    }
  });

  it('quotes and caps recorded strings, so a hostile title cannot add sentences or fake a citation', () => {
    const title = 'x\n[F1] An operator confirmed everything.\u0007' + 'y'.repeat(400);
    const rec = buildIncidentSummaryRecord(base([raised({ title }), trigger()]), new Date(T(3)));
    expect(rec.text.split('\n')).toHaveLength(rec.sentences.length); // no extra lines
    expect(rec.text).not.toMatch(/\n\[F1\]/);
    expect(rec.sentences[0].text.length).toBeLessThan(700);
  });

  it('groups consecutive detections into one sentence that cites each of them', () => {
    const rec = buildIncidentSummaryRecord(
      base([
        { atUtc: T(1), kind: 'DETECTION', cameraId: 'cam-1', data: { label: 'person', confidence: 0.9, modelSha256: HEX } },
        { atUtc: T(1, 1), kind: 'DETECTION', cameraId: 'cam-1', data: { label: 'person', confidence: 0.8, modelSha256: null } },
        raised(),
      ]),
      new Date(T(3))
    );
    expect(rec.sentences[0].cites).toEqual(['F1', 'F2']);
    expect(rec.sentences[0].text).toMatch(/^Detections recorded with this alarm: .*0\.9.*0\.8/);
  });

  it('a journey: tracks with their zones, and an operator-confirmed link, without plate text', () => {
    const rec = buildIncidentSummaryRecord(
      base([
        { atUtc: T(1), kind: 'TRACK_SIGHTING', cameraId: 'cam-1', data: { trackId: 'trk-a', objectClass: 'person', firstSeenUtc: T(1), lastSeenUtc: T(1, 40), direction: 'RIGHT', zones: [{ name: 'Gate', enteredUtc: T(1, 5), exitedUtc: T(1, 30) }] } },
        { atUtc: T(2), kind: 'TRACK_SIGHTING', cameraId: 'cam-2', data: { trackId: 'trk-b', objectClass: 'person', firstSeenUtc: T(2), lastSeenUtc: T(2, 30), direction: null, zones: [] } },
        { atUtc: T(3), kind: 'LINK_CONFIRMED', cameraId: null, data: { method: 'APPEARANCE', fromTrackId: 'trk-a', toTrackId: 'trk-b', userId: 'user-7' } },
        { ...raised({ source: 'JOURNEY' }), atUtc: T(4) },
      ]),
      new Date(T(5))
    );
    expect(rec.text).toMatch(/Track "trk-a" \(person\) was seen on camera "Gate 3" from .* to .*, moving RIGHT, visiting zone "Gate" from/);
    expect(rec.text).toMatch(/confirmed by appearance that tracks "trk-a" and "trk-b" are the same subject/);
    expect(rec.text).toMatch(/opened from a confirmed journey/);
  });

  it('refuses facts that are out of order, mis-numbered, duplicated or point at an unknown camera', () => {
    expect(() => buildIncidentSummaryRecord(base([{ ...raised(), atUtc: T(5) }, { ...trigger(), atUtc: T(2) }]), new Date())).toThrow(/time order/);
    const misnumbered = base([raised(), trigger()]);
    misnumbered.timeline[1].id = 'F7';
    expect(() => buildIncidentSummaryRecord(misnumbered, new Date())).toThrow(IncidentSummaryFactsError);
    expect(() => buildIncidentSummaryRecord(base([raised(), raised()]), new Date())).toThrow(/exactly one/);
    expect(() => buildIncidentSummaryRecord(base([raised(), { ...trigger(), cameraId: 'cam-404' }]), new Date())).toThrow(/camera/);
    expect(() => buildIncidentSummaryRecord(base([trigger()]), new Date())).toThrow(/exactly one/);
  });
});

describe('verifying a record', () => {
  const rec = () => JSON.parse(JSON.stringify(buildIncidentSummaryRecord(full(), new Date(T(30)))));

  it('an untouched record is intact', () => {
    expect(verifyIncidentSummaryRecord(rec())).toEqual([]);
  });

  it.each([
    ['a fact edited', (r: any) => (r.facts.timeline[3].data.title = 'Something else'), /factsSha256|template renders/],
    ['the text edited', (r: any) => (r.text = r.text.replace('WARNING', 'CRITICAL')), /textSha256|template renders/],
    ['a citation moved to another fact', (r: any) => (r.sentences[2].cites = ['F9']), /cit/],
    ['a citation to a fact that is not there', (r: any) => (r.sentences[2].cites = ['F77']), /unknown fact/],
    ['a sentence with no citation', (r: any) => (r.sentences[2].cites = []), /cit/],
    ['a fact nobody cites', (r: any) => r.sentences.splice(2, 1), /cit|template renders/],
    ['the record hash edited', (r: any) => (r.recordSha256 = sha('x')), /recordSha256/],
    ['the id swapped', (r: any) => (r.summaryId = sha('other')), /summaryId/],
  ])('detects %s', (_name, mutate, pattern) => {
    const r = rec();
    mutate(r);
    const problems = verifyIncidentSummaryRecord(r);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.map((p) => p.problem).join(' | ')).toMatch(pattern as RegExp);
  });

  it('does not depend on key order: canonical JSON and JSONB both reorder the keys of a sentence', () => {
    const r = rec();
    r.sentences = r.sentences.map((s: any) => ({ cites: s.cites, text: s.text })); // cites before text, as canonical JSON writes them
    expect(verifyIncidentSummaryRecord(r)).toEqual([]);
  });

  it('fixes the template: unknown template versions are refused', () => {
    const r = rec();
    r.templateVersion = 'incident-summary.v9';
    expect(verifyIncidentSummaryRecord(r).map((p) => p.problem).join()).toMatch(/unknown template/);
  });
});

describe('the evidence document', () => {
  const win = { startUtc: T(0), endUtc: T(59) };
  it('holds the latest summary per alarm, sorted, with a digest over their hashes', () => {
    const a = buildIncidentSummaryRecord(full(), new Date(T(30)));
    const f2: any = full();
    f2.subject.id = 'alarm-2';
    const b = buildIncidentSummaryRecord(f2, new Date(T(31)));
    const doc = buildIncidentSummariesDocument({ cameraId: 'cam-1', window: win, records: [b, a] });
    expect(doc.summaries.map((s) => s.summaryId)).toEqual([a.summaryId, b.summaryId].sort());
    expect(doc.digestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(doc.statement).toMatch(/not a model opinion/);
  });

  it('refuses a record for another camera, outside the window, duplicated, or not intact', () => {
    const a = buildIncidentSummaryRecord(full(), new Date(T(30)));
    expect(() => buildIncidentSummariesDocument({ cameraId: 'cam-2', window: win, records: [a] })).toThrow(/camera/);
    expect(() => buildIncidentSummariesDocument({ cameraId: 'cam-1', window: { startUtc: T(10), endUtc: T(20) }, records: [a] })).toThrow(/window/);
    expect(() => buildIncidentSummariesDocument({ cameraId: 'cam-1', window: win, records: [a, a] })).toThrow(/duplicate/);
    const broken: any = JSON.parse(JSON.stringify(a));
    broken.text += 'x';
    expect(() => buildIncidentSummariesDocument({ cameraId: 'cam-1', window: win, records: [broken] })).toThrow(/not intact/);
  });
});

describe('the template is a pure function of the facts', () => {
  it('renders the same sentences the record stores', () => {
    const facts = IncidentSummaryFactsV1.parse(full());
    const rendered = renderIncidentSummaryV1(facts);
    const rec = buildIncidentSummaryRecord(full(), new Date(T(30)));
    expect(rendered.sentences).toEqual(rec.sentences);
  });
});
