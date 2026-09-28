/**
 * Unit tests for multi-frame plate voting and session grouping (P4.1). Format rules are in
 * indianPlate.test.ts; the database, events and alarms path is in anprRealDb.test.ts.
 */
import PlateTrackAggregatorService from '../services/anpr/plateTrackAggregator.service';

const r = (plateText: string, confidence: number) => ({ tenantId: 't', cameraId: 'c', plateText, confidence });

describe('voteConsensus', () => {
  it('normalises reads before voting, so a letter/digit slip does not split the vote', () => {
    expect(PlateTrackAggregatorService.voteConsensus([r('MH12AB1234', 0.9), r('MHI2AB1234', 0.8), r('MH12AB12B4', 0.6)])).toBe('MH12AB1234');
  });
  it('weights characters by confidence', () => {
    expect(PlateTrackAggregatorService.voteConsensus([r('KA05C7788', 0.95), r('KA05C7788', 0.9), r('KA05C1788', 0.3)])).toBe('KA05C7788');
    expect(PlateTrackAggregatorService.voteConsensus([r('KA05C7788', 0.2), r('KA05C1788', 0.9)])).toBe('KA05C1788');
  });
  it('votes within the most supported length only', () => {
    expect(PlateTrackAggregatorService.voteConsensus([r('DL3CAB4521', 0.9), r('DL3CAB452', 0.3), r('DL3CAB4521', 0.8)])).toBe('DL3CAB4521');
  });
});

describe('session grouping', () => {
  function mockPrisma() {
    const obs: any[] = [];
    return {
      obs,
      vehicleWatchlist: { findMany: jest.fn().mockResolvedValue([]) },
      vehicleObservation: {
        create: jest.fn().mockImplementation(({ data }) => {
          const o = { id: `o${obs.length + 1}`, ...data };
          obs.push(o);
          return Promise.resolve(o);
        }),
        update: jest.fn().mockImplementation(({ where, data }) => {
          const o = obs.find((x) => x.id === where.id);
          Object.assign(o, data);
          return Promise.resolve(o);
        }),
      },
    };
  }

  it('reads within 2 characters on the same camera and within 30 s join one observation; others do not', async () => {
    const p = mockPrisma();
    const s = new PlateTrackAggregatorService(p as any);
    const t = Date.now();
    await s.processDetection({ ...r('MH12AB1234', 0.9), timestamp: new Date(t) });
    await s.processDetection({ ...r('MH12AB1284', 0.5), timestamp: new Date(t + 1000) });
    await s.processDetection({ ...r('KA05C7788', 0.9), timestamp: new Date(t + 1500) });
    await s.processDetection({ ...r('MH12AB1234', 0.9), cameraId: 'other', timestamp: new Date(t + 2000) });
    await s.processDetection({ ...r('MH12AB1234', 0.9), timestamp: new Date(t + 40000) });
    expect(p.obs.map((o) => [o.cameraId, o.normalizedPlate, o.observationCount])).toEqual([
      ['c', 'MH12AB1234', 2],
      ['c', 'KA05C7788', 1],
      ['other', 'MH12AB1234', 1],
      ['c', 'MH12AB1234', 1],
    ]);
  });

  it('emits one ANPR_MATCH event per new observation, with the read provenance', async () => {
    const p = mockPrisma();
    const s = new PlateTrackAggregatorService(p as any);
    const events: any[] = [];
    s.setEventSink(async (e) => events.push(e));
    const provenance = { modelSha256: 'a'.repeat(64) } as any;
    const t = Date.now();
    await s.processDetection({ ...r('MH12AB1234', 0.9), timestamp: new Date(t), provenance });
    await s.processDetection({ ...r('MH12AB1234', 0.9), timestamp: new Date(t + 500), provenance });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'ANPR_MATCH', id: 'ev_anpr_o1', provenance, payload: { plateText: 'MH12AB1234' } });
  });
});
