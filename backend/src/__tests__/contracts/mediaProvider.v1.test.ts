import fs from 'fs';
import path from 'path';
import { MediaProviderV1Adapter, StreamStatusV1, StreamPathConfigV1 } from '../../contracts/mediaProvider.v1';
import { IMediaProvider } from '../../services/media/mediaProvider.interface';

const examples = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../docs/contracts/examples/media-provider.v1.json'), 'utf8')
);

const fakeInner = (status: any): IMediaProvider & { calls: any[] } => {
  const calls: any[] = [];
  return {
    calls,
    createOrUpdateStream: async (c) => void calls.push(['create', c]),
    deleteStream: async (p) => void calls.push(['delete', p]),
    getStreamStatus: async () => status,
    setRecording: async (id, en) => void calls.push(['record', id, en]),
  };
};
const fixedNow = () => new Date('2026-09-26T10:00:00.000Z');

describe('contract media-provider.v1', () => {
  it.each<[any, any]>(examples.valid.map((v: any) => [v.state, v]))('accepts valid status %s', (_s, v) => {
    expect(StreamStatusV1.safeParse(v).success).toBe(true);
  });

  it.each<[any, any]>(examples.invalid.map((e: any) => [e.why, e.value]))('rejects: %s', (_why, v) => {
    expect(StreamStatusV1.safeParse(v).success).toBe(false);
  });

  it('wraps a ready path from the existing provider', async () => {
    const adapter = new MediaProviderV1Adapter(fakeInner({ kind: 'OBSERVED', ready: true, readersCount: 1, tracks: ['H264'], bytesReceived: 10 }), fixedNow);
    const s = await adapter.getStreamStatus('cam_01');
    expect(s).toMatchObject({ state: 'READY', readersCount: 1, observedAtUtc: '2026-09-26T10:00:00.000Z' });
  });

  it.each(['NOT_FOUND', 'ENGINE_UNAVAILABLE'] as const)('reports %s with no invented telemetry when the provider cannot observe a path', async (kind) => {
    const adapter = new MediaProviderV1Adapter(fakeInner({ kind }), fixedNow);
    const s = await adapter.getStreamStatus('cam_01');
    expect(s).toMatchObject({ state: kind, readersCount: null, tracks: null, bytesReceived: null });
  });

  it('validates configs and paths before they reach the engine', async () => {
    const inner = fakeInner({ kind: 'NOT_FOUND' });
    const adapter = new MediaProviderV1Adapter(inner, fixedNow);
    await expect(adapter.createOrUpdateStream({ path: '../x', sourceRtspUrl: 'rtsp://1.2.3.4/s', record: true })).rejects.toThrow();
    await expect(adapter.createOrUpdateStream({ path: 'cam_01', sourceRtspUrl: 'http://1.2.3.4/s', record: true })).rejects.toThrow();
    await expect(adapter.deleteStream('/abs')).rejects.toThrow();
    expect(inner.calls).toEqual([]);
    const ok: StreamPathConfigV1 = { path: 'cam_01', sourceRtspUrl: 'rtsp://user:pw@10.0.0.5:554/s1', record: true };
    await adapter.createOrUpdateStream(ok);
    expect(inner.calls).toEqual([['create', ok]]);
  });
});
