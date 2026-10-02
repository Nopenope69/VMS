/**
 * Cross-camera following (North Star Bucket 3): "where else did this person or vehicle go?"
 *
 * The system only suggests; an operator decides. Nothing here links two tracks on its own.
 *
 *  - Camera neighbours (CameraNeighbour) say which cameras someone can pass between and how long that usually takes.
 *    With none configured for a camera, every camera on its site is a candidate within DEFAULT_WINDOW_SECONDS, and
 *    the answer says so (`adjacency: 'site-fallback'`).
 *  - Plate candidates: other plate reads of the same plate within a window (default 24 h), on any camera, and the
 *    vehicle tracks they are tied to. An exact match on the plate, still confirmed by a person (a misread or a cloned
 *    plate is possible).
 *  - Appearance candidates: tracks of the same class on neighbouring cameras whose travel time fits, ranked by how
 *    much they look like the source track (the average of its crop embeddings, searched with trackSearch).
 *  - Decisions (TrackLink): CONFIRMED or REJECTED by a named operator, with the evidence the server found. A rejected
 *    pair is never suggested again. Link evidence never stores plate text: a link outliving the plate read must not
 *    keep the plate.
 *  - Journey: the tracks connected through CONFIRMED links, in time order.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { EmbeddingError, normalizeVector, fromPgVector } from '../search/cropEmbeddingStore';
import { searchTracks } from '../search/trackSearch';

export const DEFAULT_WINDOW_SECONDS = 600;
export const DEFAULT_PLATE_WINDOW_SECONDS = 86_400;
export const MAX_JOURNEY_TRACKS = 200;

export class FollowError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

type Track = Prisma.ObjectTrackGetPayload<{ include: { vehicleObservation: { select: { id: true; normalizedPlate: true } } } }>;

export interface Neighbour {
  cameraAId: string;
  cameraBId: string;
  minTransitSeconds: number;
  maxTransitSeconds: number;
}

export const orderPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/**
 * Seconds between one track ending and the other starting, whichever comes first. Negative when they overlap in
 * time (two cameras seeing the same moment).
 */
export function gapSeconds(a: { firstSeenAt: Date; lastSeenAt: Date }, b: { firstSeenAt: Date; lastSeenAt: Date }): number {
  const after = b.firstSeenAt.getTime() - a.lastSeenAt.getTime();
  const before = a.firstSeenAt.getTime() - b.lastSeenAt.getTime();
  return Math.round(Math.max(after, before) / 100) / 10;
}

/** Does a gap fit a neighbour's travel time? A minimum of 0 also allows overlapping views. */
export function transitFits(gap: number, n: { minTransitSeconds: number; maxTransitSeconds: number }): boolean {
  if (gap > n.maxTransitSeconds) return false;
  return gap >= n.minTransitSeconds || (n.minTransitSeconds === 0 && gap < 0);
}

export class TrackFollowService {
  constructor(private prisma: PrismaClient) {}

  // ------------------------------------------------------------------ neighbours

  async listNeighbours(tenantId: string) {
    return this.prisma.cameraNeighbour.findMany({ where: { tenantId }, orderBy: [{ cameraAId: 'asc' }, { cameraBId: 'asc' }] });
  }

  /** Replaces the tenant's neighbour list. Pairs are undirected; a pair listed twice is refused. */
  async setNeighbours(tenantId: string, userId: string, list: Neighbour[]) {
    const ids = [...new Set(list.flatMap((n) => [n.cameraAId, n.cameraBId]))];
    const found = await this.prisma.camera.count({ where: { tenantId, id: { in: ids } } });
    if (found !== ids.length) throw new FollowError(404, 'CAMERA_NOT_FOUND', 'every camera must exist in this tenant');
    const seen = new Set<string>();
    const rows = list.map((n) => {
      if (n.cameraAId === n.cameraBId) throw new FollowError(400, 'INVALID_NEIGHBOURS', 'a camera cannot be its own neighbour');
      if (n.maxTransitSeconds < n.minTransitSeconds) throw new FollowError(400, 'INVALID_NEIGHBOURS', 'maxTransitSeconds must be at least minTransitSeconds');
      const [a, b] = orderPair(n.cameraAId, n.cameraBId);
      if (seen.has(`${a}|${b}`)) throw new FollowError(400, 'INVALID_NEIGHBOURS', `cameras ${a} and ${b} are listed twice`);
      seen.add(`${a}|${b}`);
      return { tenantId, cameraAId: a, cameraBId: b, minTransitSeconds: n.minTransitSeconds, maxTransitSeconds: n.maxTransitSeconds, createdByUserId: userId };
    });
    await this.prisma.$transaction([this.prisma.cameraNeighbour.deleteMany({ where: { tenantId } }), this.prisma.cameraNeighbour.createMany({ data: rows })]);
    return this.listNeighbours(tenantId);
  }

  /** Candidate cameras for a source camera, with travel times; falls back to the whole site. */
  private async reachable(tenantId: string, cameraId: string): Promise<{ adjacency: 'configured' | 'site-fallback'; cameras: Map<string, { minTransitSeconds: number; maxTransitSeconds: number }> }> {
    const rows = await this.prisma.cameraNeighbour.findMany({ where: { tenantId, OR: [{ cameraAId: cameraId }, { cameraBId: cameraId }] } });
    const cameras = new Map<string, { minTransitSeconds: number; maxTransitSeconds: number }>();
    // Leaving and coming back into the same view is a new track on the same camera.
    cameras.set(cameraId, { minTransitSeconds: 0, maxTransitSeconds: DEFAULT_WINDOW_SECONDS });
    if (rows.length) {
      for (const r of rows) cameras.set(r.cameraAId === cameraId ? r.cameraBId : r.cameraAId, { minTransitSeconds: r.minTransitSeconds, maxTransitSeconds: r.maxTransitSeconds });
      return { adjacency: 'configured', cameras };
    }
    const cam = await this.prisma.camera.findUniqueOrThrow({ where: { id: cameraId }, select: { siteId: true } });
    const site = await this.prisma.camera.findMany({ where: { tenantId, siteId: cam.siteId }, select: { id: true } });
    for (const c of site) if (!cameras.has(c.id)) cameras.set(c.id, { minTransitSeconds: 0, maxTransitSeconds: DEFAULT_WINDOW_SECONDS });
    return { adjacency: 'site-fallback', cameras };
  }

  // ------------------------------------------------------------------ tracks and vectors

  async track(tenantId: string, id: string): Promise<Track> {
    const t = await this.prisma.objectTrack.findUnique({ where: { id }, include: { vehicleObservation: { select: { id: true, normalizedPlate: true } } } });
    if (!t || t.tenantId !== tenantId) throw new FollowError(404, 'TRACK_NOT_FOUND', 'track not found');
    return t;
  }

  /** The track's appearance: the normalised average of its crop embeddings from one model (the newest it has). */
  async trackVector(t: { cameraId: string; trackId: string; tenantId: string }, modelSha256?: string): Promise<{ vector: Float32Array; modelSha256: string; crops: number } | null> {
    const sha =
      modelSha256 ??
      (
        await this.prisma.$queryRaw<Array<{ sha: string }>>`
          SELECT e."modelSha256" AS sha FROM "CropEmbedding" e
          JOIN "ObjectCrop" c ON c."id" = e."cropId" JOIN "DetectionEvent" d ON d."id" = c."detectionEventId"
          WHERE e."tenantId" = ${t.tenantId} AND d."cameraId" = ${t.cameraId} AND d."trackId" = ${t.trackId}
          ORDER BY e."createdAt" DESC LIMIT 1`
      )[0]?.sha;
    if (!sha) return null;
    const rows = await this.prisma.$queryRaw<Array<{ v: string | null; n: bigint }>>`
      SELECT AVG(e."embedding")::text AS v, COUNT(*) AS n FROM "CropEmbedding" e
      JOIN "ObjectCrop" c ON c."id" = e."cropId" JOIN "DetectionEvent" d ON d."id" = c."detectionEventId"
      WHERE e."tenantId" = ${t.tenantId} AND e."modelSha256" = ${sha} AND d."cameraId" = ${t.cameraId} AND d."trackId" = ${t.trackId}`;
    if (!rows[0]?.v) return null;
    try {
      return { vector: normalizeVector(fromPgVector(rows[0].v)), modelSha256: sha, crops: Number(rows[0].n) };
    } catch (e) {
      if (e instanceof EmbeddingError) return null; // crops that cancel out to a zero vector have no usable appearance
      throw e;
    }
  }

  /** Existing decisions between the source and any of the targets: other track id -> status. */
  private async decisions(sourceId: string, targetIds: string[]): Promise<Map<string, string>> {
    if (!targetIds.length) return new Map();
    const links = await this.prisma.trackLink.findMany({
      where: { OR: [{ fromTrackId: sourceId, toTrackId: { in: targetIds } }, { toTrackId: sourceId, fromTrackId: { in: targetIds } }] },
      select: { fromTrackId: true, toTrackId: true, status: true },
    });
    return new Map(links.map((l) => [l.fromTrackId === sourceId ? l.toTrackId : l.fromTrackId, l.status]));
  }

  // ------------------------------------------------------------------ candidates

  async appearanceCandidates(tenantId: string, sourceId: string, opts: { limit?: number } = {}) {
    const source = await this.track(tenantId, sourceId);
    const v = await this.trackVector(source);
    if (!v) throw new FollowError(404, 'NO_APPEARANCE', 'this track has no embedded crops, so it cannot be compared by appearance');
    const reach = await this.reachable(tenantId, source.cameraId);
    const maxWindow = Math.max(...[...reach.cameras.values()].map((c) => c.maxTransitSeconds));
    const result = await searchTracks(this.prisma, {
      tenantId,
      modelSha256: v.modelSha256,
      query: v.vector,
      filters: {
        cameraIds: [...reach.cameras.keys()],
        from: new Date(source.firstSeenAt.getTime() - maxWindow * 1000),
        to: new Date(source.lastSeenAt.getTime() + maxWindow * 1000),
        objectClasses: [source.objectClass],
        includePersons: source.objectClass === 'person',
        excludeTrackIds: [source.id],
      },
      limit: 50,
      candidates: 1000,
    });
    const tracks = await this.prisma.objectTrack.findMany({ where: { tenantId, id: { in: result.hits.map((h) => h.trackDbId) } } });
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const decided = await this.decisions(source.id, tracks.map((t) => t.id));
    const out = [];
    let outsideTravelTime = 0;
    for (const h of result.hits) {
      const t = byId.get(h.trackDbId);
      if (!t || decided.get(t.id) === 'REJECTED') continue;
      const gap = gapSeconds(source, t);
      if (!transitFits(gap, reach.cameras.get(t.cameraId)!)) {
        outsideTravelTime++;
        continue;
      }
      out.push({ trackDbId: t.id, score: h.score, matchedCropId: h.bestCropId, gapSeconds: gap, decision: decided.get(t.id) ?? null });
      if (out.length >= (opts.limit ?? 20)) break;
    }
    return { adjacency: reach.adjacency, modelSha256: v.modelSha256, sourceCrops: v.crops, outsideTravelTime, candidates: out };
  }

  async plateCandidates(tenantId: string, sourceId: string, opts: { windowSeconds?: number } = {}) {
    const source = await this.track(tenantId, sourceId);
    if (!source.vehicleObservation) throw new FollowError(400, 'NO_PLATE', 'this track has no plate read tied to it');
    const w = (opts.windowSeconds ?? DEFAULT_PLATE_WINDOW_SECONDS) * 1000;
    const reads = await this.prisma.vehicleObservation.findMany({
      where: {
        tenantId,
        normalizedPlate: source.vehicleObservation.normalizedPlate,
        id: { not: source.vehicleObservation.id },
        lastSeenAt: { gte: new Date(source.firstSeenAt.getTime() - w) },
        firstSeenAt: { lte: new Date(source.lastSeenAt.getTime() + w) },
      },
      select: { id: true, cameraId: true, firstSeenAt: true, lastSeenAt: true, objectTracks: { where: { id: { not: source.id } }, select: { id: true } } },
      orderBy: { firstSeenAt: 'asc' },
    });
    const trackIds = reads.flatMap((r) => r.objectTracks.map((t) => t.id));
    const decided = await this.decisions(source.id, trackIds);
    const tracks = await this.prisma.objectTrack.findMany({ where: { id: { in: trackIds } }, select: { id: true, firstSeenAt: true, lastSeenAt: true } });
    const byId = new Map(tracks.map((t) => [t.id, t]));
    return {
      candidates: trackIds
        .filter((id) => decided.get(id) !== 'REJECTED')
        .map((id) => ({ trackDbId: id, score: 1, gapSeconds: gapSeconds(source, byId.get(id)!), decision: decided.get(id) ?? null })),
      // Reads of the same plate with no vehicle track (the detector missed the vehicle): shown, but cannot be linked.
      readsWithoutTrack: reads.filter((r) => r.objectTracks.length === 0).map((r) => ({ vehicleObservationId: r.id, cameraId: r.cameraId, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt })),
    };
  }

  // ------------------------------------------------------------------ decisions

  async decide(tenantId: string, userId: string, sourceId: string, input: { toTrackId: string; method: 'PLATE' | 'APPEARANCE'; decision: 'CONFIRMED' | 'REJECTED'; note?: string }) {
    if (sourceId === input.toTrackId) throw new FollowError(400, 'INVALID_LINK', 'a track cannot be linked to itself');
    const a = await this.track(tenantId, sourceId);
    const b = await this.track(tenantId, input.toTrackId);
    if ((a.objectClass === 'person') !== (b.objectClass === 'person')) throw new FollowError(400, 'INVALID_LINK', 'a person track can only be linked to a person track');
    let evidence: Record<string, unknown>;
    if (input.method === 'PLATE') {
      if (!a.vehicleObservation || !b.vehicleObservation) throw new FollowError(400, 'NO_PLATE', 'both tracks need a plate read for a PLATE link');
      if (a.vehicleObservation.normalizedPlate !== b.vehicleObservation.normalizedPlate) throw new FollowError(400, 'PLATE_MISMATCH', 'the two tracks were read with different plates');
      // The plate text itself is not copied into the link: the plate read keeps its own retention.
      evidence = { samePlate: true, vehicleObservationIds: [a.vehicleObservation.id, b.vehicleObservation.id] };
    } else {
      const va = await this.trackVector(a);
      const vb = va ? await this.trackVector(b, va.modelSha256) : null;
      evidence = va && vb ? { similarity: dot(va.vector, vb.vector), modelSha256: va.modelSha256 } : { similarity: null, reason: 'no embedded crops on one of the tracks' };
    }
    evidence.gapSeconds = gapSeconds(a, b);
    const [fromTrackId, toTrackId] = orderPair(a.id, b.id);
    const data = { method: input.method, status: input.decision, evidenceJson: evidence as Prisma.InputJsonValue, note: input.note ?? null, decidedByUserId: userId, decidedAt: new Date() };
    return this.prisma.trackLink.upsert({ where: { fromTrackId_toTrackId: { fromTrackId, toTrackId } }, create: { tenantId, fromTrackId, toTrackId, ...data }, update: data });
  }

  // ------------------------------------------------------------------ journey

  /** The tracks reachable from a track through CONFIRMED links, in time order, with the links between them. */
  async journey(tenantId: string, trackId: string) {
    const start = await this.track(tenantId, trackId);
    const seen = new Set([start.id]);
    let frontier = [start.id];
    const links = new Map<string, { id: string; fromTrackId: string; toTrackId: string; method: string; evidenceJson: unknown; decidedByUserId: string; decidedAt: Date }>();
    let truncated = false;
    while (frontier.length) {
      const found = await this.prisma.trackLink.findMany({
        where: { tenantId, status: 'CONFIRMED', OR: [{ fromTrackId: { in: frontier } }, { toTrackId: { in: frontier } }] },
        select: { id: true, fromTrackId: true, toTrackId: true, method: true, evidenceJson: true, decidedByUserId: true, decidedAt: true },
      });
      const next: string[] = [];
      for (const l of found) {
        links.set(l.id, l);
        for (const id of [l.fromTrackId, l.toTrackId]) {
          if (seen.has(id)) continue;
          if (seen.size >= MAX_JOURNEY_TRACKS) {
            truncated = true;
            continue;
          }
          seen.add(id);
          next.push(id);
        }
      }
      frontier = next;
    }
    return { trackIds: [...seen], links: [...links.values()], truncated };
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
