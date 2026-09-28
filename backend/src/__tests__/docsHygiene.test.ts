import fs from 'fs';
import os from 'os';
import path from 'path';
import { runDocsHygiene, SELF_ASSESSMENT_MARKER } from '../../scripts/ci/docs-hygiene';

const makeRepo = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigilone-docs-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
};
const categories = (files: Record<string, string>) => runDocsHygiene(makeRepo(files)).map((v) => v.category);

describe('P0.6 docs hygiene', () => {
  it('flags leaked developer home paths', () => {
    expect(categories({ 'docs/x.md': 'see /Users/alice/code/vms' })).toContain('Leaked Local Path');
    expect(categories({ 'backend/src/a.ts': "const p = '/home/bob/projects/x';" })).toContain('Leaked Local Path');
    expect(categories({ 'docs/x.md': 'CI log: /home/runner/work/VMS' })).not.toContain('Leaked Local Path');
  });

  it('flags file:/// markdown links', () => {
    expect(categories({ 'docs/x.md': '[state](file:///etc/vigilone/state)' })).toContain('Local file:// Link');
  });

  it('requires the self-assessment marker on stage evidence docs and sign-off claims in docs/audits', () => {
    expect(categories({ 'docs/audits/STAGE_9_VERIFICATION_EVIDENCE.md': '# Stage 9\nPASS' })).toContain(
      'Missing Self-Assessment Disclaimer'
    );
    expect(categories({ 'docs/audits/REVIEW.md': 'Independently verified and signed off by the lab.' })).toContain(
      'Missing Self-Assessment Disclaimer'
    );
    expect(
      categories({ 'docs/audits/REVIEW.md': `> ${SELF_ASSESSMENT_MARKER}\nIndependently verified by nobody.` })
    ).not.toContain('Missing Self-Assessment Disclaimer');
    // Operational templates with blank customer sign-off fields are not claims.
    expect(categories({ 'docs/operations/HANDOVER.md': 'Customer sign-off: ________' })).toEqual([]);
  });

  it('flags hand-typed test counts in living docs but not inside generated blocks or dated audits', () => {
    expect(categories({ 'README.md': 'All 586/586 tests passing.' })).toContain('Hand-Typed Test Count');
    expect(categories({ 'PROJECT_STATE.md': '- 85 suites passing' })).toContain('Hand-Typed Test Count');
    const generated =
      '<!-- TEST_STATUS:START (generated) -->\n| **Total** | | **29/29 tests** |\n<!-- TEST_STATUS:END -->';
    expect(categories({ 'PROJECT_STATE.md': generated })).toEqual([]);
    expect(
      categories({ 'docs/audits/STAGE_1_VERIFICATION_EVIDENCE.md': `${SELF_ASSESSMENT_MARKER}\n322 tests passed` })
    ).toEqual([]);
  });

  it('the repository itself is clean', () => {
    expect(runDocsHygiene(path.resolve(__dirname, '../../..'))).toEqual([]);
  });
});
