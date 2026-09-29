/**
 * Crop embeddings and similarity search (Phase 5, P5.3), on PostgreSQL + pgvector.
 *
 * Rules enforced here:
 *  - a vector is stored only if it has exactly EMBEDDING_DIM finite components and a non-zero length; it is
 *    stored L2-normalised, so cosine similarity and inner product agree;
 *  - the model that produced it must be registered, active and of task `embedding`, with the same name,
 *    version and SHA-256 (no embedding without provenance);
 *  - a stored embedding is immutable: writing the same crop and model again keeps the first one;
 *  - search is always scoped to one tenant and one embedding model (vectors from different models are not
 *    comparable), and person crops are excluded unless the caller asks for them explicitly;
 *  - results say whether they came from the approximate index (`ann`) or an exact scan (`exact`). When the
 *    index path returns fewer rows than asked for (a filter can hide neighbours from an approximate index),
 *    the query is repeated as an exact scan, so a short answer means there really are no more matches.
 * Embeddings are deleted with their crop (foreign key cascade), so retention, holds and the person-crop
 * policy govern them too.
 */
import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

export const EMBEDDING_DIM = 768;
export const EMBEDDING_TASK = 'embedding';
export const MAX_RESULTS = 100;

export type EmbeddingErrorCode =
  | 'EMBEDDING_INVALID'
  | 'EMBEDDING_CROP_NOT_FOUND'
  | 'EMBEDDING_MODEL_NOT_REGISTERED'
  | 'EMBEDDING_NOT_FOUND'
  | 'EMBEDDING_ADAPTER_UNAVAILABLE'
  | 'EMBEDDING_ADAPTER_INVALID'
  | 'SEARCH_INVALID';

export class EmbeddingError extends Error {
  constructor(public readonly code: EmbeddingErrorCode, message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** Validates and L2-normalises a vector. Throws EmbeddingError('EMBEDDING_INVALID'); never repairs. */
export function normalizeVector(input: ArrayLike<number>): Float32Array {
  if (input.length !== EMBEDDING_DIM) throw new EmbeddingError('EMBEDDING_INVALID', `embedding has ${input.length} components, expected ${EMBEDDING_DIM}`);
  const out = new Float32Array(EMBEDDING_DIM);
  let sumSq = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = input[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new EmbeddingError('EMBEDDING_INVALID', `embedding component ${i} is not a finite number`);
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (!(norm > 1e-6)) throw new EmbeddingError('EMBEDDING_INVALID', 'embedding has zero length; cosine similarity is undefined');
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = out[i] / norm;
  return out;
}

/** pgvector text form. Float32 values are printed with enough digits to round-trip. */
export const toPgVector = (v: Float32Array): string => `[${Array.from(v, (x) => Math.fround(x).toString()).join(',')}]`;

export function fromPgVector(text: string): Float32Array {
  if (!/^\[[^\]]*\]$/.test(text)) throw new EmbeddingError('EMBEDDING_INVALID', 'not a pgvector text value');
  const out = Float32Array.from(text.slice(1, -1).split(',').map(Number));
  if (out.length !== EMBEDDING_DIM) throw new EmbeddingError('EMBEDDING_INVALID', `stored vector has ${out.length} components`);
  return out;
}

/** Decodes the adapter's `float32_base64` encoding (little-endian float32 array). */
export function decodeFloat32Base64(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0 || buf.length % 4 !== 0) throw new EmbeddingError('EMBEDDING_INVALID', `float32 payload has ${buf.length} bytes, not a multiple of 4`);
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

export interface EmbeddingModelRef {
  name: string;
  version: string;
  sha256: string;
}

export interface StoreEmbeddingInput {
  tenantId: string;
  cropId: string;
  model: EmbeddingModelRef;
  adapterId: string;
  inferenceId?: string | null;
  vector: ArrayLike<number>;
}

/** Stores one embedding. Returns created=false when this crop already has one from this model (kept unchanged). */
export async function storeEmbedding(prisma: PrismaClient, input: StoreEmbeddingInput): Promise<{ id: string | null; created: boolean }> {
  const vec = normalizeVector(input.vector);
  const crop = await prisma.objectCrop.findUnique({ where: { id: input.cropId }, select: { tenantId: true } });
  if (!crop || crop.tenantId !== input.tenantId) throw new EmbeddingError('EMBEDDING_CROP_NOT_FOUND', `crop ${input.cropId} not found for this tenant`);
  const manifest = await prisma.modelManifest.findFirst({
    where: { name: input.model.name, version: input.model.version, sha256: input.model.sha256, task: EMBEDDING_TASK, isActive: true },
    select: { id: true },
  });
  if (!manifest) {
    throw new EmbeddingError('EMBEDDING_MODEL_NOT_REGISTERED', `no active embedding model ${input.model.name}@${input.model.version} with SHA-256 ${input.model.sha256} is registered`);
  }
  const id = crypto.randomUUID();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "CropEmbedding" ("id", "tenantId", "cropId", "modelName", "modelVersion", "modelSha256", "adapterId", "inferenceId", "dim", "embedding")
    VALUES (${id}, ${input.tenantId}, ${input.cropId}, ${input.model.name}, ${input.model.version}, ${input.model.sha256}, ${input.adapterId}, ${input.inferenceId ?? null}, ${EMBEDDING_DIM}, ${toPgVector(vec)}::vector)
    ON CONFLICT ("cropId", "modelSha256") DO NOTHING
    RETURNING "id"`;
  return rows.length ? { id: rows[0].id, created: true } : { id: null, created: false };
}

/** The stored (normalised) vector of a crop for a model, or null. */
export async function loadEmbedding(prisma: PrismaClient, tenantId: string, cropId: string, modelSha256: string): Promise<Float32Array | null> {
  const rows = await prisma.$queryRaw<Array<{ v: string }>>`
    SELECT "embedding"::text AS v FROM "CropEmbedding" WHERE "tenantId" = ${tenantId} AND "cropId" = ${cropId} AND "modelSha256" = ${modelSha256}`;
  return rows.length ? fromPgVector(rows[0].v) : null;
}

export interface SearchFilters {
  tenantId: string;
  /** Vectors of different models are not comparable: a search names exactly one. */
  modelSha256: string;
  cameraIds?: string[];
  from?: Date;
  to?: Date;
  objectClasses?: string[];
  /** Person crops are excluded unless this is true. */
  includePersons?: boolean;
  /** Only person crops (requires includePersons). */
  personsOnly?: boolean;
  limit?: number;
  /** Drop results below this cosine similarity (-1..1). */
  minScore?: number;
  /** Leave this crop out (query-by-example never returns the query crop itself). */
  excludeCropId?: string;
  /** Skip the index and scan exactly. */
  exact?: boolean;
}

export interface SearchHit {
  cropId: string;
  /** Cosine similarity, 1 is identical. */
  score: number;
  cameraId: string;
  capturedAt: string;
  objectClass: string;
  cropClass: 'PERSON' | 'NON_PERSON';
  detectionEventId: string | null;
}

export interface SearchResult {
  mode: 'ann' | 'exact';
  hits: SearchHit[];
}

function buildWhere(f: SearchFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`e."tenantId" = ${f.tenantId}`, Prisma.sql`e."modelSha256" = ${f.modelSha256}`];
  if (f.cameraIds?.length) parts.push(Prisma.sql`c."cameraId" IN (${Prisma.join(f.cameraIds)})`);
  if (f.from) parts.push(Prisma.sql`c."capturedAt" >= ${f.from}`);
  if (f.to) parts.push(Prisma.sql`c."capturedAt" <= ${f.to}`);
  if (f.objectClasses?.length) parts.push(Prisma.sql`c."objectClass" IN (${Prisma.join(f.objectClasses)})`);
  if (f.excludeCropId) parts.push(Prisma.sql`c."id" <> ${f.excludeCropId}`);
  if (f.personsOnly) parts.push(Prisma.sql`c."cropClass" = 'PERSON'`);
  else if (!f.includePersons) parts.push(Prisma.sql`c."cropClass" = 'NON_PERSON'`);
  return Prisma.join(parts, ' AND ');
}

export async function searchSimilar(prisma: PrismaClient, query: ArrayLike<number>, f: SearchFilters): Promise<SearchResult> {
  const q = normalizeVector(query);
  if (f.personsOnly && !f.includePersons) throw new EmbeddingError('SEARCH_INVALID', 'personsOnly requires includePersons');
  const limit = f.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) throw new EmbeddingError('SEARCH_INVALID', `limit must be a whole number from 1 to ${MAX_RESULTS}`);
  if (f.minScore !== undefined && !(f.minScore >= -1 && f.minScore <= 1)) throw new EmbeddingError('SEARCH_INVALID', 'minScore must be between -1 and 1');
  const vec = toPgVector(q);
  const where = buildWhere(f);

  const run = async (exact: boolean): Promise<{ hits: SearchHit[]; rawCount: number }> =>
    prisma.$transaction(async (tx) => {
      if (exact) {
        // Force a scan over the table instead of the index for this query only.
        await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      } else {
        await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(Math.max(100, limit * 4))}, true)`;
      }
      const rows = await tx.$queryRaw<Array<{ cropId: string; score: number; cameraId: string; capturedAt: Date; objectClass: string; cropClass: string; detectionEventId: string | null }>>`
        SELECT e."cropId" AS "cropId", (1 - (e."embedding" <=> ${vec}::vector))::float8 AS score, c."cameraId", c."capturedAt", c."objectClass", c."cropClass", c."detectionEventId"
        FROM "CropEmbedding" e JOIN "ObjectCrop" c ON c."id" = e."cropId"
        WHERE ${where}
        ORDER BY e."embedding" <=> ${vec}::vector
        LIMIT ${limit}`;
      const hits = rows
        .filter((r) => f.minScore === undefined || r.score >= f.minScore)
        .map((r) => ({ cropId: r.cropId, score: r.score, cameraId: r.cameraId, capturedAt: r.capturedAt.toISOString(), objectClass: r.objectClass, cropClass: r.cropClass as SearchHit['cropClass'], detectionEventId: r.detectionEventId }));
      return { hits, rawCount: rows.length };
    });

  if (f.exact) return { mode: 'exact', hits: (await run(true)).hits };
  const ann = await run(false);
  // A short answer from the approximate index may be an artefact of filtering; confirm it exactly.
  // (Judged before the score cut-off, which legitimately shortens an answer.)
  if (ann.rawCount < limit) return { mode: 'exact', hits: (await run(true)).hits };
  return { mode: 'ann', hits: ann.hits };
}

/** Query by example: the crops most similar to a stored crop (never the crop itself). */
export async function searchSimilarToCrop(prisma: PrismaClient, cropId: string, f: SearchFilters): Promise<SearchResult> {
  const v = await loadEmbedding(prisma, f.tenantId, cropId, f.modelSha256);
  if (!v) throw new EmbeddingError('EMBEDDING_NOT_FOUND', `crop ${cropId} has no embedding from this model`);
  return searchSimilar(prisma, v, { ...f, excludeCropId: cropId });
}
