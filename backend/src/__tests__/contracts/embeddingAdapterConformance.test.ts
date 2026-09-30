/**
 * The ai-worker's real EmbeddingAdapterCore, with a stand-in pipeline (SYNTHETIC vectors, no model), must
 * produce messages that validate against the authoritative zod schemas of ai-adapter.v1 / v1.1, and it
 * must accept exactly what TextEmbeddingRequestV1 allows.
 */
import { EmbeddingAdapterCore } from '../../../../services/ai-worker/src/embedding/embeddingAdapterCore';
import { EMBEDDING_DIM } from '../../../../services/ai-worker/src/embedding/embeddingPipeline';
import { AdapterDescriptorV1, AdapterHealthV1, InferenceResultV1, TextEmbeddingRequestV1 } from '../../contracts/aiAdapter.v1';

const entry = (role: string) => ({ role, entry: { key: role, name: `siglip2-${role}`, version: 'v', sha256: 'b'.repeat(64), codeLicense: 'Apache-2.0', weightLicense: 'Apache-2.0', weightsSource: 'test' }, approval: null });
const pipeline: any = {
  definition: { name: 'siglip2-base-p16-224', version: '1.0.0', tasks: ['embedding'], components: [], dim: EMBEDDING_DIM, text: { maxTokens: 64, lowercase: true, padTokenId: 0 } },
  definitionSha256: 'a'.repeat(64),
  components: [entry('image_encoder'), entry('text_encoder')],
  embedImage: async () => Float32Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.cos(i)),
  embedText: async () => Float32Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i)),
  tokenize: () => [],
};
const core = new EmbeddingAdapterCore(pipeline, { adapterId: 'vigilone-embedding', adapterVersion: 'test' });
const textReq = { contract: 'ai-adapter.v1', requestId: 'q1', tenantId: 't', modelId: 'siglip2-base-p16-224@1.0.0', text: 'white van', deadlineMs: 5000 };

describe('embedding adapter conforms to ai-adapter.v1.1', () => {
  it('descriptor and health validate', () => {
    expect(AdapterDescriptorV1.safeParse(core.describe()).success).toBe(true);
    expect(AdapterHealthV1.safeParse(core.health()).success).toBe(true);
    const failed = new EmbeddingAdapterCore(null, { adapterId: 'e', adapterVersion: 't', failure: 'LICENSE_REJECTED: x' });
    expect(AdapterHealthV1.safeParse(failed.health()).success).toBe(true);
    expect(AdapterDescriptorV1.safeParse(failed.describe()).success).toBe(true);
  });

  it('a text result validates and carries a 768-dim float32 vector', async () => {
    expect(TextEmbeddingRequestV1.safeParse(textReq).success).toBe(true);
    const r = await core.handleTextEmbedRequest(textReq);
    const p = InferenceResultV1.safeParse(r);
    expect(p.success).toBe(true);
    if (p.success && p.data.status === 'ok') {
      expect(p.data.embedding!.dim).toBe(EMBEDDING_DIM);
      expect(Buffer.from(p.data.embedding!.vector, 'base64').length).toBe(EMBEDDING_DIM * 4);
    }
  });

  it('an image result and error results validate', async () => {
    const ok = await core.handleInferRequest({ contract: 'ai-adapter.v1', requestId: 'i1', tenantId: 't', task: 'embedding', modelId: 'siglip2-base-p16-224@1.0.0', deadlineMs: 5000, frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 0, timestampUtc: '2026-09-30T10:00:00.000Z', width: 2, height: 2, format: 'rgb24', data: { kind: 'inline_base64', value: Buffer.alloc(12).toString('base64') } } });
    expect(InferenceResultV1.safeParse(ok).success).toBe(true);
    expect(InferenceResultV1.safeParse(await core.handleTextEmbedRequest({ ...textReq, text: '' })).success).toBe(true);
    expect(InferenceResultV1.safeParse(await core.handleTextEmbedRequest(null)).success).toBe(true);
  });

  it('the adapter and the schema agree on which text requests are valid', async () => {
    for (const text of ['', ' ', 'a', 'x'.repeat(512), 'x'.repeat(513)]) {
      const schemaOk = TextEmbeddingRequestV1.safeParse({ ...textReq, text }).success && text.trim().length > 0;
      const adapterOk = (await core.handleTextEmbedRequest({ ...textReq, text })).status === 'ok';
      expect([text.length, adapterOk]).toEqual([text.length, schemaOk]);
    }
  });
});
