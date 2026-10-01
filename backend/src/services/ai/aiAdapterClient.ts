/**
 * The backend's one connection to an ai-adapter.v1 adapter (embedding, redaction regions, VLM second opinion).
 *
 * It trusts nothing the adapter says:
 *   - health must match the contract and be READY;
 *   - the descriptor must match the contract and serve the tasks asked for;
 *   - a model that must be registered here must be an ACTIVE model of that task with the same name, version
 *     and SHA-256;
 *   - every result must match the contract, answer this request, and (for a verified model) name that same
 *     model in its provenance.
 *
 * Anything else throws. Each caller turns the failure kind into its own error type with `fail`, so
 * EmbeddingError, VlmError and RedactionError keep their codes and the callers' handling does not change.
 * The task-specific checks of a result (embedding dimension, VLM target class, region classes) stay with the
 * caller.
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AdapterDescriptorV1, AdapterHealthV1, InferenceResultV1 } from '../../contracts/aiAdapter.v1';

/**
 * unavailable: unreachable, not READY, task not served, or the adapter answered with an error status;
 * invalid: a response that breaks the contract; unregistered: the served model is not registered here.
 */
export type AdapterFailureKind = 'unavailable' | 'invalid' | 'unregistered';

export type AdapterDescriptor = z.infer<typeof AdapterDescriptorV1>;
export type ModelCard = AdapterDescriptor['models'][number];
export type OkResult = Extract<z.infer<typeof InferenceResultV1>, { status: 'ok' }>;
export type ErrorResult = Extract<z.infer<typeof InferenceResultV1>, { status: 'error' }>;

export interface ModelRef {
  name: string;
  version: string;
  sha256: string;
}

export interface AiAdapterClientOptions {
  /** Used in messages, e.g. 'embedding adapter'. */
  name: string;
  /** Request timeout; inference calls get 5 s more for transport. */
  timeoutMs: number;
  /** Timeout of the health and descriptor probes (default timeoutMs). */
  probeTimeoutMs?: number;
  /** Builds the caller's own error for a failure kind. */
  fail: (kind: AdapterFailureKind, message: string) => Error;
  /** Builds the error for an error-status result (default: unavailable, "adapter reported CODE: message"). */
  onErrorResult?: (res: ErrorResult) => Error;
}

export class AiAdapterClient {
  constructor(private readonly baseUrl: string, private readonly opts: AiAdapterClientOptions) {}

  get url(): string {
    return this.baseUrl;
  }

  private async getJson(path: string): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.opts.probeTimeoutMs ?? this.opts.timeoutMs) });
    } catch (e: any) {
      throw this.opts.fail('unavailable', `${this.opts.name} at ${this.baseUrl} is unreachable: ${e.message}`);
    }
    // A health answer that is not READY may come with an error status; its body still says why.
    if (!r.ok && path !== '/v1/health') throw this.opts.fail('unavailable', `GET ${path} returned HTTP ${r.status}`);
    try {
      return await r.json();
    } catch {
      throw this.opts.fail(r.ok ? 'invalid' : 'unavailable', `GET ${path} returned HTTP ${r.status} without a JSON body`);
    }
  }

  /** Health READY and a descriptor serving every task in `tasks`. Call again after an error to re-verify. */
  async probe(tasks: string[]): Promise<AdapterDescriptor> {
    const health = AdapterHealthV1.safeParse(await this.getJson('/v1/health'));
    if (!health.success) throw this.opts.fail('invalid', `health does not match ai-adapter.v1: ${health.error.issues[0].message}`);
    if (health.data.status !== 'READY') throw this.opts.fail('unavailable', `${this.opts.name} is ${health.data.status}: ${health.data.lastError ?? 'no detail'}`);
    const desc = AdapterDescriptorV1.safeParse(await this.getJson('/v1/descriptor'));
    if (!desc.success) throw this.opts.fail('invalid', `descriptor does not match ai-adapter.v1: ${desc.error.issues[0].message}`);
    for (const t of tasks) {
      if (!desc.data.tasks.includes(t as any)) throw this.opts.fail('unavailable', `adapter ${desc.data.adapterId} does not serve ${t}`);
    }
    return desc.data;
  }

  /** The descriptor's model card for `task`, which must be registered here as an active model of that task. */
  async registeredCard(prisma: PrismaClient, desc: AdapterDescriptor, task: string): Promise<ModelCard> {
    const card = desc.models.find((m) => m.task === task);
    if (!card) throw this.opts.fail('unavailable', `adapter ${desc.adapterId} has no ${task} model loaded`);
    const registered = await prisma.modelManifest.findFirst({
      where: { name: card.name, version: card.version, sha256: card.sha256, task, isActive: true },
      select: { id: true },
    });
    if (!registered) {
      throw this.opts.fail('unregistered', `the adapter serves ${card.name}@${card.version} (SHA-256 ${card.sha256}), which is not a registered active ${task} model here`);
    }
    return card;
  }

  /**
   * POSTs a request (a fresh requestId is added) and returns the validated ok result. With `model`, the result's
   * provenance must name exactly that model.
   */
  async call(path: '/v1/infer' | '/v1/embed-text', body: Record<string, unknown>, model?: ModelRef): Promise<OkResult> {
    const requestId = crypto.randomUUID();
    let json: unknown;
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contract: 'ai-adapter.v1', requestId, ...body }),
        signal: AbortSignal.timeout(this.opts.timeoutMs + 5000),
      });
      json = await r.json();
    } catch (e: any) {
      throw this.opts.fail('unavailable', `${this.opts.name} request failed: ${e.message}`);
    }
    const parsed = InferenceResultV1.safeParse(json);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw this.opts.fail('invalid', `result does not match ai-adapter.v1: ${i.path.join('.')}: ${i.message}`);
    }
    const res = parsed.data;
    if (res.requestId !== requestId) throw this.opts.fail('invalid', 'result answers a different request');
    if (res.status === 'error') {
      throw this.opts.onErrorResult ? this.opts.onErrorResult(res) : this.opts.fail('unavailable', `adapter reported ${res.errorCode}: ${res.message}`);
    }
    if (model) {
      const p = res.provenance;
      if (p.modelSha256 !== model.sha256 || p.modelName !== model.name || p.modelVersion !== model.version) {
        throw this.opts.fail('invalid', `result names model ${p.modelName}@${p.modelVersion} (${p.modelSha256}), not the verified ${model.name}@${model.version}`);
      }
    }
    return res;
  }

  /** A frame object for an inline JPEG. */
  static jpegFrame(jpeg: Buffer, size: { width: number; height: number }, f: { cameraId: string; timestampUtc: string; sequenceNumber?: number }) {
    return {
      cameraId: f.cameraId,
      streamSessionId: f.cameraId,
      sequenceNumber: f.sequenceNumber ?? 0,
      timestampUtc: f.timestampUtc,
      width: size.width,
      height: size.height,
      format: 'jpeg',
      data: { kind: 'inline_base64', value: jpeg.toString('base64') },
    };
  }
}

/** Width and height of a JPEG from its start-of-frame marker, or null if it has none. */
export function jpegDimensions(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}
