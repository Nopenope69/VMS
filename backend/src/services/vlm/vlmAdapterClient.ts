/**
 * Client for the VLM second-opinion adapter (ai-adapter.v1.1, task `vlm_verification`).
 *
 * Trusts nothing, like the embedding client: health must be READY, the descriptor must declare the task,
 * the model it serves must be registered here as an ACTIVE vlm_verification model with the same name,
 * version and SHA-256, every answer must match the contract, name the same model in its provenance, and
 * answer the class that was asked. Anything else throws a VlmError and nothing is stored.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AdapterDescriptorV1, AdapterHealthV1, InferenceResultV1 } from '../../contracts/aiAdapter.v1';
import { jpegSize } from '../search/embeddingAdapterClient';

export const VLM_TASK = 'vlm_verification';

export type VlmErrorCode = 'VLM_ADAPTER_UNAVAILABLE' | 'VLM_ADAPTER_INVALID' | 'VLM_MODEL_NOT_REGISTERED' | 'VLM_BAD_INPUT';

export class VlmError extends Error {
  constructor(public readonly code: VlmErrorCode, message: string) {
    super(message);
    this.name = 'VlmError';
  }
}

export interface VlmModelRef {
  name: string;
  version: string;
  sha256: string;
}

export interface VlmResult {
  answer: 'yes' | 'no' | 'unclear';
  reason: string;
  promptSha256: string;
  model: VlmModelRef;
  adapterId: string;
  inferenceId: string;
  provenance: unknown;
  latencyMs: number;
}

export class VlmAdapterClient {
  private modelId: string | null = null;
  private model: VlmModelRef | null = null;
  private adapterId: string | null = null;
  private classes: string[] = [];

  constructor(private readonly prisma: PrismaClient, private readonly baseUrl: string, private readonly timeoutMs = 60000) {}

  get servedModel(): VlmModelRef | null {
    return this.model;
  }

  /** The object classes the served model can be asked about. */
  get targetClasses(): readonly string[] {
    return this.classes;
  }

  private async getJson(path: string): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(10000) });
    } catch (e: any) {
      throw new VlmError('VLM_ADAPTER_UNAVAILABLE', `VLM adapter at ${this.baseUrl} is unreachable: ${e.message}`);
    }
    if (!r.ok && path !== '/v1/health') throw new VlmError('VLM_ADAPTER_UNAVAILABLE', `GET ${path} returned HTTP ${r.status}`);
    return r.json();
  }

  /** Checks health, descriptor and the model registry. Call again after an error to re-verify. */
  async connect(): Promise<VlmModelRef> {
    const health = AdapterHealthV1.safeParse(await this.getJson('/v1/health'));
    if (!health.success) throw new VlmError('VLM_ADAPTER_INVALID', `health does not match ai-adapter.v1: ${health.error.issues[0].message}`);
    if (health.data.status !== 'READY') throw new VlmError('VLM_ADAPTER_UNAVAILABLE', `VLM adapter is ${health.data.status}: ${health.data.lastError ?? 'no detail'}`);
    const desc = AdapterDescriptorV1.safeParse(await this.getJson('/v1/descriptor'));
    if (!desc.success) throw new VlmError('VLM_ADAPTER_INVALID', `descriptor does not match ai-adapter.v1: ${desc.error.issues[0].message}`);
    const card = desc.data.models.find((m) => m.task === VLM_TASK);
    if (!desc.data.tasks.includes(VLM_TASK) || !card) throw new VlmError('VLM_ADAPTER_UNAVAILABLE', `adapter ${desc.data.adapterId} does not serve ${VLM_TASK}`);
    const registered = await this.prisma.modelManifest.findFirst({
      where: { name: card.name, version: card.version, sha256: card.sha256, task: VLM_TASK, isActive: true },
      select: { id: true },
    });
    if (!registered) throw new VlmError('VLM_MODEL_NOT_REGISTERED', `the adapter serves ${card.name}@${card.version} (SHA-256 ${card.sha256}), which is not a registered active ${VLM_TASK} model here`);
    this.modelId = card.modelId;
    this.adapterId = desc.data.adapterId;
    this.model = { name: card.name, version: card.version, sha256: card.sha256 };
    this.classes = card.classes;
    return this.model;
  }

  /** Asks whether `targetClass` is visible in the JPEG. Throws VlmError on any failure. */
  async verify(jpeg: Buffer, targetClass: string, frameTimestampUtc: string): Promise<VlmResult> {
    if (!this.modelId || !this.model || !this.adapterId) throw new Error('connect() first');
    if (!this.classes.includes(targetClass)) throw new VlmError('VLM_BAD_INPUT', `the model does not check '${targetClass}'`);
    let size: { width: number; height: number };
    try {
      size = jpegSize(jpeg);
    } catch (e: any) {
      throw new VlmError('VLM_BAD_INPUT', e.message);
    }
    const body = {
      contract: 'ai-adapter.v1',
      requestId: crypto.randomUUID(),
      tenantId: 'vlm',
      task: VLM_TASK,
      modelId: this.modelId,
      deadlineMs: this.timeoutMs,
      vlmQuery: { targetClass },
      frame: { cameraId: 'alarm', streamSessionId: 'alarm', sequenceNumber: 0, timestampUtc: frameTimestampUtc, width: size.width, height: size.height, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg.toString('base64') } },
    };
    let json: unknown;
    try {
      const r = await fetch(`${this.baseUrl}/v1/infer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs + 5000) });
      json = await r.json();
    } catch (e: any) {
      throw new VlmError('VLM_ADAPTER_UNAVAILABLE', `VLM request failed: ${e.message}`);
    }
    const parsed = InferenceResultV1.safeParse(json);
    if (!parsed.success) throw new VlmError('VLM_ADAPTER_INVALID', `result does not match ai-adapter.v1: ${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    const res = parsed.data;
    if (res.requestId !== body.requestId) throw new VlmError('VLM_ADAPTER_INVALID', 'result answers a different request');
    if (res.status === 'error') throw new VlmError('VLM_ADAPTER_UNAVAILABLE', `adapter reported ${res.errorCode}: ${res.message}`);
    const p = res.provenance;
    if (p.modelSha256 !== this.model.sha256 || p.modelName !== this.model.name || p.modelVersion !== this.model.version) {
      throw new VlmError('VLM_ADAPTER_INVALID', `result names model ${p.modelName}@${p.modelVersion} (${p.modelSha256}), not the verified ${this.model.name}@${this.model.version}`);
    }
    const v = res.verification;
    if (!v) throw new VlmError('VLM_ADAPTER_INVALID', 'an ok result carries no verification');
    if (v.targetClass !== targetClass) throw new VlmError('VLM_ADAPTER_INVALID', `the answer is about '${v.targetClass}', not '${targetClass}'`);
    return { answer: v.answer, reason: v.reason, promptSha256: v.promptSha256, model: this.model, adapterId: this.adapterId, inferenceId: p.inferenceId, provenance: p, latencyMs: Math.round(res.latencyMs) };
  }
}
