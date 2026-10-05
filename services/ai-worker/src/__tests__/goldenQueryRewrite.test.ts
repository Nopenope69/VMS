/**
 * Plain-language search with the REAL Qwen3-4B and a llama-server built from the pinned llama.cpp commit. Needs the
 * model file and QUERY_LLM_LLAMA_SERVER_BIN (or VLM_LLAMA_SERVER_BIN); skipped without them unless
 * VIGILONE_REQUIRE_MODEL_TESTS=1. A few Devanagari requests with obvious English: this shows the pipeline works and
 * the model is not answering at random. The measured accuracy on labelled sets is in docs/ai/nl-search-evaluation.md
 * (backend/scripts/eval/nl-search.ts). The model is a candidate: loaded here with evaluationOnly.
 */
import fs from 'fs';
import { artifactPathFor, findCandidateEntry, resolveModelsDir } from '../modelCatalog';
import { loadQueryRewritePipeline, LoadedQueryRewritePipeline, resolveQueryRewritePipelinePath } from '../textllm/queryRewritePipeline';
import { QueryRewriteAdapterCore } from '../textllm/queryRewriteAdapterCore';

const def = JSON.parse(fs.readFileSync(resolveQueryRewritePipelinePath(), 'utf8'));
const bin = process.env.QUERY_LLM_LLAMA_SERVER_BIN || process.env.VLM_LLAMA_SERVER_BIN;
const present = !!bin && fs.existsSync(bin) && fs.existsSync(artifactPathFor(findCandidateEntry(def.components[0].key), resolveModelsDir()));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
const PLACES = ['Gate 3', 'Main Gate', 'Lobby', 'Parking B1', 'Loading Dock', 'Platform 1'];

describe('Qwen3-4B model file for the golden test', () => {
  it('is present, or this run does not require it (VIGILONE_REQUIRE_MODEL_TESTS)', () => {
    if (!present && required) throw new Error('set QUERY_LLM_LLAMA_SERVER_BIN (or VLM_LLAMA_SERVER_BIN) and fetch qwen3-4b-q4km');
    expect(present || !required).toBe(true);
  });
});

(present ? describe : describe.skip)('Qwen3-4B query rewrite (real model)', () => {
  let p: LoadedQueryRewritePipeline;
  let core: QueryRewriteAdapterCore;
  beforeAll(async () => {
    p = await loadQueryRewritePipeline({ evaluationOnly: true });
    core = new QueryRewriteAdapterCore(p, { adapterId: 'vigilone-query-rewrite', adapterVersion: 'test' });
  }, 300000);
  afterAll(async () => {
    await p?.close();
  });

  it.each([
    ['मुख्य गेट पर बस', /\bbus\b/i, /main gate/i],
    ['लॉबी में नीली शर्ट वाला आदमी', /\bblue\b/i, /lobby/i],
    ['पार्किंग बी1 में काली बाइक', /\bblack\b/i, /parking b1/i],
  ])('%s', async (text, what, where) => {
    const r: any = await core.handleTextRewriteRequest({ contract: 'ai-adapter.v1', requestId: `g-${text.length}`, tenantId: 't', modelId: core.pipelineModelId, text, vocabulary: PLACES, deadlineMs: 60000 });
    expect(r.status).toBe('ok');
    expect(r.rewrite.text).toMatch(what);
    expect(r.rewrite.text).toMatch(where);
    expect(r.provenance).toMatchObject({ modelSha256: p.definitionSha256, runtime: `llama.cpp@${def.llamaCpp.tag}` });
  }, 120000);

  it('greedy: the same request gives the same English twice', async () => {
    const body = { contract: 'ai-adapter.v1', requestId: 'g-same', tenantId: 't', modelId: core.pipelineModelId, text: 'प्लेटफॉर्म 1 पर सूटकेस', vocabulary: PLACES, deadlineMs: 60000 };
    const a: any = await core.handleTextRewriteRequest(body);
    const b: any = await core.handleTextRewriteRequest({ ...body, requestId: 'g-same-2' });
    expect(a.rewrite).toEqual(b.rewrite);
  }, 120000);
});
