/**
 * ai-worker entrypoint.
 *
 * Modes (AI_WORKER_MODE):
 *  - pipeline (default): register the configured model with the backend, run whichever model the
 *    backend has deployed, pull frames from the MediaMTX loopback for every online camera, track,
 *    and post confirmed detections with provenance. Also serves ai-adapter.v1 over HTTP.
 *  - adapter-only: serve ai-adapter.v1 for the configured local model; no backend, no cameras.
 *  - anpr / anpr-adapter-only: plate_recognition pipeline (P4.1), default port 7011.
 *  - redaction / redaction-adapter-only: face and plate regions for redaction (P4.4), default
 *    port 7012. 'redaction' registers the pipeline manifest with the backend; the backend's
 *    redaction jobs call this adapter over HTTP. No cameras are read in this mode.
 *  - vlm / vlm-adapter-only: alarm second opinion (Phase 5 Wave C), SmolVLM2 via a llama-server child
 *    process the worker starts with verified files, default port 7014. 'vlm' registers the pipeline.
 *    Needs VLM_LLAMA_SERVER_BIN (llama-server built from the pinned llama.cpp commit); VLM_THREADS.
 *  - query-rewrite / query-rewrite-adapter-only: plain-language search (Qwen3-4B via a llama-server child process
 *    the worker starts with the verified file), default port 7015. It only rewrites a search request into English;
 *    the backend's rules set the filters. 'query-rewrite' registers the pipeline. Needs QUERY_LLM_LLAMA_SERVER_BIN
 *    (or VLM_LLAMA_SERVER_BIN), the same pinned llama.cpp build; QUERY_LLM_THREADS.
 *  - embedding / embedding-adapter-only: SigLIP 2 crop and text embeddings (Phase 5), default port
 *    7013. 'embedding' registers the pipeline manifest with the backend; the backend's crop embedder
 *    and text search call this adapter over HTTP. No cameras are read in this mode.
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
 *  AI_ATTACH_CROPS            'true' sends a JPEG crop with each CONFIRMED detection for the backend crop
 *                             store (default false; the backend also needs VIGILONE_FEATURE_OBJECT_CROPS)
 *  AI_COLOUR_ATTRIBUTES       'false' stops naming the colours of CONFIRMED detections (default true;
 *                             colourAttributes.ts; the backend track index reads them)
 *  AI_POSE_ESTIMATION         'true' adds body pose (17 keypoints) to CONFIRMED person detections for the person-down
 *                             and fence-climbing rules (default false). Needs the RTMPose-s file and a person's approval
 *                             for its SHA-256; otherwise the worker stops with the reason. AI_POSE_INTERVAL_MS (500),
 *                             AI_POSE_MAX_PER_FRAME (4), AI_POSE_THREADS (1), AI_POSE_MODEL_KEY tune it.
 *  AI_SABOTAGE_DETECTION      'true' checks every sampled frame for a covered, defocused, moved or blinded camera
 *                             (classical image measurements, no model; ADR 0019; default false). The backend records the
 *                             findings only with VIGILONE_FEATURE_CAMERA_SABOTAGE. AI_SABOTAGE_HOLD_SECONDS (10) is how
 *                             long a condition must last before it is reported.
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
import { LoadedQueryRewritePipeline, loadQueryRewritePipeline } from './textllm/queryRewritePipeline';
import { QueryRewriteAdapterCore } from './textllm/queryRewriteAdapterCore';
import { findLockEntry, artifactPathFor, manifestFromLockEntry, readModelLock, ModelLockEntry } from './modelCatalog';
import { ModelRefusalError } from './modelLoader';
import { StreamSupervisor } from './streamSupervisor';
import { SabotageDetector } from './sabotageDetector';
import { ResourceGovernor } from './frameQueue';
import { MetricsRegistry } from './metrics';
import { ModelManifestRecord } from './types';
import { loadAnprPipeline, LoadedAnprPipeline, verifyPipelineComponents } from './anpr/anprService';
import { OrtSession } from './anpr/ortSession';
import { PoseEstimator } from './poseEstimator';
import { findCandidateEntry } from './modelCatalog';
import { AnprAdapterCore } from './anpr/anprAdapterCore';
import { LprRunner } from './anpr/lprRunner';
import { loadRedactionPipeline, LoadedRedactionPipeline } from './redaction/redactionPipeline';
import { RedactionAdapterCore } from './redaction/redactionAdapterCore';
import { loadEmbeddingPipeline, LoadedEmbeddingPipeline } from './embedding/embeddingPipeline';
import { EmbeddingAdapterCore } from './embedding/embeddingAdapterCore';
import { loadVlmPipeline, LoadedVlmPipeline } from './vlm/vlmPipeline';
import { VlmAdapterCore } from './vlm/vlmAdapterCore';
import { AuthenticatedInternalApiClient as ApiClient } from './apiClient';
import { ortRuntimeVersion } from './runtimeInfo';


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
  if (mode === 'anpr' || mode === 'anpr-adapter-only') return bootAnpr(mode);
  if (mode === 'redaction' || mode === 'redaction-adapter-only') return bootRedaction(mode);
  if (mode === 'embedding' || mode === 'embedding-adapter-only') return bootEmbedding(mode);
  if (mode === 'vlm' || mode === 'vlm-adapter-only') return bootVlm(mode);
  if (mode === 'query-rewrite' || mode === 'query-rewrite-adapter-only') return bootQueryRewrite(mode);
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
      attachCrops: env('AI_ATTACH_CROPS', 'false') === 'true',
      colourAttributes: env('AI_COLOUR_ATTRIBUTES', 'true') !== 'false',
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
  if (env('AI_POSE_ESTIMATION', 'false') === 'true') await enablePose(worker);

  // 4. Frames: MediaMTX loopback only (single-RTSP-stream invariant), letterboxed per the model.
  const rc = manifest.runtimeConfigJson;
  supervisor = new StreamSupervisor({
    apiClient: api,
    aiWorker: worker,
    governor: new ResourceGovernor({ maxConcurrentStreams: Number(env('AI_MAX_STREAMS', '16')) }),
    metrics,
    gateMode: env('AI_GATE_MODE', 'motion') === 'off' ? 'off' : 'motion',
    sabotage: sabotageDetectorFromEnv(),
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
  supervisor.on('sabotage', (f) =>
    f.state === 'CLEARED'
      ? log('info', 'camera sabotage cleared', { cameraId: f.cameraId, type: f.type, reason: f.clearReason, clearedAt: f.clearedAt })
      : log('warn', 'camera sabotage suspected', { cameraId: f.cameraId, type: f.type, score: f.score, startedAt: f.startedAt })
  );
  supervisor.on('inferenceError', (e) => log('warn', 'inference error', e));
  await supervisor.start();
  return { worker, close, port: boundPort };
}

/** Camera-sabotage detection (ADR 0019), off unless AI_SABOTAGE_DETECTION=true. A bad hold time stops the worker. */
export function sabotageDetectorFromEnv(): SabotageDetector | undefined {
  if (env('AI_SABOTAGE_DETECTION', 'false') !== 'true') return undefined;
  const hold = Number(env('AI_SABOTAGE_HOLD_SECONDS', '10'));
  if (!Number.isFinite(hold) || hold < 2 || hold > 3600) {
    throw new Error(`AI_SABOTAGE_HOLD_SECONDS must be between 2 and 3600 seconds (got '${env('AI_SABOTAGE_HOLD_SECONDS')}')`);
  }
  return new SabotageDetector({ holdMs: hold * 1000 });
}

/**
 * Body pose (person down, fence climbing). Off unless AI_POSE_ESTIMATION=true. The model is a candidate: it runs only
 * with a person's approval for its exact SHA-256 (model-license-exceptions.json) and a file that matches its pin. If
 * the switch is on and any of that fails, the worker stops with the reason instead of running without pose.
 */
async function enablePose(worker: AiWorker): Promise<void> {
  const key = env('AI_POSE_MODEL_KEY', 'rtmpose-s-body7-256x192') as string;
  const entry = findCandidateEntry(key);
  const { buffers } = verifyPipelineComponents([{ role: 'pose_estimator', key, sha256: entry.sha256 }]);
  const estimator = new PoseEstimator(await OrtSession.create(buffers.pose_estimator, Number(env('AI_POSE_THREADS', '1') as string)));
  worker.setPoseEstimator({
    estimator,
    model: { name: entry.name, version: entry.version, sha256: entry.sha256 },
    intervalMs: Number(env('AI_POSE_INTERVAL_MS', '500')),
    maxPerFrame: Number(env('AI_POSE_MAX_PER_FRAME', '4')),
  });
  log('info', 'body pose enabled', { model: `${entry.name}:${entry.version}`, sha256: entry.sha256 });
}

/**
 * ANPR service (P4.1): the plate_recognition adapter, and in 'anpr' mode the LPR camera runner.
 * The pipeline's models are candidate models: without a human approval for each SHA-256 the
 * service refuses to start (LICENSE_REJECTED) and serves FAILED health, never a silent no-op.
 */
async function bootAnpr(mode: 'anpr' | 'anpr-adapter-only'): Promise<BootResult> {
  const adapterId = env('AI_ADAPTER_ID', 'vigilone-anpr')!;
  const adapterVersion = '1.0.0-phase4';
  let loaded: LoadedAnprPipeline | null = null;
  let failure: string | undefined;
  try {
    loaded = await loadAnprPipeline();
    log('info', 'ANPR pipeline loaded', { pipeline: `${loaded.definition.name}@${loaded.definition.version}`, sha256: loaded.definitionSha256 });
  } catch (e: any) {
    failure = e.message;
    log('error', 'ANPR pipeline refused', { error: e.message });
  }
  const core = new AnprAdapterCore(loaded, { adapterId, adapterVersion, failure });
  let runner: LprRunner | null = null;
  const server = createAdapterServer(core);
  const host = env('AI_ADAPTER_HOST', '127.0.0.1')!;
  const port = Number(env('AI_ADAPTER_PORT', '7011'));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as any).port as number;
  log('info', 'ai-adapter.v1 (plate_recognition) listening', { host, port: boundPort, mode });
  const close = async () => {
    if (runner) await runner.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  if (!loaded) {
    if (env('AI_EXIT_ON_REFUSAL', 'true') === 'true') {
      await close();
      process.exit(EXIT_MODEL_REFUSED);
    }
    return { worker: null as any, close, port: boundPort };
  }
  if (mode === 'anpr-adapter-only') return { worker: null as any, close, port: boundPort };

  if (!env('INTERNAL_API_SECRET')) throw new Error('INTERNAL_API_SECRET is required in anpr mode');
  const api = new ApiClient({ baseUrl: env('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4000/api/v1/internal')!, internalSecret: env('INTERNAL_API_SECRET')! });
  const l = loaded;
  const approvals = l.components.map((c) => c.approval!).filter(Boolean);
  const registered = await api.registerPipelineManifest({
    name: l.definition.name,
    version: l.definition.version,
    sha256: l.definitionSha256,
    task: 'plate_recognition',
    codeLicense: [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND '),
    weightLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
    weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
    trainingData: {
      source: l.components.map((c) => `${c.role}: ${c.entry.trainingData.source}`).join('; '),
      license: 'HUMAN-APPROVED EXCEPTION',
      provenance: approvals.map((a) => `${a.key} approved by ${a.approvedBy} on ${a.approvedAt}: ${a.reason}`).join('; '),
      commercialUse: true,
    },
    runtimeConfig: { runtime: 'onnxruntime', runtimeVersion: ortRuntimeVersion(), executionProvider: 'cpu', inputWidth: l.definition.textDetection.limitSideLen, inputHeight: l.definition.textDetection.limitSideLen, colorSpace: 'BGR', modelFormat: 'ONNX' },
    modelSignature: { decoder: 'anpr_pipeline', components: l.definition.components },
    classes: { '0': 'license_plate' },
  });
  core.setModelId(registered.id);
  runner = new LprRunner(api, core);
  runner.on('warn', (m) => log('warn', String(m)));
  runner.on('streamError', (e) => log('warn', 'LPR stream error', e));
  runner.on('inferenceError', (e) => log('warn', 'ANPR error', e));
  await runner.start();
  return { worker: null as any, close, port: boundPort };
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

/**
 * Redaction regions service (P4.4). Like ANPR, its models are candidate models: without a human
 * approval for each SHA-256 it refuses (LICENSE_REJECTED), serves FAILED health, and redaction jobs
 * that need automatic masks fail with REDACTION_DETECTOR_UNAVAILABLE instead of exporting unmasked.
 */
async function bootRedaction(mode: 'redaction' | 'redaction-adapter-only'): Promise<BootResult> {
  const adapterId = env('AI_ADAPTER_ID', 'vigilone-redaction')!;
  let loaded: LoadedRedactionPipeline | null = null;
  let failure: string | undefined;
  try {
    loaded = await loadRedactionPipeline();
    log('info', 'redaction pipeline loaded', { pipeline: `${loaded.definition.name}@${loaded.definition.version}`, sha256: loaded.definitionSha256 });
  } catch (e: any) {
    failure = e.message;
    log('error', 'redaction pipeline refused', { error: e.message });
  }
  const core = new RedactionAdapterCore(loaded, { adapterId, adapterVersion: '1.0.0-phase4', failure });
  const server = createAdapterServer(core);
  const host = env('AI_ADAPTER_HOST', '127.0.0.1')!;
  const port = Number(env('AI_ADAPTER_PORT', '7012'));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as any).port as number;
  log('info', 'ai-adapter.v1 (redaction regions) listening', { host, port: boundPort, mode });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  if (!loaded) {
    if (env('AI_EXIT_ON_REFUSAL', 'true') === 'true') {
      await close();
      process.exit(EXIT_MODEL_REFUSED);
    }
    return { worker: null as any, close, port: boundPort };
  }
  if (mode === 'redaction-adapter-only') return { worker: null as any, close, port: boundPort };

  if (!env('INTERNAL_API_SECRET')) throw new Error('INTERNAL_API_SECRET is required in redaction mode');
  const api = new ApiClient({ baseUrl: env('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4000/api/v1/internal')!, internalSecret: env('INTERNAL_API_SECRET')! });
  const l = loaded;
  const approvals = l.components.map((c) => c.approval!).filter(Boolean);
  const registered = await api.registerPipelineManifest({
    name: l.definition.name,
    version: l.definition.version,
    sha256: l.definitionSha256,
    task: 'face_detection_for_redaction',
    codeLicense: [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND '),
    weightLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
    weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
    trainingData: {
      source: l.components.map((c) => `${c.role}: ${c.entry.trainingData.source}`).join('; '),
      license: 'HUMAN-APPROVED EXCEPTION',
      provenance: approvals.map((a) => `${a.key} approved by ${a.approvedBy} on ${a.approvedAt}: ${a.reason}`).join('; '),
      commercialUse: true,
    },
    runtimeConfig: { runtime: 'onnxruntime', runtimeVersion: ortRuntimeVersion(), executionProvider: 'cpu', inputWidth: 640, inputHeight: 640, colorSpace: 'BGR', modelFormat: 'ONNX' },
    modelSignature: { decoder: 'redaction_pipeline', components: l.definition.components },
    classes: { '0': 'face', '1': 'license_plate' },
  });
  core.setModelId(registered.id);
  log('info', 'redaction pipeline registered', { modelId: registered.id });
  return { worker: null as any, close, port: boundPort };
}

/**
 * Embedding service (Phase 5): SigLIP 2 image and text towers. Like ANPR and redaction, the models are
 * candidates: without a human approval for each SHA-256 it refuses (LICENSE_REJECTED) and serves FAILED
 * health, so the backend embeds nothing rather than something unverified.
 */
async function bootEmbedding(mode: 'embedding' | 'embedding-adapter-only'): Promise<BootResult> {
  const adapterId = env('AI_ADAPTER_ID', 'vigilone-embedding')!;
  let loaded: LoadedEmbeddingPipeline | null = null;
  let failure: string | undefined;
  try {
    loaded = await loadEmbeddingPipeline();
    log('info', 'embedding pipeline loaded', { pipeline: `${loaded.definition.name}@${loaded.definition.version}`, sha256: loaded.definitionSha256 });
  } catch (e: any) {
    failure = e.message;
    log('error', 'embedding pipeline refused', { error: e.message });
  }
  const core = new EmbeddingAdapterCore(loaded, { adapterId, adapterVersion: '1.0.0-phase5', failure });
  const server = createAdapterServer(core);
  const host = env('AI_ADAPTER_HOST', '127.0.0.1')!;
  const port = Number(env('AI_ADAPTER_PORT', '7013'));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as any).port as number;
  log('info', 'ai-adapter.v1 (embedding) listening', { host, port: boundPort, mode });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  if (!loaded) {
    if (env('AI_EXIT_ON_REFUSAL', 'true') === 'true') {
      await close();
      process.exit(EXIT_MODEL_REFUSED);
    }
    return { worker: null as any, close, port: boundPort };
  }
  if (mode === 'embedding-adapter-only') return { worker: null as any, close, port: boundPort };

  if (!env('INTERNAL_API_SECRET')) throw new Error('INTERNAL_API_SECRET is required in embedding mode');
  const api = new ApiClient({ baseUrl: env('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4000/api/v1/internal')!, internalSecret: env('INTERNAL_API_SECRET')! });
  const l = loaded;
  const approvals = l.components.map((c) => c.approval!).filter(Boolean);
  const registered = await api.registerPipelineManifest({
    name: l.definition.name,
    version: l.definition.version,
    sha256: l.definitionSha256,
    task: 'embedding',
    codeLicense: [...new Set(l.components.map((c) => c.entry.codeLicense))].join(' AND '),
    weightLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
    weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
    trainingData: {
      source: l.components.map((c) => `${c.role}: ${c.entry.trainingData.source}`).join('; '),
      license: 'HUMAN-APPROVED EXCEPTION',
      provenance: approvals.map((a) => `${a.key} approved by ${a.approvedBy} on ${a.approvedAt}: ${a.reason}`).join('; '),
      commercialUse: true,
    },
    runtimeConfig: { runtime: 'onnxruntime', runtimeVersion: ortRuntimeVersion(), executionProvider: 'cpu', inputWidth: 224, inputHeight: 224, colorSpace: 'RGB', modelFormat: 'ONNX' },
    modelSignature: { decoder: 'embedding_pipeline', components: l.definition.components },
    classes: { '0': 'embedding' },
  });
  core.setModelId(registered.id);
  log('info', 'embedding pipeline registered', { modelId: registered.id });
  return { worker: null as any, close, port: boundPort };
}

/**
 * Alarm second opinion (Phase 5 Wave C). Candidate models: without a human approval for each SHA-256 it
 * refuses (LICENSE_REJECTED) and serves FAILED health, so the backend records no second opinions.
 */
async function bootVlm(mode: 'vlm' | 'vlm-adapter-only'): Promise<BootResult> {
  const adapterId = env('AI_ADAPTER_ID', 'vigilone-vlm')!;
  let loaded: LoadedVlmPipeline | null = null;
  let failure: string | undefined;
  try {
    loaded = await loadVlmPipeline();
    log('info', 'VLM pipeline loaded', { pipeline: `${loaded.definition.name}@${loaded.definition.version}`, sha256: loaded.definitionSha256, llamaServer: loaded.runtime.buildInfo });
  } catch (e: any) {
    failure = e.message;
    log('error', 'VLM pipeline refused', { error: e.message });
  }
  const core = new VlmAdapterCore(loaded, { adapterId, adapterVersion: '1.0.0-phase5', failure });
  const server = createAdapterServer(core, { maxBodyBytes: 16 * 1024 * 1024 });
  const host = env('AI_ADAPTER_HOST', '127.0.0.1')!;
  const port = Number(env('AI_ADAPTER_PORT', '7014'));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as any).port as number;
  log('info', 'ai-adapter.v1 (vlm) listening', { host, port: boundPort, mode });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await loaded?.close();
  };
  if (!loaded) {
    if (env('AI_EXIT_ON_REFUSAL', 'true') === 'true') {
      await close();
      process.exit(EXIT_MODEL_REFUSED);
    }
    return { worker: null as any, close, port: boundPort };
  }
  if (mode === 'vlm-adapter-only') return { worker: null as any, close, port: boundPort };

  if (!env('INTERNAL_API_SECRET')) throw new Error('INTERNAL_API_SECRET is required in vlm mode');
  const api = new ApiClient({ baseUrl: env('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4000/api/v1/internal')!, internalSecret: env('INTERNAL_API_SECRET')! });
  const l = loaded;
  const approvals = l.components.map((c) => c.approval!).filter(Boolean);
  const registered = await api.registerPipelineManifest({
    name: l.definition.name,
    version: l.definition.version,
    sha256: l.definitionSha256,
    task: 'vlm_verification',
    codeLicense: 'MIT AND Apache-2.0',
    weightLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
    weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
    trainingData: {
      source: l.components.map((c) => `${c.role}: ${c.entry.trainingData.source}`).join('; '),
      license: 'HUMAN-APPROVED EXCEPTION',
      provenance: approvals.map((a) => `${a.key} approved by ${a.approvedBy} on ${a.approvedAt}: ${a.reason}`).join('; '),
      commercialUse: true,
    },
    runtimeConfig: { runtime: 'llama.cpp', runtimeVersion: `${l.definition.llamaCpp.tag} (${l.definition.llamaCpp.commit})`, executionProvider: 'cpu', inputWidth: 384, inputHeight: 384, colorSpace: 'RGB', modelFormat: 'GGUF' },
    modelSignature: { decoder: 'vlm_pipeline', components: l.definition.components, targetClasses: l.definition.targetClasses, promptTemplate: l.definition.prompt.templateVersion },
    classes: Object.fromEntries(l.definition.targetClasses.map((c, i) => [String(i), c])),
  });
  core.setModelId(registered.id);
  log('info', 'VLM pipeline registered', { modelId: registered.id });
  return { worker: null as any, close, port: boundPort };
}

/**
 * Plain-language search (query rewrite): Qwen3-4B behind POST /v1/rewrite-text. A candidate model: without a human
 * approval for its SHA-256 the service refuses to start (LICENSE_REJECTED) and serves FAILED health.
 */
async function bootQueryRewrite(mode: 'query-rewrite' | 'query-rewrite-adapter-only'): Promise<BootResult> {
  const adapterId = env('AI_ADAPTER_ID', 'vigilone-query-rewrite')!;
  let loaded: LoadedQueryRewritePipeline | null = null;
  let failure: string | undefined;
  try {
    loaded = await loadQueryRewritePipeline();
    log('info', 'query rewrite pipeline loaded', { pipeline: `${loaded.definition.name}@${loaded.definition.version}`, sha256: loaded.definitionSha256, llamaServer: loaded.runtime.buildInfo });
  } catch (e: any) {
    failure = e.message;
    log('error', 'query rewrite pipeline refused', { error: e.message });
  }
  const core = new QueryRewriteAdapterCore(loaded, { adapterId, adapterVersion: '1.0.0-nl-search', failure });
  const server = createAdapterServer(core, { maxBodyBytes: 64 * 1024 });
  const host = env('AI_ADAPTER_HOST', '127.0.0.1')!;
  const port = Number(env('AI_ADAPTER_PORT', '7015'));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as any).port as number;
  log('info', 'ai-adapter.v1 (query_rewrite) listening', { host, port: boundPort, mode });
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await loaded?.close();
  };
  if (!loaded) {
    if (env('AI_EXIT_ON_REFUSAL', 'true') === 'true') {
      await close();
      process.exit(EXIT_MODEL_REFUSED);
    }
    return { worker: null as any, close, port: boundPort };
  }
  if (mode === 'query-rewrite-adapter-only') return { worker: null as any, close, port: boundPort };

  if (!env('INTERNAL_API_SECRET')) throw new Error('INTERNAL_API_SECRET is required in query-rewrite mode');
  const api = new ApiClient({ baseUrl: env('BACKEND_INTERNAL_URL', 'http://127.0.0.1:4000/api/v1/internal')!, internalSecret: env('INTERNAL_API_SECRET')! });
  const l = loaded;
  const approvals = l.components.map((c) => c.approval!).filter(Boolean);
  const registered = await api.registerPipelineManifest({
    name: l.definition.name,
    version: l.definition.version,
    sha256: l.definitionSha256,
    task: 'query_rewrite',
    codeLicense: 'MIT AND Apache-2.0',
    weightLicense: [...new Set(l.components.map((c) => c.entry.weightLicense))].join(' AND '),
    weightsSource: l.components.map((c) => `${c.role}: ${c.entry.weightsSource}`).join('; '),
    trainingData: {
      source: l.components.map((c) => `${c.role}: ${c.entry.trainingData.source}`).join('; '),
      license: 'HUMAN-APPROVED EXCEPTION',
      provenance: approvals.map((a) => `${a.key} approved by ${a.approvedBy} on ${a.approvedAt}: ${a.reason}`).join('; '),
      commercialUse: true,
    },
    runtimeConfig: { runtime: 'llama.cpp', runtimeVersion: `${l.definition.llamaCpp.tag} (${l.definition.llamaCpp.commit})`, executionProvider: 'cpu', inputWidth: 1, inputHeight: 1, colorSpace: 'RGB', modelFormat: 'GGUF' },
    modelSignature: { decoder: 'query_rewrite_pipeline', components: l.definition.components, promptTemplate: l.definition.prompt.templateVersion },
    classes: { '0': 'text' },
  });
  core.setModelId(registered.id);
  log('info', 'query rewrite pipeline registered', { modelId: registered.id });
  return { worker: null as any, close, port: boundPort };
}
