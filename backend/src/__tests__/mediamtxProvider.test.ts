import axios from 'axios';
import { MediaMTXProvider } from '../services/media/mediamtx.provider';

describe('MediaMTXProvider stream status', () => {
  const get = jest.fn();
  let create: jest.SpyInstance;

  beforeEach(() => {
    get.mockReset();
    create = jest.spyOn(axios, 'create').mockReturnValue({ get } as any);
  });

  afterEach(() => create.mockRestore());

  it('keeps observed telemetry from the media engine', async () => {
    get.mockResolvedValue({ data: { ready: true, readers: [{ id: 'reader-1' }], tracks: ['H264'], bytesReceived: 42 } });
    await expect(new MediaMTXProvider('http://mediamtx.test').getStreamStatus('cam_01')).resolves.toEqual({
      kind: 'OBSERVED', ready: true, readersCount: 1, tracks: ['H264'], bytesReceived: 42,
    });
  });

  it('distinguishes an absent path from an unavailable engine', async () => {
    get.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(new MediaMTXProvider('http://mediamtx.test').getStreamStatus('missing')).resolves.toEqual({ kind: 'NOT_FOUND' });

    get.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(new MediaMTXProvider('http://mediamtx.test').getStreamStatus('cam_01')).resolves.toEqual({ kind: 'ENGINE_UNAVAILABLE' });
  });
});
