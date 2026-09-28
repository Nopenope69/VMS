import path from 'path';
import fs from 'fs';
import {
  evaluate,
  findCatchBlocks,
  scanRepo,
  scanSource,
  AllowlistEntry,
} from '../../scripts/ci/check-no-fake-success';

describe('P0.4 fail-loud gate (check-no-fake-success)', () => {
  const ids = (src: string) => scanSource('x.ts', src).map((f) => f.patternId);

  it('flags success literals inside catch blocks', () => {
    const src = [
      'async function f() {',
      '  try {',
      '    await send();',
      '  } catch (err) {',
      "    console.warn('offline');",
      '    return { success: true };',
      '  }',
      '}',
    ].join('\n');
    expect(ids(src)).toContain('SUCCESS_IN_CATCH');
  });

  it('does not flag success outside catch blocks', () => {
    const src = ['try {', '  return { success: true };', '} catch (e) {', '  return { success: false };', '}'].join('\n');
    expect(ids(src)).not.toContain('SUCCESS_IN_CATCH');
  });

  it('finds catch block extents with nested braces and brace-containing strings', () => {
    const lines = ['try {', '} catch (e) {', "  const s = '{';", '  if (x) { y(); }', '}', 'after();'];
    expect(findCatchBlocks(lines)).toEqual([[1, 4]]);
  });

  it.each([
    ["const mockDriver = makeDriver();", 'MOCK_OR_STUB_IDENTIFIER'],
    ["this.mode = 'test-stub';", 'MOCK_OR_STUB_IDENTIFIER'],
    ["private s3Store = new Map();", 'IN_MEMORY_EXTERNAL_STORE'],
    ["if (process.env.NODE_ENV !== 'production') useFake();", 'NON_TEST_ENV_FALLBACK'],
    ['return { confirmed: true };', 'HARDCODED_CONFIRMATION'],
    ["const h = '0'.repeat(64);", 'INVENTED_HASH'],
    ["firmwareVersion: '1.0.0',", 'INVENTED_VERSION'],
    ["modelName: 'yolov8n',", 'HARDCODED_MODEL_NAME'],
  ])('flags %s as %s', (line, id) => {
    expect(ids(line)).toContain(id);
  });

  it('ignores comment lines', () => {
    expect(ids('// return { confirmed: true } was the old mock behaviour')).toEqual([]);
  });

  it('reports un-allowlisted, stale and unjustified entries', () => {
    const findings = scanSource('a.ts', 'return { confirmed: true };');
    const allow: AllowlistEntry[] = [
      { file: 'a.ts', patternId: 'HARDCODED_CONFIRMATION', text: 'return { confirmed: true };', justification: 'short' },
      { file: 'gone.ts', patternId: 'INVENTED_HASH', text: 'x', justification: 'a long enough justification text' },
    ];
    const res = evaluate(findings, allow);
    expect(res.violations).toEqual([]);
    expect(res.unjustified).toHaveLength(1);
    expect(res.stale.map((s) => s.file)).toEqual(['gone.ts']);
    expect(evaluate(findings, []).violations).toHaveLength(1);
  });

  it('the repository passes the gate with its committed allowlist', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const allowlist = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../scripts/ci/fake-success-allowlist.json'), 'utf8')
    ).entries;
    const res = evaluate(scanRepo(repoRoot), allowlist);
    expect(res.violations).toEqual([]);
    expect(res.stale).toEqual([]);
    expect(res.unjustified).toEqual([]);
  });
});
