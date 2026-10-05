/**
 * llama.cpp's llama-server as a child of the worker, for the pipelines that run a GGUF model (the VLM second
 * opinion, the query rewrite). The worker starts it itself with the files it has just verified, on a loopback port
 * with a fresh random API key, and checks before anything is asked that the server reports the pinned llama.cpp
 * commit and the verified model path. So the model that answers is provably the one named in provenance.
 */
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { AnprLoadError } from '../anpr/anprService';

export interface LlamaServerOptions {
  bin: string;
  model: string;
  /** Extra model files, e.g. ['--mmproj', projector]. */
  extraArgs?: string[];
  contextSize: number;
  threads?: number;
  /** The pinned llama.cpp commit; the server's build_info must end with its first 7 characters. */
  commit: string;
  tag: string;
  /** The server must report vision input (a projector loaded). */
  requireVision?: boolean;
  /** Use the model's own (Jinja) chat template; needed for Qwen3's no-thinking switch. */
  jinja?: boolean;
  startupTimeoutMs?: number;
}

export interface LlamaServer {
  base: string;
  headers: Record<string, string>;
  buildInfo: string;
  binarySha256: string;
  /** Why the server can no longer answer, or null while it runs. */
  exited(): string | null;
  close(): Promise<void>;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function startLlamaServer(o: LlamaServerOptions): Promise<LlamaServer> {
  if (!fs.existsSync(o.bin)) throw new AnprLoadError('ARTIFACT_MISSING', `llama-server binary ${o.bin} not found`);
  const binarySha256 = await sha256File(o.bin);
  const port = await freePort();
  const apiKey = crypto.randomBytes(24).toString('hex');
  const threads = o.threads ?? Math.max(1, os.cpus().length);
  const args = [
    '-m', o.model, ...(o.extraArgs ?? []),
    '--host', '127.0.0.1', '--port', String(port),
    '--api-key', apiKey,
    '-t', String(threads), '-c', String(o.contextSize),
    '--parallel', '1', '--no-webui',
    ...(o.jinja ? ['--jinja'] : []),
  ];
  const child: ChildProcess = spawn(o.bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env } });
  let exited: string | null = null;
  let stderrTail = '';
  child.stderr!.on('data', (c: Buffer) => {
    stderrTail = (stderrTail + c.toString('utf8')).slice(-2000);
  });
  child.on('exit', (code, signal) => {
    exited = `llama-server exited (code ${code}, signal ${signal})`;
  });
  child.on('error', (e) => {
    exited = `llama-server could not start: ${e.message}`;
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${apiKey}` };
  const close = async () => {
    if (exited) return;
    child.kill('SIGTERM');
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
  };

  try {
    const deadline = Date.now() + (o.startupTimeoutMs ?? 300_000);
    for (;;) {
      if (exited) throw new AnprLoadError('INVALID_PIPELINE', `${exited}: ${stderrTail.slice(-500)}`);
      if (Date.now() > deadline) throw new AnprLoadError('INVALID_PIPELINE', 'llama-server did not become ready in time');
      try {
        const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) break;
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const props: any = await (await fetch(`${base}/props`, { headers, signal: AbortSignal.timeout(5000) })).json();
    const buildInfo = String(props?.build_info ?? '');
    if (!buildInfo.endsWith(o.commit.slice(0, 7))) {
      throw new AnprLoadError('INVALID_PIPELINE', `llama-server reports build '${buildInfo}', the pipeline pins llama.cpp ${o.tag} (${o.commit.slice(0, 7)})`);
    }
    if (path.resolve(String(props?.model_path ?? '')) !== path.resolve(o.model)) {
      throw new AnprLoadError('INVALID_PIPELINE', `llama-server serves ${props?.model_path}, not the verified ${o.model}`);
    }
    if (o.requireVision && (!Array.isArray(props?.modalities) ? props?.modalities?.vision !== true : !props.modalities.includes('vision'))) {
      throw new AnprLoadError('INVALID_PIPELINE', 'llama-server has no vision input (the projector did not load)');
    }
    return { base, headers, buildInfo, binarySha256, exited: () => exited, close };
  } catch (e) {
    await close();
    throw e;
  }
}
