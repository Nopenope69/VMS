/**
 * Plain-language search, the model part (textllm/): the prompt, its hash, the output check and the adapter, with a
 * STAND-IN pipeline (no model). The real Qwen3-4B is in goldenQueryRewrite.test.ts.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { createAdapterServer } from '../adapter/httpServer';
import { QueryRewriteAdapterCore } from '../textllm/queryRewriteAdapterCore';
import {
  buildMessages,
  cleanVocabulary,
  loadQueryRewritePipeline,
  LoadedQueryRewritePipeline,
  parseRewrite,
  promptSha256,
  QueryRewriteDefinition,
  resolveQueryRewritePipelinePath,
} from '../textllm/queryRewritePipeline';

const def: QueryRewriteDefinition = JSON.parse(fs.readFileSync(resolveQueryRewritePipelinePath(), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../scripts/models/models.lock.json'), 'utf8'));

describe('pipeline definition', () => {
  it('pins the lock file entry, greedy decoding with thinking off, and the llama.cpp build the VLM uses', () => {
    const entry = lock.candidateModels.find((c: any) => c.key === def.components[0].key);
    expect(entry.sha256).toBe(def.components[0].sha256);
    expect(entry).toMatchObject({ weightLicense: 'Apache-2.0', governance: { status: 'PENDING_HUMAN_REVIEW' } });
    expect(def.generation).toMatchObject({ temperature: 0, thinking: false });
    const vlm = JSON.parse(fs.readFileSync(path.join(path.dirname(resolveQueryRewritePipelinePath()), 'vlm-smolvlm2-v1.json'), 'utf8'));
    expect(def.llamaCpp).toEqual(vlm.llamaCpp);
  });

  it('refuses a definition that lets the model think or sample', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
    for (const bad of [{ ...def, generation: { ...def.generation, thinking: true } }, { ...def, generation: { ...def.generation, temperature: 0.7 } }]) {
      const f = path.join(tmp, 'p.json');
      fs.writeFileSync(f, JSON.stringify(bad));
      await expect(loadQueryRewritePipeline({ definitionPath: f, evaluationOnly: true })).rejects.toThrow(/not a query_rewrite pipeline/);
    }
  });

  it('refuses to start without a licence approval for the model', async () => {
    const saved = process.env.VIGILONE_MODEL_EXCEPTIONS;
    process.env.VIGILONE_MODEL_EXCEPTIONS = path.join(os.tmpdir(), 'no-approvals.json');
    fs.writeFileSync(process.env.VIGILONE_MODEL_EXCEPTIONS, JSON.stringify({ approvals: [] }));
    try {
      await expect(loadQueryRewritePipeline()).rejects.toThrow(/LICENSE_REJECTED|approv/i);
    } finally {
      if (saved === undefined) delete process.env.VIGILONE_MODEL_EXCEPTIONS;
      else process.env.VIGILONE_MODEL_EXCEPTIONS = saved;
    }
  });
});

describe('prompt', () => {
  it('names the site places, keeps the examples, and the hash does not depend on their order', () => {
    const names = cleanVocabulary(def, ['Lobby', ' Main  Gate ', 'Lobby', 'Gate "3"']);
    expect(names).toEqual(['Gate 3', 'Lobby', 'Main Gate']);
    const msgs = buildMessages(def, 'मुख्य गेट पर बस', names);
    expect(msgs[0].content).toContain('Gate 3, Lobby, Main Gate');
    expect(msgs).toHaveLength(2 + def.prompt.examples.length * 2);
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: 'मुख्य गेट पर बस' });
    expect(promptSha256(def, cleanVocabulary(def, ['Main Gate', 'Lobby']))).toBe(promptSha256(def, cleanVocabulary(def, ['Lobby', 'Main Gate'])));
    expect(promptSha256(def, ['Lobby'])).not.toBe(promptSha256(def, ['Lobby', 'Main Gate']));
  });

  it('refuses more place names than the template allows', () => {
    expect(() => cleanVocabulary(def, Array.from({ length: def.prompt.vocabularyMax + 1 }, (_, i) => `Camera ${i}`))).toThrow(/at most/);
  });

  it('accepts only {"english": "..."}', () => {
    expect(parseRewrite('{"english":"  bus at  Main Gate "}', 300)).toBe('bus at Main Gate');
    for (const bad of ['not json', '{"english":""}', '{"english":"x","extra":1}', '["x"]', `{"english":"${'x'.repeat(301)}"}`]) {
      expect(() => parseRewrite(bad, 300)).toThrow();
    }
    expect(() => parseRewrite(undefined, 300)).toThrow(/no text/);
  });
});

/** Stand-in pipeline: SYNTHETIC rewrites, no model. */
function standIn(over: Partial<LoadedQueryRewritePipeline> = {}): LoadedQueryRewritePipeline & { calls: Array<[string, string[]]>; dead: boolean } {
  const s: any = {
    definition: def,
    definitionSha256: 'a'.repeat(64),
    components: [{ role: 'query_rewrite_model', entry: lock.candidateModels.find((c: any) => c.key === def.components[0].key), approval: null, file: '/dev/null' }],
    runtime: { buildInfo: 'b11277-eae11d2', binarySha256: 'b'.repeat(64) },
    calls: [] as Array<[string, string[]]>,
    dead: false,
    alive: () => !s.dead,
    close: async () => undefined,
    rewrite: async (text: string, vocabulary: string[]) => {
      s.calls.push([text, vocabulary]);
      return { text: 'bus at Main Gate', promptSha256: 'c'.repeat(64) };
    },
    ...over,
  };
  return s;
}

const rewriteBody = (over: Record<string, unknown> = {}) => ({ contract: 'ai-adapter.v1', requestId: 'r1', tenantId: 't', modelId: 'qwen3-4b-query-rewrite@1.0.0', text: 'मुख्य गेट पर बस', vocabulary: ['Main Gate'], deadlineMs: 5000, ...over });

describe('adapter', () => {
  it('describes one query_rewrite model with its component and the llama-server binary in provenance', async () => {
    const p = standIn();
    const core = new QueryRewriteAdapterCore(p, { adapterId: 'qr', adapterVersion: 't' });
    expect(core.describe()).toMatchObject({ tasks: ['query_rewrite'], models: [{ modelId: 'qwen3-4b-query-rewrite@1.0.0', task: 'query_rewrite', classes: ['text'], runtime: 'llama.cpp' }] });
    const r: any = await core.handleTextRewriteRequest(rewriteBody());
    expect(r).toMatchObject({ status: 'ok', requestId: 'r1', rewrite: { text: 'bus at Main Gate' } });
    expect(r.provenance.components.map((c: any) => c.role)).toEqual(['query_rewrite_model', 'runtime']);
    expect(p.calls).toEqual([['मुख्य गेट पर बस', ['Main Gate']]]);
    expect(core.metrics.render()).toMatch(/vigilone_query_rewrites_total 1/);
  });

  it('has no image task, and is FAILED with a clear reason when llama-server stops', async () => {
    const p = standIn();
    const core = new QueryRewriteAdapterCore(p, { adapterId: 'qr', adapterVersion: 't' });
    const frame = { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-10-05T10:00:00Z', width: 2, height: 2, format: 'rgb24', data: { kind: 'inline_base64', value: Buffer.alloc(12).toString('base64') } };
    expect(await core.handleInferRequest({ contract: 'ai-adapter.v1', requestId: 'i', tenantId: 't', task: 'query_rewrite', modelId: 'qwen3-4b-query-rewrite@1.0.0', deadlineMs: 1000, frame })).toMatchObject({ status: 'error', errorCode: 'UNSUPPORTED_TASK' });
    p.dead = true;
    expect(core.health()).toMatchObject({ status: 'FAILED', lastError: 'llama-server is not running' });
    expect(await core.handleTextRewriteRequest(rewriteBody())).toMatchObject({ status: 'error', errorCode: 'MODEL_NOT_LOADED' });
  });

  it('a refused model (no approval) serves FAILED with the reason and no model', () => {
    const core = new QueryRewriteAdapterCore(null, { adapterId: 'qr', adapterVersion: 't', failure: 'LICENSE_REJECTED: x' });
    expect(core.health()).toMatchObject({ status: 'FAILED', lastError: 'LICENSE_REJECTED: x' });
    expect(core.describe().models).toEqual([]);
  });

  it('over HTTP: /v1/rewrite-text is served here and nowhere else', async () => {
    const server = createAdapterServer(new QueryRewriteAdapterCore(standIn(), { adapterId: 'qr', adapterVersion: 't' }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const r = await fetch(`${url}/v1/rewrite-text`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rewriteBody()) });
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).rewrite.text).toBe('bus at Main Gate');
      const bad = await fetch(`${url}/v1/rewrite-text`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rewriteBody({ text: '' })) });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    // An adapter without a rewrite model answers 404 (the embedding adapter here).
    const { EmbeddingAdapterCore } = await import('../embedding/embeddingAdapterCore');
    const other: http.Server = createAdapterServer(new EmbeddingAdapterCore(null, { adapterId: 'e', adapterVersion: 't', failure: 'x' }));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${(other.address() as any).port}/v1/rewrite-text`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(404);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });
});
