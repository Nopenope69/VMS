import fs from 'fs';
import path from 'path';
import * as ai from '../../contracts/aiAdapter.v1';
import { EventEnvelopeV1 } from '../../contracts/events.v1';

const examples = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../docs/contracts/examples/ai-adapter.v1.json'), 'utf8')
);
const schemas: Record<string, any> = {
  AdapterDescriptorV1: ai.AdapterDescriptorV1,
  InferenceRequestV1: ai.InferenceRequestV1,
  InferenceResultV1: ai.InferenceResultV1,
  AdapterHealthV1: ai.AdapterHealthV1,
  ModelCardV1: ai.ModelCardV1,
};

describe('contract ai-adapter.v1', () => {
  it.each(Object.entries(examples.valid) as [string, any][])('accepts valid example %s', (name, value) => {
    const schema = schemas[name.replace(/_(ok|error)$/, '')];
    const res = schema.safeParse(value);
    expect(res.success ? [] : res.error.issues).toEqual([]);
  });

  it.each<[any, any, any]>(examples.invalid.map((e: any) => [e.why, e.schema, e.value]))('rejects: %s', (_why, schema, value) => {
    expect(schemas[schema as string].safeParse(value).success).toBe(false);
  });

  it('only permissive licences are representable', () => {
    for (const lic of ['GPL-3.0', 'AGPL-3.0', 'CC-BY-NC-4.0', 'proprietary', '']) {
      expect(ai.ModelCardV1.shape.weightsLicense.safeParse(lic).success).toBe(false);
    }
    for (const lic of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC']) {
      expect(ai.ModelCardV1.shape.weightsLicense.safeParse(lic).success).toBe(true);
    }
  });

  it('an ok result can be turned into ai.* events whose provenance validates against events.v1', () => {
    const result = ai.InferenceResultV1.parse(examples.valid.InferenceResultV1_ok);
    if (result.status !== 'ok') throw new Error('expected ok');
    for (const det of result.detections) {
      const type = ai.DETECTION_CLASS_TO_EVENT_V1[det.objectClass];
      const ev = {
        id: `evt_${result.provenance.inferenceId}_${det.classId}`,
        type,
        version: 1,
        tenantId: 't_01',
        siteId: null,
        cameraId: 'cam_01',
        timestampUtc: result.provenance.frameTimestampUtc,
        source: { kind: 'ai', id: result.provenance.adapterId },
        correlationId: result.requestId,
        payload: { objectClass: det.objectClass, confidence: det.confidence, bbox: det.bbox },
        provenance: result.provenance,
      };
      expect(EventEnvelopeV1.safeParse(ev).success).toBe(true);
    }
  });

  it('maps exactly the v1 COCO classes', () => {
    expect(Object.keys(ai.DETECTION_CLASS_TO_EVENT_V1).sort()).toEqual(['bicycle', 'bus', 'car', 'motorcycle', 'person', 'truck']);
  });
});

describe('contract ai-adapter.v1.1: optional embedding result', () => {
  const okResult = () => ({ ...examples.valid.InferenceResultV1_ok });
  const withEmbedding = (e: unknown) => ({ ...okResult(), detections: [], embedding: e });
  const vec = Buffer.alloc(8).toString('base64');

  it('an existing v1 ok result (no embedding) is still valid', () => {
    expect(ai.InferenceResultV1.safeParse(okResult()).success).toBe(true);
  });

  it('an ok result may carry an embedding, and the embedding task is declarable', () => {
    const r = ai.InferenceResultV1.safeParse(withEmbedding({ dim: 2, encoding: 'float32_base64', vector: vec, normalized: true }));
    expect(r.success ? [] : r.error.issues).toEqual([]);
    expect(ai.AiTaskV1.safeParse('embedding').success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['another encoding', { dim: 2, encoding: 'float64_base64', vector: 'AAAA', normalized: true }],
    ['a zero dimension', { dim: 0, encoding: 'float32_base64', vector: 'AAAA', normalized: true }],
    ['an absurd dimension', { dim: 100000, encoding: 'float32_base64', vector: 'AAAA', normalized: true }],
    ['an empty vector', { dim: 2, encoding: 'float32_base64', vector: '', normalized: true }],
    ['a missing normalized flag', { dim: 2, encoding: 'float32_base64', vector: 'AAAA' }],
    ['an extra field', { dim: 2, encoding: 'float32_base64', vector: 'AAAA', normalized: true, label: 'x' }],
  ])('rejects an embedding with %s', (_why, e) => {
    expect(ai.InferenceResultV1.safeParse(withEmbedding(e)).success).toBe(false);
  });

  it('an error result still carries no embedding', () => {
    expect(ai.InferenceResultV1.safeParse({ ...examples.valid.InferenceResultV1_error, embedding: { dim: 2, encoding: 'float32_base64', vector: vec, normalized: true } }).success).toBe(false);
  });
});

