import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { CrashRecoveryService } from '../services/reconciliation/crashRecovery.service';

// Assigning undefined to process.env stores the string "undefined", which leaks into later test files.
const restoreGrace = (saved: string | undefined) => {
  if (saved === undefined) delete process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
  else process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS = saved;
};

/**
 * Regression (found in the Phase 1 rehearsal): crash recovery runs at every backend start while
 * MediaMTX keeps recording. It must not touch segments that are still being written: a freshly
 * opened segment is 0 bytes (was unlinked) and a partially written one probes as truncated (was
 * replaced by a remuxed copy, orphaning the recorder's open file descriptor).
 */
describe('CrashRecovery leaves actively written segments alone', () => {
  let root: string;
  const prismaStub: any = {};

  const savedGrace = process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
  beforeEach(() => {
    delete process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS; // production default (120 s)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-cr-active-'));
    fs.mkdirSync(path.join(root, 'cam_a'));
  });
  afterEach(() => {
    restoreGrace(savedGrace);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeTruncatedFmp4 = (file: string) => {
    const full = `${file}.full.mp4`;
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '3', '-c:v', 'libx264', '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-y', full]);
    const buf = fs.readFileSync(full);
    fs.writeFileSync(file, buf.subarray(0, Math.floor(buf.length * 0.4)));
    fs.unlinkSync(full);
  };

  it('does not unlink a fresh zero-byte segment (the recorder just opened it)', async () => {
    const f = path.join(root, 'cam_a', '2026-09-26_10-00-00-000000.mp4');
    fs.writeFileSync(f, '');
    await new CrashRecoveryService(prismaStub).recoverStorage([root]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('does not replace or move a fresh partially written segment', async () => {
    const f = path.join(root, 'cam_a', '2026-09-26_10-00-10-000000.mp4');
    writeTruncatedFmp4(f);
    const inode = fs.statSync(f).ino;
    await new CrashRecoveryService(prismaStub).recoverStorage([root]);
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(f).ino).toBe(inode);
  });

  it('still prunes a zero-byte segment that has not been written for longer than the grace period', async () => {
    const f = path.join(root, 'cam_a', '2026-09-26_09-00-00-000000.mp4');
    fs.writeFileSync(f, '');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(f, old, old);
    await new CrashRecoveryService(prismaStub).recoverStorage([root]);
    expect(fs.existsSync(f)).toBe(false);
  });
});

describe('RecordingCatalog orphan admission control leaves actively written files alone', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require('../config/env').default;
  const savedDir = config.RECORDINGS_DIR;
  const savedGrace = process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
  let root: string;

  beforeEach(() => {
    delete process.env.CRASH_RECOVERY_ACTIVE_WRITE_GRACE_SECONDS;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-catalog-active-'));
    fs.mkdirSync(path.join(root, 'unregistered_cam'));
    config.RECORDINGS_DIR = root;
  });
  afterEach(() => {
    config.RECORDINGS_DIR = savedDir;
    restoreGrace(savedGrace);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('moves only orphan files older than the grace period', async () => {
    const { RecordingCatalog } = await import('../services/recording/catalog/recordingCatalog.service');
    const prismaStub: any = { camera: { findFirst: jest.fn().mockResolvedValue(null) } };
    const fresh = path.join(root, 'unregistered_cam', '2026-09-26_10-00-00-000000.mp4');
    const stale = path.join(root, 'unregistered_cam', '2026-09-26_09-00-00-000000.mp4');
    fs.writeFileSync(fresh, 'x');
    fs.writeFileSync(stale, 'y');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    await new RecordingCatalog(prismaStub).reconcileFilesystem();

    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(root, 'unregistered_cam', '.quarantine', path.basename(stale)))).toBe(true);
  });
});
