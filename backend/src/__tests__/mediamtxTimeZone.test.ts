/**
 * F6 (docs/audits/RECORDING_CATALOG_AUDIT_2026-10-05.md): the catalog reads a segment's start time from its file name as
 * UTC. MediaMTX writes that name in the LOCAL time of its process (internal/recordstore/path.go: Path.Encode formats
 * p.Start in its own zone), so the container must run in UTC or every segment is shifted by the zone offset, silently.
 */
import fs from 'fs';
import path from 'path';

const load = (file: string) => require('js-yaml').load(fs.readFileSync(path.join(__dirname, '../../../', file), 'utf8')) as any;

const envOf = (svc: any): Record<string, string> => {
  const e = svc?.environment ?? [];
  if (Array.isArray(e)) return Object.fromEntries(e.map((x: string) => [x.split('=')[0], x.slice(x.indexOf('=') + 1)]));
  return e;
};

describe('MediaMTX time zone', () => {
  it('the recording service runs in UTC (TZ=UTC), so segment file names are UTC wall-clock time', () => {
    expect(envOf(load('docker-compose.yml').services.mediamtx).TZ).toBe('UTC');
  });

  it('the production override does not change the time zone', () => {
    const prod = load('deploy/packaging/docker-compose.prod.yml').services.mediamtx;
    expect(envOf(prod).TZ ?? 'UTC').toBe('UTC');
  });

  it('segment file names still start with the zone-free pattern the catalog parses as UTC', () => {
    expect(load('mediamtx.yml').pathDefaults.recordPath).toBe('/recordings/%path/%Y-%m-%d_%H-%M-%S-%f');
  });
});
