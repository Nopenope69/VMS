import fs from 'fs';
import path from 'path';
import { ensureFrontendDist } from './helpers/ensureFrontendDist';

/**
 * P0.3: demo hazards must be absent from the production frontend bundle.
 * CI's backend job downloads the production dist built by the frontend job (VITE_DEMO_MODE unset).
 * On a fresh local clone, frontendStaticValidation.test.ts builds dist first; if dist is missing
 * this test fails rather than passing vacuously.
 */
describe('Production frontend bundle contains no demo hazards', () => {
  const frontendDir = path.resolve(__dirname, '../../../frontend');
  const distDir = path.join(frontendDir, 'dist');
  const denylist: string[] = JSON.parse(
    fs.readFileSync(path.join(frontendDir, 'scripts/demo-bundle-denylist.json'), 'utf8')
  ).strings;

  beforeAll(() => {
    ensureFrontendDist();
  }, 300000);

  const collect = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return collect(full);
      return /\.(js|html|css)$/.test(e.name) ? [full] : [];
    });

  it('has a non-trivial denylist including the bypass button and default credentials', () => {
    expect(denylist).toEqual(
      expect.arrayContaining(['Bypass & Test UI', 'Password123!', 'vigilone_dev_setup_token'])
    );
  });

  it('dist exists and contains a JavaScript bundle', () => {
    expect(fs.existsSync(distDir)).toBe(true);
    expect(collect(distDir).some((f) => f.endsWith('.js'))).toBe(true);
  });

  it('no denylisted string appears in any production asset', () => {
    const hits: string[] = [];
    for (const file of collect(distDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const s of denylist) {
        if (content.includes(s)) hits.push(`${path.basename(file)}: ${s}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('demo code is gated by the build-time __DEMO_MODE__ constant, not a runtime toggle', () => {
    const viteConfig = fs.readFileSync(path.join(frontendDir, 'vite.config.ts'), 'utf8');
    expect(viteConfig).toContain("__DEMO_MODE__: JSON.stringify(DEMO_MODE)");
    expect(viteConfig).toContain("process.env.VITE_DEMO_MODE === 'true'");
  });
});
