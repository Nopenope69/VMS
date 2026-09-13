import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseSegmentFilenameTimestamp,
  calculateSegmentBounds,
  formatSegmentFilename,
  extractStreamPathAndFilename,
} from '../utils/segmentPath';

describe('Task 2.2: Filename-Based Authority for Timestamps (C-011)', () => {
  describe('parseSegmentFilenameTimestamp', () => {
    it('should parse standard MediaMTX filename with microseconds in UTC', () => {
      const filename = '2026-09-04_01-30-00-123456.mp4';
      const parsed = parseSegmentFilenameTimestamp(filename);

      expect(parsed.toISOString()).toBe('2026-09-04T01:30:00.123Z');
      expect(parsed.getUTCFullYear()).toBe(2026);
      expect(parsed.getUTCMonth()).toBe(8); // September (0-indexed)
      expect(parsed.getUTCDate()).toBe(4);
      expect(parsed.getUTCHours()).toBe(1);
      expect(parsed.getUTCMinutes()).toBe(30);
      expect(parsed.getUTCSeconds()).toBe(0);
      expect(parsed.getUTCMilliseconds()).toBe(123);
    });

    it('should parse standard MediaMTX filename without microseconds in UTC', () => {
      const filename = '2026-09-04_01-30-00.mp4';
      const parsed = parseSegmentFilenameTimestamp(filename);

      expect(parsed.toISOString()).toBe('2026-09-04T01:30:00.000Z');
    });

    it('should parse .fmp4 container filenames across nested paths', () => {
      const fullPath = '/var/lib/vigilone/recordings/front-gate/substream/2026-11-20_18-45-12-500000.fmp4';
      const parsed = parseSegmentFilenameTimestamp(fullPath);

      expect(parsed.toISOString()).toBe('2026-11-20T18:45:12.500Z');
    });

    it('should reject filenames without timestamps or malformed names', () => {
      expect(() => parseSegmentFilenameTimestamp('random_file.mp4')).toThrow(/cannot parse UTC timestamp/);
      expect(() => parseSegmentFilenameTimestamp('video_2026_not_iso.mp4')).toThrow(/cannot parse UTC timestamp/);
    });

    it('should reject out-of-range timestamp components', () => {
      // Month 13 is invalid
      expect(() => parseSegmentFilenameTimestamp('2026-13-04_01-30-00-000000.mp4')).toThrow(
        /out-of-range timestamp components/
      );
      // Hour 25 is invalid
      expect(() => parseSegmentFilenameTimestamp('2026-09-04_25-30-00-000000.mp4')).toThrow(
        /out-of-range timestamp components/
      );
    });
  });

  describe('calculateSegmentBounds', () => {
    it('should compute exact startTime and endTime from filename + durationMs', () => {
      const filename = '/recordings/cam1/2026-09-04_01-30-00-000000.mp4';
      const durationMs = 120000; // 2 minutes

      const bounds = calculateSegmentBounds(filename, durationMs);

      expect(bounds.startTime.toISOString()).toBe('2026-09-04T01:30:00.000Z');
      expect(bounds.endTime.toISOString()).toBe('2026-09-04T01:32:00.000Z');
      expect(bounds.durationMs).toBe(120000);
    });

    it('should reject negative durationMs', () => {
      expect(() =>
        calculateSegmentBounds('/recordings/cam1/2026-09-04_01-30-00-000000.mp4', -5000)
      ).toThrow(/Invalid durationMs/);
    });
  });

  describe('Strict Independence from Filesystem mtime (C-011 Invariant)', () => {
    it('should maintain consistent bounds even when file mtime is mutated (touch/sync)', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-c011-'));
      const testSegmentPath = path.join(tempDir, '2026-09-04_10-00-00-000000.mp4');

      fs.writeFileSync(testSegmentPath, 'dummy video payload for test');

      // Initial check
      const durationMs = 60000; // 1 minute
      const initialBounds = calculateSegmentBounds(testSegmentPath, durationMs);
      expect(initialBounds.startTime.toISOString()).toBe('2026-09-04T10:00:00.000Z');
      expect(initialBounds.endTime.toISOString()).toBe('2026-09-04T10:01:00.000Z');

      // Mutate filesystem mtime to 3 years in the future (e.g. backup tool, rsync, touch)
      const futureMtime = new Date('2029-01-01T00:00:00.000Z');
      fs.utimesSync(testSegmentPath, futureMtime, futureMtime);

      const statAfterTouch = fs.statSync(testSegmentPath);
      expect(statAfterTouch.mtime.toISOString()).toBe('2029-01-01T00:00:00.000Z');

      // Crucial test: Filename authority must NOT change despite mtime mutation
      const boundsAfterTouch = calculateSegmentBounds(testSegmentPath, durationMs);
      expect(boundsAfterTouch.startTime.toISOString()).toBe('2026-09-04T10:00:00.000Z');
      expect(boundsAfterTouch.endTime.toISOString()).toBe('2026-09-04T10:01:00.000Z');
      expect(boundsAfterTouch.startTime).toEqual(initialBounds.startTime);
      expect(boundsAfterTouch.endTime).toEqual(initialBounds.endTime);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('formatSegmentFilename and extractStreamPathAndFilename', () => {
    it('should format a UTC Date into standard MediaMTX filename', () => {
      const d = new Date('2026-09-04T01:30:00.123Z');
      const name = formatSegmentFilename(d, 'mp4', true);
      expect(name).toBe('2026-09-04_01-30-00-123000.mp4');
    });

    it('should extract streamPath and filename from relative or absolute paths', () => {
      const res1 = extractStreamPathAndFilename('/recordings/main-entrance/2026-09-04_01-30-00-000000.mp4', '/recordings');
      expect(res1.streamPath).toBe('main-entrance');
      expect(res1.filename).toBe('2026-09-04_01-30-00-000000.mp4');

      const res2 = extractStreamPathAndFilename('/var/lib/recordings/buildingA/lobby/2026-09-04_01-30-00-000000.mp4', '/var/lib/recordings');
      expect(res2.streamPath).toBe('buildingA/lobby');
    });
  });
});
