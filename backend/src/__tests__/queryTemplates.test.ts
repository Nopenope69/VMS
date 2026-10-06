import { ensembleTextEmbedding, parseTemplates, DEFAULT_TEMPLATES, applyTemplate } from '../services/search/queryTemplates';

const model = (sha: string) => ({ name: 'siglip2', version: '1', sha256: sha } as any);
const res = (vector: number[], sha = 'a', adapterId = 'ad', inferenceId = 'i') => ({
  vector: Float32Array.from(vector),
  model: model(sha),
  adapterId,
  inferenceId,
});

describe('parseTemplates', () => {
  it('uses the defaults for blank input', () => {
    expect(parseTemplates('')).toEqual([...DEFAULT_TEMPLATES]);
    expect(parseTemplates(undefined)).toEqual([...DEFAULT_TEMPLATES]);
  });
  it('splits on | and trims', () => {
    expect(parseTemplates(' {q} | a CCTV frame of {q} ')).toEqual(['{q}', 'a CCTV frame of {q}']);
  });
  it('rejects templates without exactly one {q}', () => {
    expect(() => parseTemplates('a photo')).toThrow(/exactly once/);
    expect(() => parseTemplates('{q} and {q}')).toThrow(/exactly once/);
  });
  it('rejects more than 8 templates', () => {
    expect(() => parseTemplates(Array.from({ length: 9 }, () => '{q}').join('|'))).toThrow(/at most 8/);
  });
});

describe('ensembleTextEmbedding', () => {
  it('embeds every templated phrasing and returns the normalised mean', async () => {
    const seen: string[] = [];
    const vecs: Record<string, number[]> = { 'red car': [1, 0, 0], 'a photo of red car': [0, 1, 0] };
    const out = await ensembleTextEmbedding(
      async (t) => {
        seen.push(t);
        return res(vecs[t]);
      },
      'red car',
      ['{q}', 'a photo of {q}']
    );
    expect(seen).toEqual(['red car', 'a photo of red car']);
    const v = Array.from(out.vector);
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(v[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(Math.hypot(...v)).toBeCloseTo(1, 5);
  });

  it('gives each phrasing equal weight whatever the length of its raw vector', async () => {
    const out = await ensembleTextEmbedding(async (t) => (t === 'x' ? res([10, 0]) : res([0, 0.1])), 'x', ['{q}', 'a {q}']);
    expect(out.vector[0]).toBeCloseTo(out.vector[1], 5);
  });

  it('keeps the model identity and joins the inference ids for provenance', async () => {
    let n = 0;
    const out = await ensembleTextEmbedding(async () => res([1, 1], 'sha-1', 'ad-1', `inf${++n}`), 'q', ['{q}', 'a {q}']);
    expect(out.model.sha256).toBe('sha-1');
    expect(out.adapterId).toBe('ad-1');
    expect(out.inferenceId).toBe('inf1+inf2');
  });

  it('fails instead of mixing vectors when the model changes mid-query', async () => {
    let n = 0;
    await expect(ensembleTextEmbedding(async () => res([1, 0], n++ ? 'b' : 'a'), 'q', ['{q}', 'a {q}'])).rejects.toThrow(/model changed/);
  });

  it('fails on a zero vector', async () => {
    await expect(ensembleTextEmbedding(async () => res([0, 0]), 'q', ['{q}'])).rejects.toThrow(/zero length/);
  });

  it('with the single plain template equals the plain normalised embedding', async () => {
    const out = await ensembleTextEmbedding(async () => res([3, 4]), 'q', ['{q}']);
    expect(Array.from(out.vector)[0]).toBeCloseTo(0.6, 5);
    expect(Array.from(out.vector)[1]).toBeCloseTo(0.8, 5);
  });

  it('applyTemplate substitutes the query', () => {
    expect(applyTemplate('a photo of {q}', 'blue bike')).toBe('a photo of blue bike');
  });
});

describe('settings', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { setting, SettingError } = require('../config/settings');

  it('is off by default and uses the default templates', () => {
    expect(setting('QUERY_TEMPLATE_ENSEMBLE', {})).toBe(false);
    expect(setting('QUERY_TEMPLATES', {})).toEqual([...DEFAULT_TEMPLATES]);
  });

  it('reads custom templates and rejects a bad one by naming the variable', () => {
    expect(setting('QUERY_TEMPLATES', { QUERY_TEMPLATES: '{q}|a still of {q}' })).toEqual(['{q}', 'a still of {q}']);
    expect(() => setting('QUERY_TEMPLATES', { QUERY_TEMPLATES: 'no placeholder' })).toThrow(SettingError);
    expect(() => setting('QUERY_TEMPLATES', { QUERY_TEMPLATES: 'no placeholder' })).toThrow(/QUERY_TEMPLATES/);
  });
});
