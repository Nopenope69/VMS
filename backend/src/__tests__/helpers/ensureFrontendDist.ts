import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * Builds frontend/dist (production mode, VITE_DEMO_MODE unset) if it is missing, so frontend
 * static tests work on a fresh clone. CI instead downloads the dist built by the frontend job.
 * Build failures are logged; callers' assertions then fail loudly on the missing dist.
 */
export function ensureFrontendDist(): string {
  const frontendDir = path.resolve(__dirname, '../../../../frontend');
  const distDir = path.join(frontendDir, 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    return distDir;
  }
  try {
    if (!fs.existsSync(path.join(frontendDir, 'node_modules'))) {
      execSync('npm ci', { cwd: frontendDir, stdio: 'pipe' });
    }
    const env = { ...process.env };
    delete env.VITE_DEMO_MODE;
    execSync('npm run build', { cwd: frontendDir, stdio: 'pipe', env });
  } catch (err: any) {
    const detail = err?.stderr?.toString?.() || err?.message || String(err);
    console.error(`[ensureFrontendDist] frontend build failed:\n${detail}`);
  }
  return distDir;
}
