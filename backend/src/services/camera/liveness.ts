/**
 * Camera liveness. The stream watchdog (every 30 s) stamps Camera.lastSeenAt whenever MediaMTX reports the
 * camera's stream ready; a camera is live when that stamp is recent. A camera never seen, or not seen for longer
 * than the window (for example because the watchdog is not running on this node), is not live: the screen never
 * shows a camera as online on an old or missing reading.
 */
export const LIVE_WINDOW_MS = 90_000;

export function isLive(lastSeenAt: Date | null | undefined, now = Date.now()): boolean {
  return !!lastSeenAt && now - lastSeenAt.getTime() <= LIVE_WINDOW_MS;
}
