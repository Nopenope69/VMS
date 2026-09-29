import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { CropStore, CropStoreError, DEFAULT_CROP_POLICY, PurgeCandidate } from '../services/crops/cropStore';

const GB = 1024 ** 3;
const at = new Date('2026-09-29T10:00:00.000Z');
const bytes = Buffer.from('fake-jpeg-bytes');
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'crops-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const mk = (over = {}, free = () => 100 * GB, now = () => at) => new CropStore(root, { ...DEFAULT_CROP_POLICY, ...over }, free, now);
const inp = (o = {}) => ({ tenantId: 't1', cameraId: 'c1', cropId: 'x1', capturedAt: at, cropClass: 'NON_PERSON' as const, bytes, ...o });
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as CropStoreError).code;
  }
  return 'NO_ERROR';
};

describe('CropStore', () => {
  it('writes atomically, returns the hash, and leaves no temp file', () => {
    const r = mk().write(inp());
    expect(r.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(r.relativePath).toBe('t1/c1/2026-09-29/x1.jpg');
    expect(fs.readFileSync(path.join(root, r.relativePath))).toEqual(bytes);
    expect(fs.readdirSync(path.dirname(path.join(root, r.relativePath))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects unsafe ids so no path can leave the root', () => {
    for (const bad of ['../x', 'a/b', '', '.hidden', 'a\\b', 'a\0b', 'x'.repeat(200)]) {
      expect(code(() => mk().write(inp({ cropId: bad })))).toBe('BAD_ID');
      expect(code(() => mk().write(inp({ tenantId: bad })))).toBe('BAD_ID');
      expect(code(() => mk().write(inp({ cameraId: bad })))).toBe('BAD_ID');
    }
    expect(code(() => mk().resolveInside('../../etc/passwd'))).toBe('BAD_ID');
    expect(code(() => mk().write(inp({ capturedAt: new Date(NaN) })))).toBe('BAD_ID');
  });

  it('refuses person crops unless the site enabled them, and gives them the shorter retention', () => {
    expect(code(() => mk().write(inp({ cropClass: 'PERSON' })))).toBe('POLICY_DENIED');
    expect(fs.readdirSync(root)).toEqual([]);
    const p = mk({ personCropsEnabled: true }).write(inp({ cropClass: 'PERSON' }));
    const n = mk().write(inp({ cropId: 'x2' }));
    expect((p.expiresAt.getTime() - at.getTime()) / 86_400_000).toBe(7);
    expect((n.expiresAt.getTime() - at.getTime()) / 86_400_000).toBe(14);
  });

  it('fails loud on low space and on unreadable space, writing nothing', () => {
    expect(code(() => mk({ minFreeBytes: 5 * GB }, () => 5 * GB).write(inp()))).toBe('LOW_SPACE');
    expect(code(() => mk({}, () => { throw new Error('no statfs'); }).write(inp()))).toBe('SPACE_UNKNOWN');
    expect(code(() => mk({}, () => NaN).write(inp()))).toBe('SPACE_UNKNOWN');
    const files = fs.readdirSync(root, { recursive: true } as any).filter((f) => String(f).endsWith('.jpg') || String(f).endsWith('.tmp'));
    expect(files).toEqual([]);
  });

  it('refuses empty and oversize crops', () => {
    expect(code(() => mk().write(inp({ bytes: Buffer.alloc(0) })))).toBe('EMPTY');
    expect(code(() => mk({ maxCropBytes: 4 }).write(inp()))).toBe('TOO_LARGE');
  });

  it('readVerified detects tampering and reports a missing file as null', () => {
    const s = mk();
    const r = s.write(inp());
    expect(s.readVerified(r.relativePath, r.sha256)).toEqual(bytes);
    fs.writeFileSync(path.join(root, r.relativePath), 'changed');
    expect(code(() => s.readVerified(r.relativePath, r.sha256))).toBe('WRITE_FAILED');
    fs.rmSync(path.join(root, r.relativePath));
    expect(s.readVerified(r.relativePath, r.sha256)).toBeNull();
  });

  it('purge deletes only expired, unheld crops and fails closed on a throwing hold check', () => {
    const later = new Date(at.getTime() + 30 * 86_400_000);
    const s = mk({}, () => 100 * GB, () => later);
    const cand = (id: string, expires: Date): PurgeCandidate => {
      const r = s.write(inp({ cropId: id }));
      return { cropId: id, tenantId: 't1', relativePath: r.relativePath, expiresAt: expires };
    };
    const old = cand('old', new Date(at.getTime() + 1000));
    const held = cand('held', new Date(at.getTime() + 1000));
    const boom = cand('boom', new Date(at.getTime() + 1000));
    const fresh = cand('fresh', new Date(later.getTime() + 86_400_000));
    const gone: PurgeCandidate = { cropId: 'gone', tenantId: 't1', relativePath: 't1/c1/2026-09-29/gone.jpg', expiresAt: new Date(at.getTime() + 1000) };
    const res = s.purge([old, held, boom, fresh, gone], (c) => {
      if (c.cropId === 'boom') throw new Error('hold service down');
      return c.cropId === 'held';
    });
    expect(res.deleted).toEqual(['old']);
    expect(res.heldSkipped).toEqual(['held']);
    expect(res.missing).toEqual(['gone']);
    expect(res.failed.map((f) => f.cropId)).toEqual(['boom']);
    expect(fs.existsSync(path.join(root, held.relativePath))).toBe(true);
    expect(fs.existsSync(path.join(root, boom.relativePath))).toBe(true);
    expect(fs.existsSync(path.join(root, fresh.relativePath))).toBe(true);
    expect(fs.existsSync(path.join(root, old.relativePath))).toBe(false);
  });

  it('purge refuses a candidate path that escapes the root and keeps going', () => {
    const s = mk({}, () => 100 * GB, () => new Date(at.getTime() + 99 * 86_400_000));
    const res = s.purge([{ cropId: 'evil', tenantId: 't1', relativePath: '../outside', expiresAt: at }], () => false);
    expect(res.failed.map((f) => f.cropId)).toEqual(['evil']);
  });

  it('constructor requires an absolute root', () => {
    expect(() => new CropStore('relative/dir')).toThrow(CropStoreError);
  });
});
