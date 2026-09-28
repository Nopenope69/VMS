// Small process helpers shared by the bench, soak and acceptance scripts (no npm dependencies).
import { spawn } from 'node:child_process';

/** Runs a command, resolving with { code, stdout, stderr, timedOut, ms }. Never rejects on non-zero exit. */
export function run(cmd, args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false, ms: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, ms: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function toolVersion(cmd) {
  const r = await run(cmd, ['-version'], { timeoutMs: 10000 });
  return r.code === 0 ? r.stdout.split('\n')[0].trim() : null;
}

/** Parses "--key value" and "--flag" arguments. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Redacts credentials embedded in rtsp://user:pass@host URLs before they are written anywhere. */
export const redactUrl = (u) => String(u).replace(/(rtsps?:\/\/)[^@/\s]+@/i, '$1***:***@');
