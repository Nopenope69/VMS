/**
 * ONNX Runtime session planning: which execution provider to try, what to do when it cannot start, and the
 * CPU thread / optimisation settings.
 *
 * Honesty rules:
 *  - The provider reported afterwards is the one that actually created the session, never the one requested.
 *  - A fallback is always recorded with its reason, so provenance and the model audit trail cannot claim
 *    acceleration that did not happen.
 *  - Only CPU may be a fallback target. A CPU failure is never retried or hidden.
 *
 * The prebuilt onnxruntime-node binary ships CPU only. A non-CPU provider needs its own provider library in the
 * image; without it session creation fails and, unless AI_EP_FALLBACK=none, the model runs on CPU.
 */

export type EpFallbackPolicy = 'cpu' | 'none';

export const GRAPH_OPT_LEVELS = ['disabled', 'basic', 'extended', 'layout', 'all'] as const;
export type GraphOptLevel = (typeof GRAPH_OPT_LEVELS)[number];

export interface SessionPlan {
  /** Provider the manifest asked for (already normalised). */
  requested: string;
  fallback: EpFallbackPolicy;
  /** Settings passed straight to InferenceSession.create. Empty unless the operator set them. */
  sessionOptions: { intraOpNumThreads?: number; graphOptimizationLevel?: GraphOptLevel };
}

export interface FallbackNote {
  from: string;
  reason: string;
}

export interface CreatedSession {
  session: any;
  /** The provider that really created the session. */
  executionProvider: string;
  fallback?: FallbackNote;
}

type Env = Record<string, string | undefined>;

export function planSession(requested: string, env: Env = process.env): SessionPlan {
  const rawPolicy = (env.AI_EP_FALLBACK ?? 'cpu').trim().toLowerCase();
  if (rawPolicy !== 'cpu' && rawPolicy !== 'none') {
    throw new Error(`INVALID_AI_EP_FALLBACK: '${env.AI_EP_FALLBACK}' (expected 'cpu' or 'none')`);
  }

  const sessionOptions: SessionPlan['sessionOptions'] = {};

  const threads = env.AI_ORT_INTRA_OP_THREADS;
  if (threads !== undefined && threads.trim() !== '') {
    const n = Number(threads);
    if (!Number.isInteger(n) || n < 1 || n > 256) {
      throw new Error(`INVALID_AI_ORT_INTRA_OP_THREADS: '${threads}' (expected an integer from 1 to 256)`);
    }
    sessionOptions.intraOpNumThreads = n;
  }

  const level = env.AI_ORT_GRAPH_OPT;
  if (level !== undefined && level.trim() !== '') {
    const l = level.trim().toLowerCase() as GraphOptLevel;
    if (!GRAPH_OPT_LEVELS.includes(l)) {
      throw new Error(`INVALID_AI_ORT_GRAPH_OPT: '${level}' (expected one of ${GRAPH_OPT_LEVELS.join(', ')})`);
    }
    sessionOptions.graphOptimizationLevel = l;
  }

  return { requested, fallback: rawPolicy, sessionOptions };
}

const message = (e: unknown) => (e as any)?.message || String(e);

/**
 * Creates the session on the requested provider; if that fails and the policy allows it, on CPU.
 * Throws with both reasons when nothing could start.
 */
export async function createSessionWithFallback(ort: any, artifact: Buffer, plan: SessionPlan): Promise<CreatedSession> {
  const create = (ep: string) =>
    ort.InferenceSession.create(artifact, { ...plan.sessionOptions, executionProviders: [ep] });

  try {
    return { session: await create(plan.requested), executionProvider: plan.requested };
  } catch (first) {
    if (plan.requested === 'cpu') {
      throw new Error(`Failed to create native ONNX session: ${message(first)}`);
    }
    if (plan.fallback === 'none') {
      throw new Error(
        `Failed to create native ONNX session on '${plan.requested}' and AI_EP_FALLBACK=none: ${message(first)}`
      );
    }
    const reason = message(first);
    try {
      return {
        session: await create('cpu'),
        executionProvider: 'cpu',
        fallback: { from: plan.requested, reason },
      };
    } catch (second) {
      throw new Error(
        `Failed to create native ONNX session on '${plan.requested}' (${reason}) and on the CPU fallback (${message(second)})`
      );
    }
  }
}
