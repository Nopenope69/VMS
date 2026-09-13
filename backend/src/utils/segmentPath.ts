import path from 'path';

/**
 * Segment path utilities for MediaMTX edge recordings.
 * Strictly enforces filename-based timestamp authority for temporal integrity (C-011).
 * Timestamps are NEVER derived from filesystem mtime.
 */

export interface SegmentBounds {
  startTime: Date;
  endTime: Date;
  durationMs: number;
}

export interface StreamPathInfo {
  streamPath: string;
  filename: string;
}

/**
 * Parses authoritative UTC timestamp from a MediaMTX segment filename.
 * Convention: %Y-%m-%d_%H-%M-%S-%f (e.g. 2026-09-04_01-30-00-123456.mp4 or .fmp4)
 */
export function parseSegmentFilenameTimestamp(filePath: string): Date {
  const filename = path.basename(filePath);
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:[.-](\d{1,6}))?/);

  if (!match) {
    throw new Error(`Invalid segment filename: cannot parse UTC timestamp from "${filename}"`);
  }

  const [_, yearStr, monthStr, dayStr, hourStr, minStr, secStr, subStr] = match;

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);
  const sec = parseInt(secStr, 10);

  let ms = 0;
  if (subStr) {
    // Normalise to 6-digit microseconds, then convert to milliseconds
    const microsec = parseInt(subStr.padEnd(6, '0').slice(0, 6), 10);
    ms = Math.floor(microsec / 1000);
  }

  // Basic boundary validation
  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    min < 0 || min > 59 ||
    sec < 0 || sec > 59 ||
    ms < 0 || ms > 999
  ) {
    throw new Error(`Segment filename contains out-of-range timestamp components: "${filename}"`);
  }

  const utcTimestamp = Date.UTC(year, month - 1, day, hour, min, sec, ms);
  const date = new Date(utcTimestamp);

  if (isNaN(date.getTime())) {
    throw new Error(`Failed to construct valid UTC Date from segment filename: "${filename}"`);
  }

  return date;
}

/**
 * Calculates authoritative segment time bounds from filename timestamp and probed duration.
 * startTime = parseSegmentFilenameTimestamp(filePath)
 * endTime = startTime + durationMs
 */
export function calculateSegmentBounds(filePath: string, durationMs: number): SegmentBounds {
  if (typeof durationMs !== 'number' || durationMs < 0 || isNaN(durationMs)) {
    throw new Error(`Invalid durationMs for segment bounds calculation: ${durationMs}`);
  }

  const startTime = parseSegmentFilenameTimestamp(filePath);
  const endTime = new Date(startTime.getTime() + Math.round(durationMs));

  return {
    startTime,
    endTime,
    durationMs: Math.round(durationMs),
  };
}

/**
 * Formats a Date into standard MediaMTX UTC recording filename:
 * YYYY-MM-DD_HH-mm-ss-SSSSSS.mp4
 */
export function formatSegmentFilename(
  dateUtc: Date,
  extension: string = 'mp4',
  includeMicroseconds = true
): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');

  const y = dateUtc.getUTCFullYear();
  const m = pad(dateUtc.getUTCMonth() + 1);
  const d = pad(dateUtc.getUTCDate());
  const h = pad(dateUtc.getUTCHours());
  const min = pad(dateUtc.getUTCMinutes());
  const s = pad(dateUtc.getUTCSeconds());
  const ms = dateUtc.getUTCMilliseconds();

  const microPart = includeMicroseconds ? `-${pad(ms * 1000, 6)}` : '';
  const cleanExt = extension.startsWith('.') ? extension.slice(1) : extension;

  return `${y}-${m}-${d}_${h}-${min}-${s}${microPart}.${cleanExt}`;
}

/**
 * Extracts camera streamPath and filename from absolute or relative media file path.
 * E.g. /recordings/front-gate/2026-09-04_01-30-00-123456.mp4 -> { streamPath: 'front-gate', filename: '...' }
 */
export function extractStreamPathAndFilename(
  filePath: string,
  recordingsBaseDir?: string
): StreamPathInfo {
  const normalized = path.normalize(filePath);
  const filename = path.basename(normalized);

  if (recordingsBaseDir) {
    const normBase = path.normalize(recordingsBaseDir);
    if (normalized.startsWith(normBase)) {
      const rel = path.relative(normBase, path.dirname(normalized));
      return {
        streamPath: rel.replace(/^[/\\]+/, ''),
        filename,
      };
    }
  }

  const parts = normalized.split(path.sep).filter(Boolean);
  if (parts.length >= 2) {
    return {
      streamPath: parts[parts.length - 2],
      filename,
    };
  }

  return {
    streamPath: '',
    filename,
  };
}
