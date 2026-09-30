/**
 * Alarm second opinion with the REAL SmolVLM2 2.2B and a llama-server built from the pinned llama.cpp commit.
 * Needs the model files and VLM_LLAMA_SERVER_BIN; skipped without them unless VIGILONE_REQUIRE_MODEL_TESTS=1.
 *
 * Four public-domain scikit-image pictures and eight yes/no questions with obvious answers. This shows the
 * pipeline works and the model is not answering at random; it says nothing about how well it judges real
 * CCTV alarms, which needs operator verdicts from a pilot (docs/operations/VLM_VERIFICATION.md).
 * The models are candidates (training data licences unclear): tests load them with evaluationOnly.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { artifactPathFor, findCandidateEntry, resolveModelsDir } from '../modelCatalog';
import { loadVlmPipeline, LoadedVlmPipeline, promptSha256, resolveVlmPipelinePath } from '../vlm/vlmPipeline';
import { VlmAdapterCore } from '../vlm/vlmAdapterCore';

const def = JSON.parse(fs.readFileSync(resolveVlmPipelinePath(), 'utf8'));
const bin = process.env.VLM_LLAMA_SERVER_BIN;
const present = !!bin && fs.existsSync(bin) && def.components.every((c: any) => fs.existsSync(artifactPathFor(findCandidateEntry(c.key), resolveModelsDir())));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
const SRC = path.join(__dirname, 'fixtures', 'golden', 'source');
const jpeg = (name: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(SRC, `${name}.png`), '-q:v', '3', '-f', 'mjpeg', '-'], { maxBuffer: 32 << 20 });
const size = (name: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(SRC, `${name}.png`)]).toString().trim().split(',').map(Number);

describe('SmolVLM2 model files for the golden test', () => {
  it('are present, or this run does not require them (VIGILONE_REQUIRE_MODEL_TESTS)', () => {
    if (!present && required) throw new Error('set VLM_LLAMA_SERVER_BIN and fetch smolvlm2-2.2b-instruct-q4km and smolvlm2-2.2b-instruct-mmproj-q8');
    expect(present || !required).toBe(true);
  });
});

(present ? describe : describe.skip)('SmolVLM2 second opinion on public-domain pictures (real model)', () => {
  let p: LoadedVlmPipeline;
  let core: VlmAdapterCore;
  beforeAll(async () => {
    p = await loadVlmPipeline({ evaluationOnly: true });
    core = new VlmAdapterCore(p, { adapterId: 'vigilone-vlm', adapterVersion: 'test' });
  }, 300000);
  afterAll(async () => {
    await p?.close();
  });

  it('runs the pinned llama.cpp build', () => {
    expect(p.runtime.buildInfo.endsWith(def.llamaCpp.commit.slice(0, 7))).toBe(true);
  });

  const cases: Array<[string, string, 'yes' | 'no']> = [
    ['astronaut', 'person', 'yes'],
    ['camera', 'person', 'yes'],
    ['chelsea', 'person', 'no'],
    ['coffee', 'person', 'no'],
    ['chelsea', 'cat', 'yes'],
    ['coffee', 'cat', 'no'],
    ['astronaut', 'car', 'no'],
    ['camera', 'dog', 'no'],
  ];
  it.each(cases)('%s: is there a %s? -> %s', async (img, cls, expected) => {
    const [width, height] = size(img);
    const r: any = await core.handleInferRequest({
      contract: 'ai-adapter.v1', requestId: `${img}-${cls}`, tenantId: 't', task: 'vlm_verification', modelId: core.pipelineModelId, deadlineMs: 60000, vlmQuery: { targetClass: cls },
      frame: { cameraId: 'c', streamSessionId: 's', sequenceNumber: 1, timestampUtc: '2026-09-30T10:00:00.000Z', width, height, format: 'jpeg', data: { kind: 'inline_base64', value: jpeg(img).toString('base64') } },
    });
    expect(r.status).toBe('ok');
    expect(r.verification.answer).toBe(expected);
    expect(r.verification.promptSha256).toBe(promptSha256(def, cls));
    expect(r.verification.reason.length).toBeGreaterThan(0);
  }, 120000);

  it('gives the same answer and reason when asked again (greedy decoding, fixed seed)', async () => {
    const a = await p.ask(jpeg('chelsea'), 'cat', 60000);
    const b = await p.ask(jpeg('chelsea'), 'cat', 60000);
    expect(b).toEqual(a);
  }, 120000);

  it('refuses to run in the product path without a human approval', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vlm-approvals-')), 'a.json');
    fs.writeFileSync(file, JSON.stringify({ approvals: [] }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = file;
    try {
      await expect(loadVlmPipeline()).rejects.toThrow(/LICENSE_REJECTED/);
    } finally {
      delete process.env.VIGILONE_MODEL_EXCEPTIONS;
    }
  });
});
