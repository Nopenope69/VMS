/**
 * Camera clock skew from ONVIF GetSystemDateAndTime (P3.1). The camera reports whole seconds, so
 * the skew is only known to an interval: with the request sent at t0 and the answer received at
 * t1 (appliance clock) and a reported camera time C (floor to the second), the camera clock at
 * reception lies in [C, C + 1 s + (t1 - t0)), hence skew in [C - t1, C + 1000 - t0].
 * A drift beyond the threshold is reported only when the whole interval is beyond it; otherwise
 * the result says UNDETERMINED instead of guessing.
 */
export interface SkewResult {
  lowerMs: number;
  upperMs: number;
  estimateMs: number;
  thresholdMs: number;
  verdict: 'OK' | 'DRIFT' | 'UNDETERMINED';
}

export function skewFromCameraTime(cameraUtc: Date, sentAt: number, receivedAt: number, thresholdMs = 100): SkewResult {
  const c = cameraUtc.getTime();
  const lowerMs = c - receivedAt;
  const upperMs = c + 1000 - sentAt;
  const estimateMs = Math.round((lowerMs + upperMs) / 2);
  let verdict: SkewResult['verdict'];
  if (lowerMs > thresholdMs || upperMs < -thresholdMs) verdict = 'DRIFT';
  else if (lowerMs >= -thresholdMs && upperMs <= thresholdMs) verdict = 'OK';
  else verdict = 'UNDETERMINED';
  return { lowerMs, upperMs, estimateMs, thresholdMs, verdict };
}

/** tt:UTCDateTime { Date: {Year,Month,Day}, Time: {Hour,Minute,Second} } -> Date. */
export function onvifUtcDateTime(node: any): Date | null {
  const d = node?.Date;
  const t = node?.Time;
  if (!d || !t) return null;
  const v = [d.Year, d.Month, d.Day, t.Hour, t.Minute, t.Second].map(Number);
  if (v.some((n) => !Number.isFinite(n))) return null;
  return new Date(Date.UTC(v[0], v[1] - 1, v[2], v[3], v[4], v[5]));
}
