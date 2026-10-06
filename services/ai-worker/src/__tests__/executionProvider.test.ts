import { planSession, createSessionWithFallback } from '../executionProvider';

const artifact = Buffer.from([1, 2, 3]);

/** A fake onnxruntime whose providers succeed or fail as scripted. */
function fakeOrt(failing: Record<string, string>) {
  const calls: any[] = [];
  return {
    calls,
    InferenceSession: {
      create: async (_b: Buffer, opts: any) => {
        const ep = opts.executionProviders[0];
        calls.push(opts);
        if (failing[ep]) throw new Error(failing[ep]);
        return { ep };
      },
    },
  };
}

describe('planSession', () => {
  it('defaults to CPU fallback and no session overrides', () => {
    expect(planSession('openvino', {})).toEqual({ requested: 'openvino', fallback: 'cpu', sessionOptions: {} });
  });

  it('reads thread count, graph level and strict fallback from the environment', () => {
    const p = planSession('cpu', { AI_EP_FALLBACK: 'NONE', AI_ORT_INTRA_OP_THREADS: '2', AI_ORT_GRAPH_OPT: 'Extended' });
    expect(p.fallback).toBe('none');
    expect(p.sessionOptions).toEqual({ intraOpNumThreads: 2, graphOptimizationLevel: 'extended' });
  });

  it.each([
    [{ AI_EP_FALLBACK: 'cuda' }, /INVALID_AI_EP_FALLBACK/],
    [{ AI_ORT_INTRA_OP_THREADS: '0' }, /INVALID_AI_ORT_INTRA_OP_THREADS/],
    [{ AI_ORT_INTRA_OP_THREADS: '2.5' }, /INVALID_AI_ORT_INTRA_OP_THREADS/],
    [{ AI_ORT_INTRA_OP_THREADS: 'many' }, /INVALID_AI_ORT_INTRA_OP_THREADS/],
    [{ AI_ORT_GRAPH_OPT: 'fast' }, /INVALID_AI_ORT_GRAPH_OPT/],
  ])('rejects a bad setting loudly: %j', (env, msg) => {
    expect(() => planSession('cpu', env)).toThrow(msg);
  });

  it('ignores blank values', () => {
    expect(planSession('cpu', { AI_ORT_INTRA_OP_THREADS: ' ', AI_ORT_GRAPH_OPT: '' }).sessionOptions).toEqual({});
  });
});

describe('createSessionWithFallback', () => {
  it('reports the requested provider when it starts, with no fallback note', async () => {
    const ort = fakeOrt({});
    const r = await createSessionWithFallback(ort, artifact, planSession('openvino', {}));
    expect(r.executionProvider).toBe('openvino');
    expect(r.fallback).toBeUndefined();
    expect(ort.calls).toHaveLength(1);
  });

  it('runs on CPU when the requested provider cannot start, and says so', async () => {
    const ort = fakeOrt({ openvino: 'Failed to load shared library libonnxruntime_providers_openvino.so' });
    const r = await createSessionWithFallback(ort, artifact, planSession('openvino', {}));
    expect(r.executionProvider).toBe('cpu');
    expect(r.session).toEqual({ ep: 'cpu' });
    expect(r.fallback).toEqual({ from: 'openvino', reason: expect.stringContaining('libonnxruntime_providers_openvino.so') });
  });

  it('refuses instead of falling back when AI_EP_FALLBACK=none', async () => {
    const ort = fakeOrt({ cuda: 'no device' });
    await expect(
      createSessionWithFallback(ort, artifact, planSession('cuda', { AI_EP_FALLBACK: 'none' }))
    ).rejects.toThrow(/AI_EP_FALLBACK=none: no device/);
    expect(ort.calls).toHaveLength(1);
  });

  it('never hides a CPU failure and does not retry it', async () => {
    const ort = fakeOrt({ cpu: 'bad model' });
    await expect(createSessionWithFallback(ort, artifact, planSession('cpu', {}))).rejects.toThrow(/bad model/);
    expect(ort.calls).toHaveLength(1);
  });

  it('reports both reasons when the provider and the CPU fallback both fail', async () => {
    const ort = fakeOrt({ dml: 'no gpu', cpu: 'bad model' });
    await expect(createSessionWithFallback(ort, artifact, planSession('dml', {}))).rejects.toThrow(
      /'dml' \(no gpu\) and on the CPU fallback \(bad model\)/
    );
  });

  it('passes session settings to every attempt', async () => {
    const ort = fakeOrt({ openvino: 'x' });
    await createSessionWithFallback(ort, artifact, planSession('openvino', { AI_ORT_INTRA_OP_THREADS: '3' }));
    expect(ort.calls.map((c) => c.intraOpNumThreads)).toEqual([3, 3]);
  });
});
