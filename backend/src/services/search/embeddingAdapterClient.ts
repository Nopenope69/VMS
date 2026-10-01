/**
 * Client for an embedding adapter (ai-adapter.v1.1, task `embedding`), used by the crop embedder and search.
 *
 * The contract checks (health READY, task served, model registered as an ACTIVE embedding model with the same
 * name, version and SHA-256, results validated and naming that model) are AiAdapterClient's. This module adds
 * the embedding check: the vector must decode to exactly EMBEDDING_DIM finite floats. Anything else throws an
 * EmbeddingError and no embedding is stored. The same rules apply to text embedding (embedText).
 */
import { PrismaClient } from '@prisma/client';
import { AiAdapterClient, OkResult, jpegDimensions } from '../ai/aiAdapterClient';
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
  const size = jpegDimensions(b);
  if (!size) throw new EmbeddingError('EMBEDDING_INVALID', 'JPEG has no start-of-frame marker');
  return size;
}

const CODES = { unavailable: 'EMBEDDING_ADAPTER_UNAVAILABLE', invalid: 'EMBEDDING_ADAPTER_INVALID', unregistered: 'EMBEDDING_MODEL_NOT_REGISTERED' } as const;

export class EmbeddingAdapterClient {
  private modelId: string | null = null;
  private model: EmbeddingModelRef | null = null;
  private adapterId: string | null = null;
  private readonly adapter: AiAdapterClient;

  constructor(private readonly prisma: PrismaClient, baseUrl: string, private readonly timeoutMs = 20000) {
    this.adapter = new AiAdapterClient(baseUrl, { name: 'embedding adapter', timeoutMs, fail: (kind, m) => new EmbeddingError(CODES[kind], m) });
  }

  /** The model this client verified on connect(), or null before that. */
  get servedModel(): EmbeddingModelRef | null {
    return this.model;
  }

  /** Checks health, descriptor and the model registry. Call again after an error to re-verify. */
  async connect(): Promise<EmbeddingModelRef> {
    const desc = await this.adapter.probe([EMBEDDING_TASK]);
    const card = await this.adapter.registeredCard(this.prisma, desc, EMBEDDING_TASK);
    this.modelId = card.modelId;
    this.adapterId = desc.adapterId;
    this.model = { name: card.name, version: card.version, sha256: card.sha256 };
    return this.model;
  }

  /** Embeds one JPEG crop. Throws EmbeddingError on any failure; never returns an unverified vector. */
  async embed(jpeg: Buffer, capturedAtUtc: string, seq = 0): Promise<EmbeddingResult> {
    if (!this.modelId || !this.model || !this.adapterId) throw new Error('connect() first');
    const size = jpegSize(jpeg);
    const res = await this.adapter.call(
      '/v1/infer',
      { tenantId: 'embedding', task: EMBEDDING_TASK, modelId: this.modelId, deadlineMs: this.timeoutMs, frame: AiAdapterClient.jpegFrame(jpeg, size, { cameraId: 'crop', timestampUtc: capturedAtUtc, sequenceNumber: seq }) },
      this.model
    );
    return this.vectorOf(res);
  }

  /**
   * Embeds search text with the same model that embeds crops (ai-adapter.v1.1 POST /v1/embed-text), so the
   * vector can be compared with stored crop embeddings. Same checks as embed().
   */
  async embedText(text: string): Promise<EmbeddingResult> {
    if (!this.modelId || !this.model || !this.adapterId) throw new Error('connect() first');
    const res = await this.adapter.call('/v1/embed-text', { tenantId: 'embedding', modelId: this.modelId, text, deadlineMs: this.timeoutMs }, this.model);
    return this.vectorOf(res);
  }

  private vectorOf(res: OkResult): EmbeddingResult {
    if (!res.embedding) throw new EmbeddingError('EMBEDDING_ADAPTER_INVALID', 'an ok embedding result carries no embedding');
    if (res.embedding.dim !== EMBEDDING_DIM) throw new EmbeddingError('EMBEDDING_INVALID', `the adapter returned ${res.embedding.dim} dimensions; this appliance stores ${EMBEDDING_DIM}`);
    const raw = decodeFloat32Base64(res.embedding.vector);
    if (raw.length !== res.embedding.dim) throw new EmbeddingError('EMBEDDING_INVALID', `the vector decodes to ${raw.length} components, the result says ${res.embedding.dim}`);
    return { vector: normalizeVector(raw), model: this.model!, adapterId: this.adapterId!, inferenceId: res.provenance.inferenceId };
  }
}
