/**
 * F5 (docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md): MediaMTX tells the backend a segment is finished with one
 * curl. If the backend is restarting at that moment the notice must be retried, so the file is indexed by its durable
 * job within about two minutes instead of waiting for the 5-minute crawl. MediaMTX runs the command on its own goroutine
 * (internal/core/path.go: cmd.Start(), Restart false), so retrying never delays recording.
 */
import fs from 'fs';
import path from 'path';

const yml = fs.readFileSync(path.join(__dirname, '../../../mediamtx.yml'), 'utf8');
const hook = (yml.match(/runOnRecordSegmentComplete:\s*>-\s*\n\s+(curl[^\n]+)/) || [])[1] || '';

describe('runOnRecordSegmentComplete (mediamtx.yml)', () => {
  it('is still valid YAML and the hook is on the path defaults', () => {
    const doc = require('js-yaml').load(yml) as any;
    expect(String(doc.pathDefaults.runOnRecordSegmentComplete)).toContain('segment-complete');
  });

  it('posts the segment to the backend with the internal secret', () => {
    expect(hook).toContain('/api/v1/internal/segment-complete');
    expect(hook).toContain('Authorization: Bearer $INTERNAL_API_SECRET');
    expect(hook).toContain('$MTX_SEGMENT_PATH');
  });

  it('retries a few times, including while the backend refuses connections, for about two minutes at most', () => {
    expect(hook).toMatch(/--retry\s+\d+/);
    expect(hook).toContain('--retry-connrefused');
    const n = Number(hook.match(/--retry\s+(\d+)/)?.[1]);
    const delay = Number(hook.match(/--retry-delay\s+(\d+)/)?.[1] ?? 1);
    const maxTime = Number(hook.match(/--max-time\s+(\d+)/)?.[1] ?? 0);
    expect(n).toBeGreaterThanOrEqual(5);
    expect(n * (delay + maxTime)).toBeLessThanOrEqual(150);
  });

  it('does not retry client errors such as an unknown camera (no --retry-all-errors), and fails visibly (-f)', () => {
    expect(hook).not.toContain('--retry-all-errors');
    expect(hook).toMatch(/\s-[a-zA-Z]*f/);
  });
});
