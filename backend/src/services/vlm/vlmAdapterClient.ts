/**
 * Client for the VLM second-opinion adapter (ai-adapter.v1.1, task `vlm_verification`).
 *
 * The contract checks (health READY, task served, model registered as an ACTIVE vlm_verification model with
 * the same name, version and SHA-256, answers validated and naming that model) are AiAdapterClient's. This
 * module adds: the answer is about the class that was asked. Anything else throws a VlmError and nothing is
 * stored.
 */
import { PrismaClient } from '@prisma/client';
import { AiAdapterClient, jpegDimensions } from '../ai/aiAdapterClient';

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

const CODES = { unavailable: 'VLM_ADAPTER_UNAVAILABLE', invalid: 'VLM_ADAPTER_INVALID', unregistered: 'VLM_MODEL_NOT_REGISTERED' } as const;

export class VlmAdapterClient {
  private modelId: string | null = null;
  private model: VlmModelRef | null = null;
  private adapterId: string | null = null;
  private classes: string[] = [];
  private readonly adapter: AiAdapterClient;

  constructor(private readonly prisma: PrismaClient, baseUrl: string, private readonly timeoutMs = 60000) {
    this.adapter = new AiAdapterClient(baseUrl, { name: 'VLM adapter', timeoutMs, probeTimeoutMs: 10000, fail: (kind, m) => new VlmError(CODES[kind], m) });
  }

  get servedModel(): VlmModelRef | null {
    return this.model;
  }

  /** The object classes the served model can be asked about. */
  get targetClasses(): readonly string[] {
    return this.classes;
  }

  /** Checks health, descriptor and the model registry. Call again after an error to re-verify. */
  async connect(): Promise<VlmModelRef> {
    const desc = await this.adapter.probe([VLM_TASK]);
    const card = await this.adapter.registeredCard(this.prisma, desc, VLM_TASK);
    this.modelId = card.modelId;
    this.adapterId = desc.adapterId;
    this.model = { name: card.name, version: card.version, sha256: card.sha256 };
    this.classes = card.classes;
    return this.model;
  }

  /** Asks whether `targetClass` is visible in the JPEG. Throws VlmError on any failure. */
  async verify(jpeg: Buffer, targetClass: string, frameTimestampUtc: string): Promise<VlmResult> {
    if (!this.modelId || !this.model || !this.adapterId) throw new Error('connect() first');
    if (!this.classes.includes(targetClass)) throw new VlmError('VLM_BAD_INPUT', `the model does not check '${targetClass}'`);
    const size = jpegDimensions(jpeg);
    if (!size) throw new VlmError('VLM_BAD_INPUT', 'not a JPEG with a start-of-frame marker');
    const res = await this.adapter.call(
      '/v1/infer',
      { tenantId: 'vlm', task: VLM_TASK, modelId: this.modelId, deadlineMs: this.timeoutMs, vlmQuery: { targetClass }, frame: AiAdapterClient.jpegFrame(jpeg, size, { cameraId: 'alarm', timestampUtc: frameTimestampUtc }) },
      this.model
    );
    const v = res.verification;
    if (!v) throw new VlmError('VLM_ADAPTER_INVALID', 'an ok result carries no verification');
    if (v.targetClass !== targetClass) throw new VlmError('VLM_ADAPTER_INVALID', `the answer is about '${v.targetClass}', not '${targetClass}'`);
    const p = res.provenance;
    return { answer: v.answer, reason: v.reason, promptSha256: v.promptSha256, model: this.model, adapterId: this.adapterId, inferenceId: p.inferenceId, provenance: p, latencyMs: Math.round(res.latencyMs) };
  }
}
