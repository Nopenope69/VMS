/**
 * SigLIP 2 embeddings vs the official PyTorch checkpoint (tools/reference/siglip2_reference.py) on
 * SYNTHETIC images and fixed prompts. The models are candidates (training data unpublished): tests
 * load them with evaluationOnly, the product path needs a human approval (see embeddingAdapter.test.ts).
 *
 * Skipped when the model files are absent unless VIGILONE_REQUIRE_MODEL_TESTS=1.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { Image3 } from '../anpr/imageOps';
import { findCandidateEntry, artifactPathFor, resolveModelsDir } from '../modelCatalog';
import { EMBEDDING_DIM, LoadedEmbeddingPipeline, loadEmbeddingPipeline } from '../embedding/embeddingPipeline';

const FIX = path.join(__dirname, 'fixtures', 'embedding');
const ref = JSON.parse(fs.readFileSync(path.join(FIX, 'siglip2.reference.json'), 'utf8'));
const present = ['siglip2-base-p16-224-vision', 'siglip2-base-p16-224-text'].every((k) => fs.existsSync(artifactPathFor(findCandidateEntry(k), resolveModelsDir())));
const required = process.env.VIGILONE_REQUIRE_MODEL_TESTS === '1';
const f32 = (b64: string) => new Float32Array(Uint8Array.from(Buffer.from(b64, 'base64')).buffer);
const cos = (a: Float32Array, b: Float32Array) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / Math.sqrt(x * y);
};
function load(file: string): Image3 {
  const data = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
  const [width, height] = probe.split(',').map(Number);
  return { data: new Uint8Array(data), width, height };
}

const d = present || required ? describe : describe.skip;
d('SigLIP 2 pipeline equals the official checkpoint', () => {
  let p: LoadedEmbeddingPipeline;
  beforeAll(async () => {
    p = await loadEmbeddingPipeline({ evaluationOnly: true });
  }, 120000);

  it('has the pinned identity', () => {
    expect(p.definition.dim).toBe(EMBEDDING_DIM);
    expect(p.definitionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(p.components.map((c) => c.role)).toEqual(['image_encoder', 'text_encoder']);
  });

  for (const im of ref.images) {
    it(`${im.file}: image embedding matches PyTorch (cosine >= 0.99999)`, async () => {
      const v = await p.embedImage(load(path.join(FIX, im.file)));
      expect(v.length).toBe(EMBEDDING_DIM);
      expect(cos(v, f32(im.pytorchEmbeddingF32b64))).toBeGreaterThan(0.99999);
    });
  }

  for (const t of ref.prompts) {
    it(`prompt ${JSON.stringify(t.text.slice(0, 40))}: token ids equal the official tokenizer`, () => {
      expect(p.tokenize(t.text)).toEqual(t.inputIds);
    });
    it(`prompt ${JSON.stringify(t.text.slice(0, 40))}: text embedding matches PyTorch (cosine >= 0.99999)`, async () => {
      expect(cos(await p.embedText(t.text), f32(t.pytorchEmbeddingF32b64))).toBeGreaterThan(0.99999);
    });
  }

  it('refuses to run in the product path without a human approval', async () => {
    // An empty approvals file, independent of what the repository's own file approves.
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'siglip2-approvals-')), 'approvals.json');
    fs.writeFileSync(file, JSON.stringify({ approvals: [] }));
    process.env.VIGILONE_MODEL_EXCEPTIONS = file;
    try {
      await expect(loadEmbeddingPipeline()).rejects.toThrow(/LICENSE_REJECTED/);
    } finally {
      delete process.env.VIGILONE_MODEL_EXCEPTIONS;
    }
  });

  it('runs in the product path with the approvals in scripts/models/model-license-exceptions.json', async () => {
    const approved = await loadEmbeddingPipeline();
    expect(approved.components.map((c) => c.approval?.key)).toEqual(['siglip2-base-p16-224-vision', 'siglip2-base-p16-224-text']);
  }, 120000);
});
