/**
 * ai-worker entrypoint.
 *
 * Modes (AI_WORKER_MODE):
 *  - pipeline (default): register the configured model with the backend, run whichever model the
 *    backend has deployed, pull frames from the MediaMTX loopback for every online camera, track,
 *    and post confirmed detections with provenance. Also serves ai-adapter.v1 over HTTP.
 *  - adapter-only: serve ai-adapter.v1 for the configured local model; no backend, no cameras.
 *
 * Environment:
 *  AI_MODEL_KEY               lock-file key of the model to install/register (default: lock default)
 *  VIGILONE_MODELS_DIR        directory holding the artefacts (fetch-model.sh destination)
 *  VIGILONE_MODEL_LOCK        path to models.lock.json (default: repo copy or /app/models.lock.json)
 *  AI_ADAPTER_ID              provenance adapter id (default vigilone-ai-worker)
 *  AI_ADAPTER_HOST/PORT       HTTP bind (default 127.0.0.1:7010)
 *  BACKEND_INTERNAL_URL       e.g. http://backend:4000/api/v1/internal (pipeline mode)
 *  INTERNAL_API_SECRET        shared secret for the internal API (pipeline mode)
 *  AI_DETECT_FPS              frames per second sampled per camera (1..5, default 1)
 *  AI_MAX_STREAMS             cameras processed concurrently (default 16)
 *  AI_INFERENCE_TIMEOUT_MS    per-frame deadline (default 1000)
 *  AI_GATE_MODE               motion gating: 'motion' (default) or 'off' (P2.5)
 *  AI_EXIT_ON_REFUSAL         exit with code 78 when the model is refused (default true)
 *  AI_MAX_SYNC_FAILURES       consecutive camera-sync failures before exiting with 75 so the
 *                             container restarts (default 10; ~5 min at the 30 s sync interval)
 */
import fs from 'fs';
import { AiWorker } from './worker';
import { createAdapterServer } from './adapter/httpServer';
import { findLockEntry, artifactPathFor, manifestFromLockEntry, readModelLock, ModelLockEntry } from './modelCatalog';
import { ModelRefusalError } from './modelLoader';
import { StreamSupervisor } from './streamSupervisor';
import { ResourceGovernor } from './frameQueue';
import { MetricsRegistry } from './metrics';
import { ModelManifestRecord } from './types';

export const EXIT_MODEL_REFUSED = 78; // EX_CONFIG
export const EXIT_TEMPFAIL = 75; // EX_TEMPFAIL

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'ai-worker', msg, ...extra }));
}

export interface BootResult {
  worker: AiWorker;
  close: () => Promise<void>;
  port: number;
}

export async function boot(): Promise<BootResult> {
  const mode = env('AI_WORKER_MODE', 'pipeline');
  const lock = readModelLock();
  const key = env('AI_MODEL_KEY', lock.default)!;
  const localEntry = findLockEntry(key, lock);
  const metrics = new MetricsRegistry();
  const worker = new AiWorker(
    {
      backendBaseUrl: env('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4000/api/v1/internal')!,
      internalSecret: env('INTERNAL_API_SECRET', '')!,
      adapterId: env('AI_ADAPTER_ID', 'vigilone-ai-worker'),
      schedulerOptions: { maxConcurrency: 2, timeoutMs: Number(env('AI_INFERENCE_TIMEOUT_MS', '1000')) },
    },
    undefined,
    metrics
  );

  let supervisor: StreamSupervisor | null = null;
  const server = createAdapterServer(worker.core, {
    extraMetrics: () => (supervisor ? supervisor.renderMetrics() : ''),
  });
  const host = env('AI_ADAPTER_HOST', '127.0.0.1')!;
  const port = Number(env('AI_ADAPTER_PORT', '7010'));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as any).port as number;
  log('info', 'ai-adapter.v1 listening', { host, port: boundPort, mode });

  const close = async () => {
    if (supervisor) await supervisor.stopAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  if (mode === 'adapter-only') {
    const manifest = manifestFromLockEntry(localEntry, `${localEntry.name}@${localEntry.version}`);
    await loadOrRefuse(worker, manifest, localEntry, null);
    return { worker, close, port: boundPort };
  }

  if (mode !== 'pipeline') throw new Error(`Unknown AI_WORKER_MODE '${mode}'`);
  if (!env('INTERNAL_API_SECRET')) throw new Error('INTERNAL_API_SECRET is required in pipeline mode');

  const api = worker.getApiClient();
  // 1. Register the installed model (idempotent; the backend validates licences and immutability).
  const registered = await api.registerModelManifest(localEntry);
  // 2. First boot: deploy it if nothing is deployed yet (audited as MODEL_DEPLOY by SYSTEM).
  await api.bootstrapDeploy(registered.id, worker.core.adapterId);
  // 3. Run whatever the backend has deployed (it may be another registered model).
  const deployed = await api.getDeployedModel('object_detection');
  if (!deployed) throw new Error('Backend reports no deployed object_detection model');
  const entry = lock.models.find((m) => m.name === deployed.name && m.version === deployed.version);
  const manifest: ModelManifestRecord = {
    id: deployed.id,
    name: deployed.name,
    version: deployed.version,
    sha256: deployed.sha256,
    codeLicense: deployed.codeLicense,
    weightLicense: deployed.weightLicense,
    runtimeConfigJson: deployed.runtimeConfigJson,
    thresholdsJson: deployed.thresholdsJson ?? undefined,
    classesJson: deployed.classesJson ?? undefined,
    modelSignatureJson: deployed.modelSignatureJson ?? undefined,
    nmsConfigJson: deployed.nmsConfigJson ?? undefined,
    isActive: deployed.isActive,
    weightsSource: deployed.weightsSource,
  };
  await loadOrRefuse(worker, manifest, entry ?? null, deployed.evaluationJson ?? null);

  // 4. Frames: MediaMTX loopback only (single-RTSP-stream invariant), letterboxed per the model.
  const rc = manifest.runtimeConfigJson;
  supervisor = new StreamSupervisor({
    apiClient: api,
    aiWorker: worker,
    governor: new ResourceGovernor({ maxConcurrentStreams: Number(env('AI_MAX_STREAMS', '16')) }),
    metrics,
    gateMode: env('AI_GATE_MODE', 'motion') === 'off' ? 'off' : 'motion',
    defaultStreamConfig: {
      fps: Number(env('AI_DETECT_FPS', '1')),
      width: rc.inputWidth,
      height: rc.inputHeight,
      letterbox: rc.letterbox !== false,
      padPosition: rc.padPosition,
      padValue: rc.padValue,
    },
  });
  supervisor.on('warn', (m) => log('warn', String(m)));
  // Watchdog: if the backend stays unreachable (e.g. MediaMTX, whose network namespace this
  // container shares, was restarted), exit so the orchestrator restarts the worker cleanly.
  const maxSyncFailures = Number(env('AI_MAX_SYNC_FAILURES', '10'));
  supervisor.on('syncResult', ({ consecutiveFailures }: { consecutiveFailures: number }) => {
    if (consecutiveFailures >= maxSyncFailures) {
      log('error', 'backend unreachable for too long; exiting for a clean restart', { consecutiveFailures });
      process.exit(EXIT_TEMPFAIL);
    }
  });
  supervisor.on('streamError', (e) => log('warn', 'stream error', e));
  supervisor.on('inferenceError', (e) => log('warn', 'inference error', e));
  await supervisor.start();
  return { worker, close, port: boundPort };
}

async function loadOrRefuse(
  worker: AiWorker,
  manifest: ModelManifestRecord,
  entry: ModelLockEntry | null,
  evaluation: any
): Promise<void> {
  const artifact = entry ? artifactPathFor(entry) : null;
  try {
    if (!artifact || !fs.existsSync(artifact)) {
      throw new ModelRefusalError(
        'ARTIFACT_MISSING',
        `No local artefact for '${manifest.name}:${manifest.version}'` + (entry ? ` at ${artifact}` : ' (not in the model lock file)')
      );
    }
    await worker.initializeModel(manifest, artifact, evaluation);
    log('info', 'model loaded', { model: `${manifest.name}:${manifest.version}`, sha256: manifest.sha256 });
    await reportLifecycle(worker, { action: 'MODEL_LOADED', manifest });
  } catch (err: any) {
    const code = err instanceof ModelRefusalError ? err.code : 'RUNTIME_ERROR';
    worker.core.fail(`${code}: ${err.message}`);
    log('error', 'model refused', { code, error: err.message });
    await reportLifecycle(worker, {
      action: 'MODEL_LOAD_REFUSED',
      manifest,
      reasonCode: code,
      message: err.message,
      computedSha256: err instanceof ModelRefusalError ? err.computedSha256 : undefined,
    });
    throw err;
  }
}

async function reportLifecycle(
  worker: AiWorker,
  r: { action: 'MODEL_LOADED' | 'MODEL_LOAD_REFUSED'; manifest: ModelManifestRecord; reasonCode?: string; message?: string; computedSha256?: string }
) {
  if (env('AI_WORKER_MODE', 'pipeline') !== 'pipeline') return;
  const rt = (worker as any).engine?.getRuntimeInfo?.();
  try {
    await worker.getApiClient().reportModelLifecycle({
      action: r.action,
      modelManifestId: r.manifest.id,
      modelName: r.manifest.name,
      modelVersion: r.manifest.version,
      computedSha256: r.computedSha256,
      adapterId: worker.core.adapterId,
      reasonCode: r.reasonCode,
      message: r.message,
      runtime: rt?.runtime,
      runtimeVersion: rt?.runtimeVersion ?? null,
      executionProvider: rt?.executionProvider ?? null,
    });
  } catch (err: any) {
    // The audit report is best effort only in the sense that the worker state is already safe
    // (refused = no inference); the failure itself is logged loudly.
    log('error', 'could not report model lifecycle event to the backend', { error: err.message, action: r.action });
  }
}

if (require.main === module) {
  boot()
    .then(({ close }) => {
      const shutdown = () => close().then(() => process.exit(0));
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      const refused = err instanceof ModelRefusalError;
      log('error', 'ai-worker failed to start', { error: err.message, refused });
      if (refused && env('AI_EXIT_ON_REFUSAL', 'true') !== 'true') return; // keep serving health=FAILED
      process.exit(refused ? EXIT_MODEL_REFUSED : 1);
    });
}
