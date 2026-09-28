/**
 * Thin onnxruntime-node session for the auxiliary models (text detector, plate OCR, face
 * detector). Loaded lazily like the main engine; a missing binding or a corrupt model fails
 * loudly with the reason instead of degrading to "no detections".
 */
export class OrtSessionError extends Error {}

export class OrtSession {
  private constructor(private ort: any, private session: any, public readonly inputNames: string[], public readonly outputNames: string[]) {}

  static async create(model: Buffer, threads = 1): Promise<OrtSession> {
    let ort: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ort = require('onnxruntime-node');
    } catch (e: any) {
      throw new OrtSessionError(`onnxruntime-node is not available: ${e.message}`);
    }
    try {
      const session = await ort.InferenceSession.create(model, {
        executionProviders: ['cpu'],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      });
      return new OrtSession(ort, session, session.inputNames, session.outputNames);
    } catch (e: any) {
      throw new OrtSessionError(`model could not be loaded: ${e.message}`);
    }
  }

  async run(feeds: Record<string, { type: 'float32' | 'uint8'; data: Float32Array | Uint8Array; dims: number[] }>): Promise<Record<string, { data: Float32Array; dims: number[] }>> {
    const t: Record<string, any> = {};
    for (const [k, v] of Object.entries(feeds)) t[k] = new this.ort.Tensor(v.type, v.data, v.dims);
    const out = await this.session.run(t);
    const res: Record<string, { data: Float32Array; dims: number[] }> = {};
    for (const [k, v] of Object.entries<any>(out)) {
      if (v.type !== 'float32' || !ArrayBuffer.isView(v.data)) throw new OrtSessionError(`output ${k} is ${v.type}, expected float32`);
      res[k] = { data: v.data as Float32Array, dims: v.dims.map(Number) };
    }
    return res;
  }
}
