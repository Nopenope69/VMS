import { isLive, LIVE_WINDOW_MS } from '../services/camera/liveness';

describe('camera liveness', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  it('is live only when the stream watchdog saw the stream within the window', () => {
    expect(isLive(new Date(now - 1000), now)).toBe(true);
    expect(isLive(new Date(now - LIVE_WINDOW_MS), now)).toBe(true);
    expect(isLive(new Date(now - LIVE_WINDOW_MS - 1), now)).toBe(false);
  });
  it('is never live without a sighting', () => {
    expect(isLive(null, now)).toBe(false);
    expect(isLive(undefined, now)).toBe(false);
  });
});
