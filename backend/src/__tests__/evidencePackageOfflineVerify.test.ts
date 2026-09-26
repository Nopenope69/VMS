import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { PackageAssembler } from '../services/evidence/archive/packageAssembler';

/**
 * Phase 1 acceptance criterion "every export verifies": a package produced by the real assembler
 * must verify with the independent offline verifier (scripts/acceptance/verify-evidence-package.mjs),
 * and any tampering must be detected.
 */
describe('Evidence package verifies offline with the independent verifier', () => {
  const verifier = path.resolve(__dirname, '../../../scripts/acceptance/verify-evidence-package.mjs');
  let work: string;
  let zip: string;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-evpkg-'));
    const video = path.join(work, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '2', '-c:v', 'libx264', '-y', video]);
    zip = path.join(work, 'Evidence_TEST.zip');
    await PackageAssembler.assemblePackage({
      exportId: 'OFFLINE_VERIFY_1',
      targetZipPath: zip,
      videoFilePath: video,
      manifestData: { exportId: 'OFFLINE_VERIFY_1', evidenceMerkleRoot: 'f'.repeat(64), leafCount: 1 },
      applianceSignature: '',
      custodyHistory: [{ action: 'EXPORT_CREATED', actor: 'test', at: '2026-09-26T10:00:00.000Z' }],
    });
  }, 60000);

  afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

  const verify = (file: string) => spawnSync('node', [verifier, file, '--json'], { encoding: 'utf8' });

  it('a freshly assembled package passes every offline check', () => {
    const r = verify(zip);
    const out = JSON.parse(r.stdout);
    expect(out.checks.filter((c: any) => c.status !== 'PASS')).toEqual([]);
    expect(out.verdict).toBe('PASS');
    expect(r.status).toBe(0);
  });

  it('detects a tampered video artifact', () => {
    const dir = path.join(work, 'tamper-video');
    execFileSync('unzip', ['-q', zip, '-d', dir]);
    const v = path.join(dir, 'video.mp4');
    const b = fs.readFileSync(v);
    b[b.length - 10] ^= 0xff;
    fs.writeFileSync(v, b);
    const tampered = path.join(work, 'tampered-video.zip');
    execFileSync('zip', ['-q', '-r', tampered, '.'], { cwd: dir });
    const out = JSON.parse(verify(tampered).stdout);
    expect(out.verdict).toBe('FAIL');
    expect(out.checks.find((c: any) => c.name === 'artifact:video.mp4').status).toBe('FAIL');
  });

  it('detects an edited manifest (signature and digest no longer match)', () => {
    const dir = path.join(work, 'tamper-manifest');
    execFileSync('unzip', ['-q', zip, '-d', dir]);
    const m = path.join(dir, 'manifest.json');
    fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace('OFFLINE_VERIFY_1', 'OFFLINE_VERIFY_2'));
    const tampered = path.join(work, 'tampered-manifest.zip');
    execFileSync('zip', ['-q', '-r', tampered, '.'], { cwd: dir });
    const out = JSON.parse(verify(tampered).stdout);
    expect(out.checks.find((c: any) => c.name === 'manifest-signature').status).toBe('FAIL');
    expect(out.checks.find((c: any) => c.name === 'manifest-digest').status).toBe('FAIL');
  });
});
