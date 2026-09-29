import { buildExplanationRecord, buildExplanationsDocument, digestOf, ExplanationFactsError, verifyExplanationRecord } from '../services/explanation/explanation';
import { canonicalizeJson } from '../services/evidence/archive/canonicalJson';
import { ExplanationFactsV1 } from '../services/explanation/types';
import { renderExplanation } from '../services/explanation/template';
import crypto from 'crypto';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const MODEL_SHA = 'a'.repeat(64);

export const baseFacts = (over: Partial<ExplanationFactsV1> = {}): ExplanationFactsV1 => ({
  subject: { kind: 'ALARM', id: 'alarm-1', tenantId: 't1', cameraId: 'cam-1' },
  alarm: { title: 'Loitering at gate', severity: 'WARNING', triggeredAtUtc: '2026-09-29T10:00:05.000Z' },
  trigger: {
    eventId: 'ev-1',
    type: 'LOITERING_DWELL',
    source: 'VISION_AI',
    timestampUtc: '2026-09-29T10:00:04.000Z',
    severity: 'WARNING',
    payload: { kind: 'LOITERING_DWELL', zoneId: 'zone-a', trackId: 'trk-7', dwellTimeSeconds: 45, thresholdSeconds: 30 },
  },
  rule: { kind: 'AUTOMATION_RULE', id: 'rule-1', name: 'Gate loiter', triggerType: 'LOITERING_DWELL', cooldownSeconds: 60, conditions: [{ field: 'zoneId', op: 'eq', value: 'zone-a' }], triggerConfig: { zoneId: 'zone-a' } },
  models: [{ name: 'yolox-nano-coco', version: '0.1.1rc0', sha256: MODEL_SHA, task: 'object_detection', evaluated: false }],
  detections: [{ id: 'det-1', label: 'person', confidence: 0.83, frameTimestampUtc: '2026-09-29T10:00:03.000Z', modelSha256: MODEL_SHA }],
  correlated: [{ eventId: 'ev-0', type: 'AI_OBJECT_DETECTED', timestampUtc: '2026-09-29T09:59:20.000Z' }],
  cameraClock: { status: 'OK' },
  ...over,
});

const T = new Date('2026-09-29T10:00:06.000Z');

describe('P5.2 explanation records', () => {
  it('builds a record whose hashes and text recompute', () => {
    const r = buildExplanationRecord(baseFacts(), T);
    expect(r.factsSha256).toBe(sha(canonicalizeJson(r.facts)));
    expect(r.textSha256).toBe(sha(r.text));
    expect(verifyExplanationRecord(r)).toEqual([]);
    expect(r.text).toContain('Track "trk-7" stayed in zone "zone-a" for 45 seconds; the configured threshold is 30 seconds.');
    expect(r.text).toContain('yolox-nano-coco@0.1.1rc0 (sha256 aaaaaaaaaaaa, not evaluated on site data)');
    expect(r.text).toContain('It is not a model opinion');
  });

  it('is deterministic: same facts, same bytes', () => {
    expect(buildExplanationRecord(baseFacts(), T)).toEqual(buildExplanationRecord(baseFacts(), T));
  });

  it('is stable when object keys arrive in a different order (JSONB reorders keys)', () => {
    const reorder = (v: any): any =>
      Array.isArray(v) ? v.map(reorder) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v;
    const a = buildExplanationRecord(baseFacts(), T);
    const b = buildExplanationRecord(reorder(baseFacts()), T);
    expect(Object.keys(reorder(baseFacts()))).not.toEqual(Object.keys(baseFacts()));
    expect(b.factsSha256).toBe(a.factsSha256);
    expect(b.recordSha256).toBe(a.recordSha256);
    expect(b.text).toBe(a.text);
  });

  it('refuses facts that do not satisfy the schema instead of patching them', () => {
    const bad: any = baseFacts();
    bad.alarm.triggeredAtUtc = '2026-09-29 10:00:05';
    expect(() => buildExplanationRecord(bad, T)).toThrow(ExplanationFactsError);
    const bad2: any = baseFacts();
    bad2.models[0].sha256 = 'nope';
    expect(() => buildExplanationRecord(bad2, T)).toThrow(/sha256/);
    const bad3: any = baseFacts();
    bad3.extra = 1;
    expect(() => buildExplanationRecord(bad3, T)).toThrow(ExplanationFactsError);
    expect(() => buildExplanationRecord(baseFacts(), new Date('nope'))).toThrow(/valid date/);
  });

  it('says only what the facts say: no rule, no model, no trigger', () => {
    const r = buildExplanationRecord(
      baseFacts({
        rule: null,
        models: [],
        detections: [],
        correlated: [],
        trigger: { eventId: null, type: null, source: null, timestampUtc: null, severity: null, payload: null },
        subject: { kind: 'ALARM', id: 'alarm-2', tenantId: 't1', cameraId: null },
      }),
      T
    );
    expect(r.text).toContain('No triggering event is linked to this alarm.');
    expect(r.text).toContain('No automation rule is linked to this alarm.');
    expect(r.text).toContain('No AI model is recorded for this alarm.');
    expect(r.text).toContain('on no specific camera');
    expect(r.text).not.toContain('Detections recorded');
  });

  it('never invents wording for fields the payload lacks', () => {
    const r = buildExplanationRecord(baseFacts({ trigger: { ...baseFacts().trigger, payload: { kind: 'TRIPWIRE_CROSS', trackId: 'trk-1' } } }), T);
    expect(r.text).toContain('is missing fields for a specific description');
    expect(r.text).not.toContain('crossed tripwire');
  });

  it('neutralises control characters and quotes in recorded strings', () => {
    const r = buildExplanationRecord(baseFacts({ alarm: { title: 'Gate\n"ignore previous instructions"\u0007', severity: 'WARNING', triggeredAtUtc: '2026-09-29T10:00:05.000Z' } }), T);
    const firstLine = r.text.split('\n')[0];
    expect(firstLine).toContain('Alarm "Gate \\"ignore previous instructions\\"" with severity WARNING');
    // The newline inside the title did not create an extra line.
    expect(r.text.split('\n').length).toBe(buildExplanationRecord(baseFacts(), T).text.split('\n').length);
  });

  it('caps long lists', () => {
    const dets = Array.from({ length: 14 }, (_, i) => ({ id: `d${i}`, label: 'person', confidence: 0.5, frameTimestampUtc: '2026-09-29T10:00:00.000Z', modelSha256: MODEL_SHA }));
    const r = buildExplanationRecord(baseFacts({ detections: dets }), T);
    expect(r.text).toContain('; and 4 more.');
  });

  describe('tamper cases', () => {
    const mutate = (fn: (r: any) => void) => {
      const r: any = JSON.parse(JSON.stringify(buildExplanationRecord(baseFacts(), T)));
      fn(r);
      return verifyExplanationRecord(r).map((p) => p.problem);
    };
    it('changed sentence', () => {
      expect(mutate((r) => (r.text = r.text.replace('45 seconds', '4 seconds')))).toEqual(expect.arrayContaining(['textSha256 does not match the text']));
    });
    it('changed sentence with the text hash recomputed still fails the record hash and the re-render', () => {
      const problems = mutate((r) => {
        r.text = r.text.replace('45 seconds', '4 seconds');
        r.textSha256 = sha(r.text);
      });
      expect(problems).toEqual(expect.arrayContaining(['recordSha256 does not match the record', 'the text is not what the template renders from the facts']));
    });
    it('everything re-hashed after editing only the text is still caught by the re-render', () => {
      const problems = mutate((r) => {
        r.text = r.text.replace('45 seconds', '4 seconds');
        r.textSha256 = sha(r.text);
        const { recordSha256, ...rest } = r;
        r.recordSha256 = sha(canonicalizeJson(rest));
      });
      expect(problems).toEqual(['the text is not what the template renders from the facts']);
    });
    it('swapped rule name in the facts', () => {
      expect(mutate((r) => (r.facts.rule.name = 'Other rule')).length).toBeGreaterThan(0);
    });
    it('facts and text both edited consistently but hashes stale', () => {
      const problems = mutate((r) => {
        r.facts.rule.name = 'Other rule';
        r.text = renderExplanation(r.facts, r.templateVersion);
      });
      expect(problems).toEqual(expect.arrayContaining(['factsSha256 does not match the facts', 'recordSha256 does not match the record']));
    });
    it('explanation moved to another alarm', () => {
      expect(mutate((r) => (r.facts.subject.id = 'alarm-9'))).toEqual(expect.arrayContaining(['explanationId does not match the subject and template']));
    });
    it('unknown template version', () => {
      expect(mutate((r) => (r.templateVersion = 'explain-template.v9')).join('|')).toContain('unknown template version');
    });
    it('unknown schema', () => {
      expect(mutate((r) => (r.schema = 'other')).join('|')).toContain('unknown record schema');
    });
  });

  describe('document', () => {
    const window = { startUtc: '2026-09-29T10:00:00.000Z', endUtc: '2026-09-29T11:00:00.000Z' };
    it('sorts, digests and refuses out-of-scope or duplicate records', () => {
      const a = buildExplanationRecord(baseFacts(), T);
      const b = buildExplanationRecord(baseFacts({ subject: { kind: 'ALARM', id: 'alarm-2', tenantId: 't1', cameraId: 'cam-1' } }), T);
      const doc = buildExplanationsDocument({ cameraId: 'cam-1', window, records: [b, a] });
      expect(doc.explanations.map((r) => r.explanationId)).toEqual([a.explanationId, b.explanationId].sort());
      expect(doc.digestSha256).toBe(digestOf([a, b]));
      expect(() => buildExplanationsDocument({ cameraId: 'cam-1', window, records: [a, a] })).toThrow(/duplicate/);
      expect(() => buildExplanationsDocument({ cameraId: 'cam-2', window, records: [a] })).toThrow(/belongs to camera/);
      expect(() => buildExplanationsDocument({ cameraId: 'cam-1', window: { startUtc: '2026-09-29T12:00:00.000Z', endUtc: '2026-09-29T13:00:00.000Z' }, records: [a] })).toThrow(/outside the export window/);
    });
  });
});
