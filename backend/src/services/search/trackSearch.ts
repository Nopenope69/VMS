/**
 * Track search (North Star Bucket 2): find people and vehicles, not snapshots. One result per track.
 *
 * The query is one or more vectors in the embedding model's space (from text, a stored crop, or an uploaded
 * photo). Crops are ranked by similarity to the main query inside a single SQL statement that joins each crop to
 * its detection and track and applies the track filters (camera, time, class, zone, direction, colours, dwell,
 * plate) BEFORE ranking, so a narrow filter never empties a page of otherwise good matches. Results are then
 * grouped by track:
 *
 *   - a crop's score is its similarity to the main query, or with AND terms the lowest similarity over all of them
 *     (it must look like every term);
 *   - with NOT terms, a crop that looks more like any NOT term than like the query is "excluded"; a track is dropped
 *     when more than half of its matching crops are excluded (one stray frame does not decide);
 *   - a track's score is its best remaining crop's score; tracks are ranked by it.
 *
 * Similarity is cosine similarity of L2-normalised vectors. AND / NOT use relative comparisons only, never a fixed
 * similarity threshold, because raw similarities differ between models. How well this matches what operators mean
 * is not measured; recall@k on labelled site queries (retrieval-eval, track mode) is the gate.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { EmbeddingError, normalizeVector, toPgVector } from './cropEmbeddingStore';

export const MAX_TRACK_RESULTS = 50;
export const DEFAULT_CANDIDATES = 400;
export const MAX_CANDIDATES = 2000;
export const MAX_EXTRA_TERMS = 4;

export interface TrackFilters {
  cameraIds?: string[];
  from?: Date;
  to?: Date;
  objectClasses?: string[];
  zoneId?: string;
  direction?: string;
  upperColour?: string;
  lowerColour?: string;
  bodyColour?: string;
  minDwellSeconds?: number;
  hasPlate?: boolean;
  /** Person tracks and person crops are excluded unless this is true. */
  includePersons?: boolean;
}

export interface TrackSearchInput {
  tenantId: string;
  modelSha256: string;
  /** Main query vector; candidates are retrieved in its order. */
  query: ArrayLike<number>;
  /** Further terms every match must also resemble. */
  and?: ArrayLike<number>[];
  /** Terms a match must not resemble more than it resembles the query. */
  not?: ArrayLike<number>[];
  filters: TrackFilters;
  /** Never return this crop's own track first just because the query is that crop: leave the crop out. */
  excludeCropId?: string;
  limit?: number;
  candidates?: number;
  exact?: boolean;
}

export interface TrackHit {
  trackDbId: string;
  score: number;
  bestCropId: string;
  /** Candidate crops of this track that matched (after NOT). */
  matchedCrops: number;
  /** Candidate crops of this track dropped by a NOT term. */
  excludedCrops: number;
}

export interface TrackSearchResult {
  mode: 'ann' | 'exact';
  candidatesScanned: number;
  hits: TrackHit[];
  /** Tracks dropped because most of their matching crops looked more like a NOT term. */
  tracksExcludedByNot: number;
}

/** SQL conditions on the track (t) and crop (c) for the filters. */
export function trackFilterSql(tenantId: string, f: TrackFilters): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`t."tenantId" = ${tenantId}`];
  if (f.cameraIds?.length) parts.push(Prisma.sql`t."cameraId" IN (${Prisma.join(f.cameraIds)})`);
  if (f.from) parts.push(Prisma.sql`t."lastSeenAt" >= ${f.from}`);
  if (f.to) parts.push(Prisma.sql`t."firstSeenAt" <= ${f.to}`);
  if (f.objectClasses?.length) parts.push(Prisma.sql`t."objectClass" IN (${Prisma.join(f.objectClasses)})`);
  if (f.zoneId) parts.push(Prisma.sql`${f.zoneId} = ANY(t."zoneIds")`);
  if (f.direction) parts.push(Prisma.sql`t."direction" = ${f.direction}`);
  if (f.upperColour) parts.push(Prisma.sql`t."upperColour" = ${f.upperColour}`);
  if (f.lowerColour) parts.push(Prisma.sql`t."lowerColour" = ${f.lowerColour}`);
  if (f.bodyColour) parts.push(Prisma.sql`t."bodyColour" = ${f.bodyColour}`);
  if (f.minDwellSeconds !== undefined) parts.push(Prisma.sql`t."dwellSeconds" >= ${f.minDwellSeconds}`);
  if (f.hasPlate === true) parts.push(Prisma.sql`t."vehicleObservationId" IS NOT NULL`);
  if (f.hasPlate === false) parts.push(Prisma.sql`t."vehicleObservationId" IS NULL`);
  if (!f.includePersons) parts.push(Prisma.sql`t."objectClass" <> 'person'`, Prisma.sql`c."cropClass" = 'NON_PERSON'`);
  return Prisma.join(parts, ' AND ');
}

interface CandidateRow {
  trackDbId: string;
  cropId: string;
  [score: string]: string | number;
}

/** Groups scored candidate crops into ranked tracks (pure; exported for tests). */
export function groupByTrack(rows: Array<{ trackDbId: string; cropId: string; pos: number[]; neg: number[] }>, limit: number) {
  const byTrack = new Map<string, { best: { cropId: string; score: number } | null; matched: number; excluded: number }>();
  for (const r of rows) {
    const score = Math.min(...r.pos);
    const excluded = r.neg.length > 0 && Math.max(...r.neg) >= score;
    const g = byTrack.get(r.trackDbId) ?? { best: null, matched: 0, excluded: 0 };
    if (excluded) g.excluded++;
    else {
      g.matched++;
      if (!g.best || score > g.best.score) g.best = { cropId: r.cropId, score };
    }
    byTrack.set(r.trackDbId, g);
  }
  let tracksExcludedByNot = 0;
  const hits: TrackHit[] = [];
  for (const [trackDbId, g] of byTrack) {
    if (!g.best || g.excluded * 2 > g.matched + g.excluded) {
      tracksExcludedByNot++;
      continue;
    }
    hits.push({ trackDbId, score: g.best.score, bestCropId: g.best.cropId, matchedCrops: g.matched, excludedCrops: g.excluded });
  }
  hits.sort((a, b) => b.score - a.score || a.trackDbId.localeCompare(b.trackDbId));
  return { hits: hits.slice(0, limit), tracksExcludedByNot };
}

export async function searchTracks(prisma: PrismaClient, input: TrackSearchInput): Promise<TrackSearchResult> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRACK_RESULTS) throw new EmbeddingError('SEARCH_INVALID', `limit must be a whole number from 1 to ${MAX_TRACK_RESULTS}`);
  const candidates = input.candidates ?? DEFAULT_CANDIDATES;
  if (!Number.isInteger(candidates) || candidates < limit || candidates > MAX_CANDIDATES) throw new EmbeddingError('SEARCH_INVALID', `candidates must be a whole number from limit to ${MAX_CANDIDATES}`);
  const and = input.and ?? [];
  const not = input.not ?? [];
  if (and.length > MAX_EXTRA_TERMS || not.length > MAX_EXTRA_TERMS) throw new EmbeddingError('SEARCH_INVALID', `at most ${MAX_EXTRA_TERMS} AND and ${MAX_EXTRA_TERMS} NOT terms`);

  const main = toPgVector(normalizeVector(input.query));
  const pos = [main, ...and.map((v) => toPgVector(normalizeVector(v)))];
  const neg = not.map((v) => toPgVector(normalizeVector(v)));
  const cols = [
    ...pos.map((v, i) => Prisma.sql`(1 - (e."embedding" <=> ${v}::vector))::float8 AS ${Prisma.raw(`"p${i}"`)}`),
    ...neg.map((v, i) => Prisma.sql`(1 - (e."embedding" <=> ${v}::vector))::float8 AS ${Prisma.raw(`"n${i}"`)}`),
  ];
  const where = Prisma.join(
    [
      Prisma.sql`e."tenantId" = ${input.tenantId}`,
      Prisma.sql`e."modelSha256" = ${input.modelSha256}`,
      ...(input.excludeCropId ? [Prisma.sql`c."id" <> ${input.excludeCropId}`] : []),
      trackFilterSql(input.tenantId, input.filters),
    ],
    ' AND '
  );

  const run = async (exact: boolean) =>
    prisma.$transaction(async (tx) => {
      if (exact) {
        await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      } else {
        await tx.$executeRaw`SELECT set_config('hnsw.ef_search', ${String(Math.min(1000, Math.max(100, candidates * 2)))}, true)`;
      }
      return tx.$queryRaw<CandidateRow[]>`
        SELECT t."id" AS "trackDbId", c."id" AS "cropId", ${Prisma.join(cols, ', ')}
        FROM "CropEmbedding" e
        JOIN "ObjectCrop" c ON c."id" = e."cropId"
        JOIN "DetectionEvent" d ON d."id" = c."detectionEventId"
        JOIN "ObjectTrack" t ON t."cameraId" = d."cameraId" AND t."trackId" = d."trackId"
        WHERE ${where}
        ORDER BY e."embedding" <=> ${main}::vector
        LIMIT ${candidates}`;
    });

  let mode: 'ann' | 'exact' = input.exact ? 'exact' : 'ann';
  let rows = await run(mode === 'exact');
  // A short answer from the approximate index may be an artefact of filtering; confirm it exactly.
  if (mode === 'ann' && rows.length < candidates) {
    mode = 'exact';
    rows = await run(true);
  }
  const scored = rows.map((r) => ({
    trackDbId: r.trackDbId,
    cropId: r.cropId,
    pos: pos.map((_, i) => Number(r[`p${i}`])),
    neg: neg.map((_, i) => Number(r[`n${i}`])),
  }));
  const grouped = groupByTrack(scored, limit);
  return { mode, candidatesScanned: rows.length, ...grouped };
}
