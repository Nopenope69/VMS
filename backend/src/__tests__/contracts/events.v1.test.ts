import fs from 'fs';
import path from 'path';
import { EventEnvelopeV1, FIXED_EVENT_TYPES_V1 } from '../../contracts/events.v1';
import { EventMappingError, toEventV1, VIGILONE_EVENT_TO_V1 } from '../../contracts/eventMapping.v1';
import {
  fromAnprObservation,
  fromCameraOffline,
  fromDigitalInput,
  fromLoiteringResult,
  fromMotionEvent,
  fromStreamDegraded,
  fromTripwireCrossing,
  createVigilOneEvent,
} from '../../services/incident/orchestrator/events';

const examples = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../docs/contracts/examples/events.v1.json'), 'utf8')
);
const provenance = examples.valid.find((e: any) => e.type === 'ai.person_detected').provenance;

describe('contract events.v1', () => {
  it('covers every event name required by the plan', () => {
    expect(FIXED_EVENT_TYPES_V1).toEqual(
      expect.arrayContaining([
        'camera.online', 'camera.offline', 'camera.degraded', 'recording.started', 'recording.stopped',
        'storage.warning', 'storage.critical', 'storage.rollover', 'storage.full', 'motion.detected',
        'ai.person_detected', 'ai.vehicle_detected', 'ai.line_crossing', 'ai.loitering', 'ai.plate_detected',
        'access.door_opened', 'alarm.fire', 'pos.transaction',
      ])
    );
  });

  it.each<[any, any]>(examples.valid.map((e: any) => [e.type, e]))('accepts valid example %s', (_t, ev) => {
    const res = EventEnvelopeV1.safeParse(ev);
    expect(res.success ? [] : res.error.issues).toEqual([]);
  });

  it.each<[any, any]>(examples.invalid.map((e: any) => [e.why, e.event]))('rejects: %s', (_why, ev) => {
    expect(EventEnvelopeV1.safeParse(ev).success).toBe(false);
  });

  describe('mapping from the internal VigilOneEvent union', () => {
    const t = 'tenant-1';

    it('has a mapping for every internal event type', () => {
      expect(Object.keys(VIGILONE_EVENT_TO_V1).sort()).toEqual(
        ['ANPR_MATCH', 'CAMERA_OFFLINE', 'DI_TRIGGER', 'LOITERING_DWELL', 'MOTION', 'SCENE_CHANGE', 'STREAM_DEGRADED', 'SYSTEM_ALERT', 'TRIPWIRE_CROSS'].sort()
      );
    });

    it('maps non-AI events without provenance', () => {
      const cases = [
        fromMotionEvent({ tenantId: t, cameraId: 'cam-1', score: 0.4 }),
        fromCameraOffline({ tenantId: t, cameraId: 'cam-1', lastSeenUtc: new Date('2026-09-26T09:00:00Z') }),
        fromStreamDegraded({ tenantId: t, cameraId: 'cam-1', fps: 5, expectedFps: 25 }),
        fromDigitalInput({ tenantId: t, pinNumber: 3, state: 'HIGH' }),
        createVigilOneEvent({ tenantId: t, cameraId: 'cam-1', type: 'SCENE_CHANGE', payload: { kind: 'SCENE_CHANGE', score: 0.9, threshold: 0.5, changeType: 'OCCLUSION' } }),
        createVigilOneEvent({ tenantId: t, type: 'SYSTEM_ALERT', payload: { kind: 'SYSTEM_ALERT', subsystem: 'storage', alertCode: 'DISK_SLOW', message: 'slow' } }),
      ];
      const types = cases.map((ev) => toEventV1(ev).type);
      expect(types).toEqual(['motion.detected', 'camera.offline', 'camera.degraded', 'system.digital_input', 'camera.degraded', 'system.alert']);
      for (const ev of cases) {
        expect(toEventV1(ev).provenance).toBeNull();
      }
      expect(toEventV1(cases[4]).payload).toEqual({ reason: 'TAMPER_OCCLUSION' });
    });

    it('refuses to map AI-derived events without provenance (never invents a model)', () => {
      const aiEvents = [
        fromTripwireCrossing({ tenantId: t, cameraId: 'cam-1', tripwireId: 'tw-1', trackId: 'trk-1', direction: 'FORWARD' }),
        fromLoiteringResult({ tenantId: t, cameraId: 'cam-1', zoneId: 'z-1', trackId: 'trk-1', dwellTimeSeconds: 40, thresholdSeconds: 30 }),
        fromAnprObservation({ tenantId: t, cameraId: 'cam-1', plateText: 'KA01AB1234', confidence: 0.9 }),
      ];
      for (const ev of aiEvents) {
        expect(() => toEventV1(ev)).toThrow(EventMappingError);
        expect(() => toEventV1(ev)).toThrow(/AI_PROVENANCE_REQUIRED/);
      }
      const mapped = aiEvents.map((ev) => toEventV1(ev, { provenance }));
      expect(mapped.map((m) => m.type)).toEqual(['ai.line_crossing', 'ai.loitering', 'ai.plate_detected']);
      expect(mapped[0].payload).toMatchObject({ ruleId: 'tw-1', direction: 'A_TO_B' });
      for (const m of mapped) {
        expect(EventEnvelopeV1.safeParse(m).success).toBe(true);
        expect(m.provenance?.modelSha256).toBe(provenance.modelSha256);
      }
    });

    it('fails with INVALID_ENVELOPE instead of emitting a malformed event', () => {
      const bad = fromMotionEvent({ tenantId: t, cameraId: 'cam-1', score: 3 });
      expect(() => toEventV1(bad)).toThrow(/INVALID_ENVELOPE/);
    });
  });
});
