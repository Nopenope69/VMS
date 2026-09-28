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
