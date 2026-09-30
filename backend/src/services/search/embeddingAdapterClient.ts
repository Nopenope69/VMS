/**
 * Client for an embedding adapter (ai-adapter.v1.1, task `embedding`), used by the crop embedder.
 *
 * Like the redaction client, it trusts nothing: health must be READY, the descriptor must declare the
 * `embedding` task, the model it serves must be registered here as an ACTIVE embedding model with the
 * same name, version and SHA-256, every response must match the contract, its provenance must name that
 * same model, and the vector must decode to exactly EMBEDDING_DIM finite floats. Anything else throws an
 * EmbeddingError and no embedding is stored. The same rules apply to text embedding (embedText).
 */
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { AdapterDescriptorV1, AdapterHealthV1, InferenceResultV1 } from '../../contracts/aiAdapter.v1';
import { decodeFloat32Base64, EMBEDDING_DIM, EMBEDDING_TASK, EmbeddingError, EmbeddingModelRef, normalizeVector } from './cropEmbeddingStore';

export interface EmbeddingResult {
  vector: Float32Array;
  model: EmbeddingModelRef;
  adapterId: string;
  inferenceId: string;
}

/** Width and height of a JPEG from its start-of-frame marker; throws if there is none. */
export function jpegSize(b: Buffer): { width: number; height: number } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new EmbeddingError('EMBEDDING_INVALID', 'not a JPEG');
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
  throw new EmbeddingError('EMBEDDING_INVALID', 'JPEG has no start-of-frame marker');
}

export class EmbeddingAdapterClient {
  private modelId: string | null = null;
  private model: EmbeddingModelRef | null = null;
  private adapterId: string | null = null;

  constructor(private readonly prisma: PrismaClient, private readonly baseUrl: string, private readonly timeoutMs = 20000) {}

  /** The model this client verified on connect(), or null before that. */
  get servedModel(): EmbeddingModelRef | null {
    return this.model;
  }

  private async getJson(path: string): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e: any) {
      throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', `embedding adapter at ${this.baseUrl} is unreachable: ${e.message}`);
    }
    if (!r.ok) throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', `GET ${path} returned HTTP ${r.status}`);
    return r.json();
  }

  /** Checks health, descriptor and the model registry. Call again after an error to re-verify. */
  async connect(): Promise<EmbeddingModelRef> {
    const health = AdapterHealthV1.safeParse(await this.getJson('/v1/health'));
    if (!health.success) throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', `health does not match ai-adapter.v1: ${health.error.issues[0].message}`);
    if (health.data.status !== 'READY') throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', `embedding adapter is ${health.data.status}: ${health.data.lastError ?? 'no detail'}`);
    const desc = AdapterDescriptorV1.safeParse(await this.getJson('/v1/descriptor'));
    if (!desc.success) throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', `descriptor does not match ai-adapter.v1: ${desc.error.issues[0].message}`);
    if (!desc.data.tasks.includes(EMBEDDING_TASK)) throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', `adapter ${desc.data.adapterId} does not serve the embedding task`);
    const card = desc.data.models.find((m) => m.task === EMBEDDING_TASK);
    if (!card) throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', 'adapter has no embedding model loaded');
    const registered = await this.prisma.modelManifest.findFirst({
      where: { name: card.name, version: card.version, sha256: card.sha256, task: EMBEDDING_TASK, isActive: true },
      select: { id: true },
    });
    if (!registered) {
      throw new EmbeddingError('EMBEDDING_MODEL_NOT_REGISTERED', `the adapter serves ${card.name}@${card.version} (SHA-256 ${card.sha256}), which is not a registered active embedding model here`);
    }
    this.modelId = card.modelId;
    this.adapterId = desc.data.adapterId;
    this.model = { name: card.name, version: card.version, sha256: card.sha256 };
    return this.model;
  }

  /** Embeds one JPEG crop. Throws EmbeddingError on any failure; never returns an unverified vector. */
  async embed(jpeg: Buffer, capturedAtUtc: string, seq = 0): Promise<EmbeddingResult> {
    if (!this.modelId || !this.model || !this.adapterId) throw new Error('connect() first');
    const { width, height } = jpegSize(jpeg);
    const body = {
      contract: 'ai-adapter.v1',
      requestId: crypto.randomUUID(),
      tenantId: 'embedding',
      task: EMBEDDING_TASK,
      modelId: this.modelId,
      deadlineMs: this.timeoutMs,
      frame: { cameraId: 'crop', streamSessionId: 'crop', sequenceNumber: seq, timestampUtc: capturedAtUtc, width, height, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg.toString('base64') } },
    };
    return this.post('/v1/infer', body);
  }

  /**
   * Embeds search text with the same model that embeds crops (ai-adapter.v1.1 POST /v1/embed-text), so the
   * vector can be compared with stored crop embeddings. Same checks as embed().
   */
  async embedText(text: string): Promise<EmbeddingResult> {
    if (!this.modelId || !this.model || !this.adapterId) throw new Error('connect() first');
    const body = { contract: 'ai-adapter.v1', requestId: crypto.randomUUID(), tenantId: 'embedding', modelId: this.modelId, text, deadlineMs: this.timeoutMs };
    return this.post('/v1/embed-text', body);
  }

  private async post(path: string, body: { requestId: string }): Promise<EmbeddingResult> {
    let json: unknown;
    try {
      const r = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs + 5000) });
      json = await r.json();
    } catch (e: any) {
      throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', `embedding request failed: ${e.message}`);
    }
    const parsed = InferenceResultV1.safeParse(json);
    if (!parsed.success) throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', `result does not match ai-adapter.v1: ${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    const res = parsed.data;
    if (res.requestId !== body.requestId) throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', 'result answers a different request');
    if (res.status === 'error') throw new EmbeddingError('EMBEDDING_ADAPTER_UNAVAILABLE', `adapter reported ${res.errorCode}: ${res.message}`);
    const model = this.model!;
    const p = res.provenance;
    if (p.modelSha256 !== model.sha256 || p.modelName !== model.name || p.modelVersion !== model.version) {
      throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', `result names model ${p.modelName}@${p.modelVersion} (${p.modelSha256}), not the verified ${model.name}@${model.version}`);
    }
    if (!res.embedding) throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', 'an ok embedding result carries no embedding');
    if (res.embedding.dim !== EMBEDDING_DIM) throw new EmbeddingError('EMBEDDING_INVALID', `the adapter returned ${res.embedding.dim} dimensions; this appliance stores ${EMBEDDING_DIM}`);
    const raw = decodeFloat32Base64(res.embedding.vector);
    if (raw.length !== res.embedding.dim) throw new EmbeddingError('EMBEDDING_INVALID', `the vector decodes to ${raw.length} components, the result says ${res.embedding.dim}`);
    return { vector: normalizeVector(raw), model, adapterId: this.adapterId!, inferenceId: p.inferenceId };
  }
}
