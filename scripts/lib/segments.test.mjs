import test from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, parseSegmentStart } from './segments.mjs';

test('parses MediaMTX segment names as UTC with microseconds', () => {
  assert.equal(parseSegmentStart('2026-09-26_10-00-05-250000.mp4'), Date.UTC(2026, 8, 26, 10, 0, 5) + 250);
  assert.equal(parseSegmentStart('notes.txt'), null);
});

test('finds gaps over the threshold, including at window edges', () => {
  const s = (a, b) => ({ startMs: a * 1000, endMs: b * 1000 });
  const gaps = findGaps([s(0, 10), s(10.5, 20), s(30, 40)], { thresholdSec: 5, windowStartMs: 0, windowEndMs: 50000 });
  assert.deepEqual(gaps.map((g) => g.seconds), [10, 10]);
});

test('an unreadable segment (zero length) does not hide a gap', () => {
  const gaps = findGaps([{ startMs: 0, endMs: 10000 }, { startMs: 12000, endMs: 12000 }, { startMs: 30000, endMs: 40000 }], { thresholdSec: 5 });
  assert.deepEqual(gaps.map((g) => g.seconds), [18]);
});
