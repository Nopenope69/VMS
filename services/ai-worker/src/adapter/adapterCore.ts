import crypto from 'crypto';
import { spawn } from 'child_process';
import { IInferenceEngine } from '../inferenceEngine';
import { CoordinateTransformer } from '../coordinateTransformer';
import { FrameGeometry, ModelManifestRecord, RawDetection } from '../types';
import { VIGILONE_V1_CLASSES, toVigilOneClass } from '../classMap';
import { LATENCY_BUCKETS_MS, MetricsRegistry } from '../metrics';
import { letterboxInto } from './letterbox';
import {
  AI_ADAPTER_CONTRACT,
  AdapterDescriptorV1,
  AdapterErrorCode,
  AdapterHealthV1,
  AiProvenanceV1,
  DetectionV1,
  InferenceRequestV1,
  InferenceResultV1,
  ModelCardV1,
  RETRYABLE,
} from './contract';

export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

export interface AdapterCoreOptions {
  adapterId: string;
  adapterVersion: string;
  /** Concurrent inferences (default 2). */
  maxInFlight?: number;
  /** Requests allowed to wait for a slot before OVERLOADED is returned (default 4). */
  maxQueued?: number;
}

export interface LoadedModelInfo {
  manifest: ModelManifestRecord;
  evaluation?: ModelCardV1['evaluation'];
}

export interface DetectResult {
  detections: Array<RawDetection & { objectClass: string }>;
  provenance: AiProvenanceV1;
  latencyMs: number;
}

const MAX_DEADLINE_MS = 60000;

/**
 * The single inference path of the ai-worker, speaking ai-adapter.v1. Both the HTTP adapter
 * (/v1/infer) and the camera stream pipeline call it, so every detection carries the same
 * provenance and goes through the same backpressure and deadline rules.
 *
 *  - no success without provenance: a result names the model id/name/version/SHA-256, runtime,
 *    execution provider and a fresh inference id;
 *  - only VigilOne v1 classes (person, bicycle, motorcycle, car, bus, truck) are returned;
 *  - bounded concurrency: beyond maxInFlight running and maxQueued waiting, OVERLOADED;
 *  - deadlines: DEADLINE_EXCEEDED if the result is not ready in time. A late ONNX run cannot be
 *    cancelled, so it keeps its slot until it finishes (the slot count stays honest), and a
 *    result that completes after the deadline is discarded.
 */
export class AiAdapterCore {
  private model: LoadedModelInfo | null = null;
  private state: AdapterHealthV1['status'] = 'LOADING';
  private lastError: string | null = null;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private readonly maxInFlight: number;
  private readonly maxQueued: number;

  constructor(
    private readonly engine: IInferenceEngine,
    private readonly opts: AdapterCoreOptions,
    public readonly metrics: MetricsRegistry = new MetricsRegistry()
  ) {
    this.maxInFlight = Math.max(1, opts.maxInFlight ?? 2);
    this.maxQueued = Math.max(0, opts.maxQueued ?? 4);
    this.metrics.set('vigilone_ai_adapter_ready', 'Adapter READY (1) or not (0)', undefined, 0);
  }

  public get adapterId(): string {
    return this.opts.adapterId;
  }

  public get adapterVersion(): string {
    return this.opts.adapterVersion;
  }

  /** Called after the engine has loaded and verified the model. */
  public setModel(info: LoadedModelInfo): void {
    this.model = info;
    this.state = 'READY';
    this.lastError = null;
    this.metrics.set('vigilone_ai_adapter_ready', 'Adapter READY (1) or not (0)', undefined, 1);
  }

  /** Marks the adapter FAILED (e.g. SHA mismatch, licence rejected, runtime missing). */
  public fail(reason: string): void {
    this.model = null;
    this.state = 'FAILED';
    this.lastError = reason;
    this.metrics.set('vigilone_ai_adapter_ready', 'Adapter READY (1) or not (0)', undefined, 0);
  }

  public getModel(): LoadedModelInfo | null {
    return this.model;
  }

  public modelCard(): ModelCardV1 | null {
    if (!this.model) return null;
    const m = this.model.manifest;
    const rc = m.runtimeConfigJson;
    return {
      modelId: m.id,
      name: m.name,
      version: m.version,
      sha256: m.sha256.toLowerCase(),
      task: 'object_detection',
      classes: [...VIGILONE_V1_CLASSES],
      codeLicense: m.codeLicense,
      weightsLicense: m.weightLicense,
      weightsSource: m.weightsSource || 'not recorded',
      runtime: (rc.runtime || '').toLowerCase() === 'openvino' ? 'openvino' : 'onnxruntime',
      input: {
        width: rc.inputWidth,
        height: rc.inputHeight,
        colorSpace: (rc.colorSpace || 'RGB').toUpperCase() === 'BGR' ? 'BGR' : 'RGB',
        letterbox: rc.letterbox !== false,
      },
      evaluation: this.model.evaluation ?? null,
    };
  }

  public describe(): AdapterDescriptorV1 {
    const card = this.modelCard();
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      adapterVersion: this.opts.adapterVersion,
      tasks: ['object_detection'],
      models: card ? [card] : [],
      requiresNetworkEgress: false,
    };
  }

  public health(): AdapterHealthV1 {
    const saturated = this.inFlight >= this.maxInFlight && this.waiters.length >= this.maxQueued;
    const status = this.state === 'READY' && saturated ? 'DEGRADED' : this.state;
    return {
      contract: AI_ADAPTER_CONTRACT,
      adapterId: this.opts.adapterId,
      status,
      loadedModelIds: this.model ? [this.model.manifest.id] : [],
      lastError: this.state === 'FAILED' ? this.lastError || 'unknown failure' : this.lastError,
      observedAtUtc: new Date().toISOString(),
    };
  }

  public getLoad(): { inFlight: number; queued: number; maxInFlight: number; maxQueued: number } {
    return { inFlight: this.inFlight, queued: this.waiters.length, maxInFlight: this.maxInFlight, maxQueued: this.maxQueued };
  }

  /**
   * Runs detection on a frame that is already at the model input size (letterboxed as described
   * by `geometry`). Used by the stream pipeline and by handleInferRequest.
   */
  public async detect(
    modelInput: Buffer,
    geometry: FrameGeometry,
    frameTimestampUtc: string,
    deadlineMs: number
  ): Promise<DetectResult> {
    const model = this.model;
    if (!model || this.state === 'FAILED' || this.state === 'LOADING') {
      throw new AdapterError('MODEL_NOT_LOADED', this.lastError ? `No model loaded: ${this.lastError}` : 'No model loaded');
    }
    if (!(deadlineMs > 0) || deadlineMs > MAX_DEADLINE_MS) {
      throw new AdapterError('INVALID_FRAME', `deadlineMs must be in (0, ${MAX_DEADLINE_MS}]`);
    }

    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let acquired = false;

    const work = (async () => {
      await this.acquire(() => timedOut);
      acquired = true;
      try {
        if (timedOut) throw new AdapterError('DEADLINE_EXCEEDED', 'deadline passed while waiting for a slot');
        return await this.engine.infer(modelInput, {
          imageWidth: geometry.modelWidth,
          imageHeight: geometry.modelHeight,
          geometry,
        });
      } finally {
        this.release();
      }
    })();

    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (!acquired) this.dropWaiterFor();
        reject(new AdapterError('DEADLINE_EXCEEDED', `no result within ${deadlineMs}ms`));
      }, deadlineMs);
    });

    let raw: RawDetection[];
    try {
      raw = await Promise.race([work, deadline]);
    } catch (err: any) {
      work.catch(() => undefined); // a late result or error after the deadline is discarded
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: code });
      if (err instanceof AdapterError) throw err;
      throw new AdapterError('RUNTIME_ERROR', err?.message || String(err));
    } finally {
      if (timer) clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;
    // onnxruntime-node runs a session synchronously on the event loop (inside setImmediate), so the
    // deadline timer cannot fire mid-inference. A result that arrives late is discarded, never
    // delivered as a success.
    if (latencyMs > deadlineMs) {
      this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'DEADLINE_EXCEEDED' });
      throw new AdapterError('DEADLINE_EXCEEDED', `result ready after ${latencyMs}ms, deadline was ${deadlineMs}ms`);
    }
    this.metrics.inc('vigilone_ai_inferences_total', 'Inferences by outcome', { outcome: 'ok' });
    this.metrics.observe('vigilone_ai_inference_latency_ms', 'End-to-end detect latency (queue + inference + decode)', LATENCY_BUCKETS_MS, latencyMs);

    const detections: Array<RawDetection & { objectClass: string }> = [];
    for (const d of raw) {
      const cls = toVigilOneClass(d.label);
      if (!cls) {
        this.metrics.inc('vigilone_ai_detections_dropped_total', 'Detections dropped before tracking', { reason: 'class_not_in_v1' });
        continue;
      }
      detections.push({ ...d, objectClass: cls });
    }

    const rt = this.engine.getRuntimeInfo?.();
    const rc = model.manifest.runtimeConfigJson;
    const provenance: AiProvenanceV1 = {
      adapterId: this.opts.adapterId,
      adapterVersion: this.opts.adapterVersion,
      modelId: model.manifest.id,
      modelName: model.manifest.name,
      modelVersion: model.manifest.version,
      modelSha256: model.manifest.sha256.toLowerCase(),
      runtime: rt ? (rt.runtimeVersion ? `${rt.runtime}@${rt.runtimeVersion}` : rt.runtime) : rc.runtime,
      inferenceId: crypto.randomUUID(),
      frameTimestampUtc,
    };
    const ep = rt?.executionProvider ?? rc.executionProvider;
    if (ep) provenance.executionProvider = ep;
    return { detections, provenance, latencyMs };
  }

  /** ai-adapter.v1 POST /v1/infer. Never throws: every failure becomes an error result. */
  public async handleInferRequest(body: unknown): Promise<InferenceResultV1> {
    const requestId =
      body && typeof (body as any).requestId === 'string' && (body as any).requestId.length > 0
        ? (body as any).requestId.slice(0, 200)
        : 'unidentified-request';
    try {
      const req = validateRequest(body);
      const model = this.model;
      if (!model) throw new AdapterError('MODEL_NOT_LOADED', this.lastError ? `No model loaded: ${this.lastError}` : 'No model loaded');
      if (req.task !== 'object_detection') {
        throw new AdapterError('UNSUPPORTED_TASK', `task '${req.task}' is not served by this adapter (object_detection only)`);
      }
      if (req.modelId !== model.manifest.id) {
        throw new AdapterError('MODEL_NOT_LOADED', `model '${req.modelId}' is not loaded (loaded: ${model.manifest.id})`);
      }
      const { input, geometry } = await this.frameToModelInput(req, model.manifest);
      const r = await this.detect(input, geometry, req.frame.timestampUtc, req.deadlineMs);
      const detections: DetectionV1[] = r.detections.map((d) => ({
        objectClass: d.objectClass,
        classId: d.classId,
        confidence: d.confidence,
        bbox: d.box,
      }));
      return { contract: AI_ADAPTER_CONTRACT, status: 'ok', requestId: req.requestId, detections, provenance: r.provenance, latencyMs: r.latencyMs };
    } catch (err: any) {
      const code: AdapterErrorCode = err instanceof AdapterError ? err.code : 'RUNTIME_ERROR';
      return {
        contract: AI_ADAPTER_CONTRACT,
        status: 'error',
        requestId,
        errorCode: code,
        message: (err?.message || 'inference failed').slice(0, 2000),
        retryable: RETRYABLE[code],
      };
    }
  }

  private async frameToModelInput(
    req: InferenceRequestV1,
    manifest: ModelManifestRecord
  ): Promise<{ input: Buffer; geometry: FrameGeometry }> {
    const f = req.frame;
    if (f.data.kind !== 'inline_base64') {
      throw new AdapterError('INVALID_FRAME', 'shared_memory frames are not supported by this adapter; send inline_base64');
    }
    const bytes = Buffer.from(f.data.value, 'base64');
    let rgb: Buffer;
    let swap = false;
    if (f.format === 'jpeg') {
      rgb = await decodeJpeg(bytes, f.width, f.height);
    } else {
      if (bytes.length !== f.width * f.height * 3) {
        throw new AdapterError('INVALID_FRAME', `frame data is ${bytes.length} bytes, expected ${f.width * f.height * 3} for ${f.width}x${f.height} ${f.format}`);
      }
      rgb = bytes;
      swap = f.format === 'bgr24';
    }
    const rc = manifest.runtimeConfigJson;
    const geometry = CoordinateTransformer.computeGeometry(
      f.width,
      f.height,
      rc.inputWidth,
      rc.inputHeight,
      rc.letterbox !== false,
      rc.padPosition ?? 'center'
    );
    return { input: letterboxInto(rgb, f.width, f.height, geometry, rc.padValue ?? 0, swap), geometry };
  }

  private acquire(isCancelled: () => boolean): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      this.publishLoad();
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueued) {
      this.metrics.inc('vigilone_ai_requests_rejected_total', 'Requests rejected by backpressure', { reason: 'overloaded' });
      return Promise.reject(new AdapterError('OVERLOADED', `adapter busy: ${this.inFlight} running, ${this.waiters.length} waiting`));
    }
    return new Promise((resolve) => {
      const w = () => {
        if (isCancelled()) return; // deadline already fired; the slot passes to the next waiter
        this.inFlight++;
        this.publishLoad();
        resolve();
      };
      (w as any).cancelled = isCancelled;
      this.waiters.push(w);
      this.publishLoad();
    });
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    while (this.waiters.length > 0 && this.inFlight < this.maxInFlight) {
      const next = this.waiters.shift()!;
      const before = this.inFlight;
      next();
      if (this.inFlight > before) break; // the waiter took the slot
    }
    this.publishLoad();
  }

  private dropWaiterFor(): void {
    // Remove waiters whose deadline has fired so they never occupy the queue.
    this.waiters = this.waiters.filter((w) => !(w as any).cancelled?.());
    this.publishLoad();
  }

  private publishLoad(): void {
    this.metrics.set('vigilone_ai_inflight', 'Inferences running', undefined, this.inFlight);
    this.metrics.set('vigilone_ai_queued', 'Requests waiting for an inference slot', undefined, this.waiters.length);
  }
}

export function validateRequest(body: unknown): InferenceRequestV1 {
  const b = body as any;
  const fail = (m: string) => {
    throw new AdapterError('INVALID_FRAME', `invalid InferenceRequestV1: ${m}`);
  };
  if (!b || typeof b !== 'object') fail('body must be a JSON object');
  if (b.contract !== AI_ADAPTER_CONTRACT) fail(`contract must be '${AI_ADAPTER_CONTRACT}'`);
  for (const k of ['requestId', 'tenantId', 'task', 'modelId']) {
    if (typeof b[k] !== 'string' || !b[k]) fail(`${k} is required`);
  }
  if (!Number.isInteger(b.deadlineMs) || b.deadlineMs <= 0 || b.deadlineMs > MAX_DEADLINE_MS) fail(`deadlineMs must be an integer in (0, ${MAX_DEADLINE_MS}]`);
  const f = b.frame;
  if (!f || typeof f !== 'object') fail('frame is required');
  if (!Number.isInteger(f.width) || f.width <= 0 || !Number.isInteger(f.height) || f.height <= 0) fail('frame width/height must be positive integers');
  if (f.width * f.height > 3840 * 2160) fail('frame larger than 3840x2160');
  if (!['rgb24', 'bgr24', 'jpeg'].includes(f.format)) fail(`unsupported frame format '${f.format}'`);
  if (typeof f.timestampUtc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(f.timestampUtc)) {
    fail('frame.timestampUtc must be an ISO-8601 UTC timestamp ending in Z');
  }
  if (typeof f.cameraId !== 'string' || !f.cameraId) fail('frame.cameraId is required');
  if (!f.data || (f.data.kind !== 'inline_base64' && f.data.kind !== 'shared_memory')) fail('frame.data.kind must be inline_base64 or shared_memory');
  if (f.data.kind === 'inline_base64' && (typeof f.data.value !== 'string' || !f.data.value)) fail('frame.data.value is required');
  return b as InferenceRequestV1;
}

export function decodeJpeg(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-f', 'image2pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => (err += c));
    p.on('error', (e) => reject(new AdapterError('RUNTIME_ERROR', `ffmpeg unavailable for JPEG decode: ${e.message}`)));
    p.on('exit', (code) => {
      const out = Buffer.concat(chunks);
      if (code !== 0) return reject(new AdapterError('INVALID_FRAME', `JPEG decode failed: ${err.trim() || `exit ${code}`}`));
      if (out.length !== width * height * 3) {
        return reject(new AdapterError('INVALID_FRAME', `JPEG decodes to ${out.length} bytes, not ${width}x${height}x3 as declared`));
      }
      resolve(out);
    });
    p.stdin.on('error', () => undefined);
    p.stdin.end(bytes);
  });
}
