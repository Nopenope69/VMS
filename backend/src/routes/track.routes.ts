import { Router, Request, Response } from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, hasPermission, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import { recordSensitiveQuery, requirePurpose } from '../services/privacy/dataProtection.service';
import { COLOUR_NAMES, DIRECTIONS } from '../services/tracks/trackMath';
import { bestCropsFor, presentTrack, trackInclude } from '../services/tracks/trackPresenter';
import crypto from 'crypto';
import { FeatureFlag, isFeatureEnabled } from '../config/featureFlags';
import { EmbeddingError, loadEmbedding } from '../services/search/cropEmbeddingStore';
import { jpegSize } from '../services/search/embeddingAdapterClient';
import { queryEmbedder } from '../services/search/queryEmbedder';
import { DEFAULT_CANDIDATES, MAX_CANDIDATES, MAX_EXTRA_TERMS, MAX_TRACK_RESULTS, searchTracks } from '../services/search/trackSearch';

/**
 * Track index API (feature TRACK_INDEX, licence feature ADVANCED_SEARCH): one record per tracked object.
 *
 * Person tracks (clothing colours and where someone walked) are person data: they are left out unless the request
 * sets includePersons, which needs the CROP_PERSON_QUERY permission and a declared purpose, like person crop search.
 * Plate text is left out unless the request sets includePlates, which needs PLATE_DATA_QUERY and a purpose, like
 * plate search. The two are separate questions with separate purposes, so one request cannot ask both. Every query
 * is written to the audit chain before the answer is sent; if that fails, nothing is returned.
 */
const router = Router();
router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('ADVANCED_SEARCH'));

const MAX_LIMIT = 200;
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const list = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .refine((a) => a.length > 0 && a.length <= 100, 'must list 1 to 100 values');
const iso = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'must be a date-time');
const colour = z.enum(COLOUR_NAMES);

const Query = z
  .object({
    cameraIds: list.optional(),
    from: iso.optional(),
    to: iso.optional(),
    objectClasses: list.optional(),
    zoneId: z.string().min(1).max(128).optional(),
    direction: z.enum(DIRECTIONS).optional(),
    upperColour: colour.optional(),
    lowerColour: colour.optional(),
    bodyColour: colour.optional(),
    minDwellSeconds: z.coerce.number().min(0).max(86_400).optional(),
    hasPlate: flag.optional(),
    includePersons: flag.optional(),
    includePlates: flag.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
    purpose: z.string().optional(),
    purposeReference: z.string().optional(),
  })
  .strict();

const plateGate = requirePurpose(prisma, 'PLATE');
const personGate = requirePurpose(prisma, 'BIOMETRIC');

/** Runs the purpose gate for a category. Sends the error response itself and returns false when refused. */
async function sensitiveAccess(req: Request, res: Response, kind: 'person' | 'plate'): Promise<boolean> {
  const permission = kind === 'person' ? Permission.CROP_PERSON_QUERY : Permission.PLATE_DATA_QUERY;
  if (!hasPermission(req.user!.role as Role, permission)) {
    res.status(403).json({ error: `Forbidden: ${kind === 'person' ? 'person tracks' : 'plate data'} need the '${permission}' permission`, code: kind === 'person' ? 'PERSON_TRACK_FORBIDDEN' : 'PLATE_DATA_FORBIDDEN' });
    return false;
  }
  let passed = false;
  await (kind === 'person' ? personGate : plateGate)(req, res, () => {
    passed = true;
  });
  return passed;
}

router.get('/', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const p = Query.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.') || 'query'}: ${p.error.issues[0].message}`, code: 'INVALID_TRACK_QUERY' });
  const q = p.data;
  const tenantId = req.user!.tenantId;
  const asksPersons = q.includePersons === true || (q.objectClasses?.includes('person') ?? false);
  if ((q.upperColour || q.lowerColour) && !asksPersons) {
    return res.status(400).json({ error: 'upperColour and lowerColour describe people: set includePersons=true (and declare a purpose)', code: 'PERSON_QUERY_REQUIRES_INCLUDE' });
  }
  if (q.objectClasses?.includes('person') && q.includePersons !== true) {
    return res.status(400).json({ error: 'person tracks need includePersons=true (and a declared purpose)', code: 'PERSON_QUERY_REQUIRES_INCLUDE' });
  }
  if (asksPersons && q.includePlates) {
    return res.status(400).json({ error: 'ask for person tracks and plate data in separate requests: each has its own purpose', code: 'SENSITIVE_CATEGORIES_SEPARATE' });
  }
  if (asksPersons && !(await sensitiveAccess(req, res, 'person'))) return;
  if (q.includePlates && !(await sensitiveAccess(req, res, 'plate'))) return;

  const where: Prisma.ObjectTrackWhereInput = { tenantId };
  const and: Prisma.ObjectTrackWhereInput[] = [];
  if (q.cameraIds) where.cameraId = { in: q.cameraIds };
  if (q.from) where.lastSeenAt = { gte: new Date(q.from) };
  if (q.to) where.firstSeenAt = { lte: new Date(q.to) };
  if (q.objectClasses) where.objectClass = { in: q.objectClasses };
  if (!asksPersons) and.push({ objectClass: { not: 'person' } });
  if (q.zoneId) where.zoneIds = { has: q.zoneId };
  if (q.direction) where.direction = q.direction;
  if (q.upperColour) where.upperColour = q.upperColour;
  if (q.lowerColour) where.lowerColour = q.lowerColour;
  if (q.bodyColour) where.bodyColour = q.bodyColour;
  if (q.minDwellSeconds !== undefined) where.dwellSeconds = { gte: q.minDwellSeconds };
  if (q.hasPlate !== undefined) where.vehicleObservationId = q.hasPlate ? { not: null } : null;
  if (and.length) where.AND = and;

  try {
    const limit = q.limit ?? 50;
    const tracks = await prisma.objectTrack.findMany({ where, include: trackInclude, orderBy: { lastSeenAt: 'desc' }, take: limit, skip: q.offset ?? 0 });
    const crops = await bestCropsFor(prisma, tracks);
    const details = {
      filters: { ...q, purpose: undefined, purposeReference: undefined },
      resultCount: tracks.length,
    };
    if (asksPersons) await recordSensitiveQuery(prisma, req, 'TRACK_PERSON_QUERY', details);
    else if (q.includePlates) await recordSensitiveQuery(prisma, req, 'TRACK_PLATE_QUERY', details);
    else await AuditChainService.record(prisma, { tenantId, userId: req.user!.id, action: 'TRACK_QUERY', resourceType: 'ObjectTrack', ipAddress: req.ip || '127.0.0.1', metadata: details });
    return res.json({ tracks: tracks.map((t) => presentTrack(t, crops, q.includePlates === true)), limit, offset: q.offset ?? 0 });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------ search by appearance

const MAX_TERM = 200;
const MAX_QUERY_TEXT = 512;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const term = z.string().refine((v) => v.trim().length > 0 && v.trim().length <= MAX_TERM, `each term must be 1 to ${MAX_TERM} characters`);
const SearchBody = z
  .object({
    text: z.string().optional(),
    cropId: z.string().min(1).max(128).optional(),
    imageJpegBase64: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4).optional(),
    and: z.array(term).max(MAX_EXTRA_TERMS).optional(),
    not: z.array(term).max(MAX_EXTRA_TERMS).optional(),
    filters: z
      .object({
        cameraIds: z.array(z.string().min(1)).min(1).max(100).optional(),
        from: iso.optional(),
        to: iso.optional(),
        objectClasses: z.array(z.string().min(1)).min(1).max(20).optional(),
        zoneId: z.string().min(1).max(128).optional(),
        direction: z.enum(DIRECTIONS).optional(),
        upperColour: colour.optional(),
        lowerColour: colour.optional(),
        bodyColour: colour.optional(),
        minDwellSeconds: z.number().min(0).max(86_400).optional(),
        hasPlate: z.boolean().optional(),
      })
      .strict()
      .optional(),
    includePersons: z.boolean().optional(),
    includePlates: z.boolean().optional(),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    limit: z.number().int().min(1).max(MAX_TRACK_RESULTS).optional(),
    candidates: z.number().int().min(1).max(MAX_CANDIDATES).optional(),
    exact: z.boolean().optional(),
  })
  .strict();

const searchFail = (res: Response, err: any) => {
  if (err instanceof EmbeddingError) {
    const unavailable = ['EMBEDDING_ADAPTER_UNAVAILABLE', 'EMBEDDING_ADAPTER_INVALID', 'EMBEDDING_MODEL_NOT_REGISTERED'].includes(err.code);
    const status = unavailable ? 503 : err.code === 'EMBEDDING_NOT_FOUND' || err.code === 'EMBEDDING_CROP_NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: err.message });
};

router.post('/search', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const p = SearchBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.') || 'body'}: ${p.error.issues[0].message}`, code: 'INVALID_TRACK_SEARCH' });
  const b = p.data;
  const f = b.filters ?? {};
  const tenantId = req.user!.tenantId;
  const text = b.text?.trim();
  if ((b.text !== undefined ? 1 : 0) + (b.cropId ? 1 : 0) + (b.imageJpegBase64 ? 1 : 0) !== 1) {
    return res.status(400).json({ error: 'give exactly one of text, cropId or imageJpegBase64', code: 'INVALID_TRACK_SEARCH' });
  }
  if (b.text !== undefined && (!text || text.length > MAX_QUERY_TEXT)) return res.status(400).json({ error: `text must be 1 to ${MAX_QUERY_TEXT} characters and not blank`, code: 'INVALID_TRACK_SEARCH' });
  if (!isFeatureEnabled(FeatureFlag.SEMANTIC_SEARCH)) {
    return res.status(501).json({ error: 'search by appearance needs the semantic search feature (VIGILONE_FEATURE_SEMANTIC_SEARCH)', code: 'FEATURE_DISABLED', feature: FeatureFlag.SEMANTIC_SEARCH });
  }

  let image: Buffer | undefined;
  if (b.imageJpegBase64) {
    image = Buffer.from(b.imageJpegBase64, 'base64');
    if (image.length === 0 || image.length > MAX_IMAGE_BYTES) return res.status(400).json({ error: `the photo must be 1 byte to ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, code: 'INVALID_TRACK_SEARCH' });
    try {
      jpegSize(image);
    } catch {
      return res.status(400).json({ error: 'the photo must be a JPEG', code: 'IMAGE_NOT_JPEG' });
    }
  }

  // Who may see what, decided before any embedding work.
  let queryIsPerson = false;
  if (b.cropId) {
    const c = await prisma.objectCrop.findUnique({ where: { id: b.cropId }, select: { tenantId: true, cropClass: true } });
    if (!c || c.tenantId !== tenantId) return res.status(404).json({ error: 'crop not found', code: 'EMBEDDING_CROP_NOT_FOUND' });
    queryIsPerson = c.cropClass === 'PERSON';
  }
  if ((queryIsPerson || f.objectClasses?.includes('person') || f.upperColour || f.lowerColour) && b.includePersons !== true) {
    return res.status(400).json({ error: 'this query is about people: set includePersons: true (and declare a purpose)', code: 'PERSON_QUERY_REQUIRES_INCLUDE' });
  }
  const asksPersons = b.includePersons === true;
  if (asksPersons && b.includePlates) return res.status(400).json({ error: 'ask for person tracks and plate data in separate requests: each has its own purpose', code: 'SENSITIVE_CATEGORIES_SEPARATE' });
  if (asksPersons && !(await sensitiveAccess(req, res, 'person'))) return;
  if (b.includePlates && !(await sensitiveAccess(req, res, 'plate'))) return;

  try {
    // Every text term and the photo go through the same verified model; its SHA-256 picks the stored vectors.
    const texts = [...(text ? [text] : []), ...(b.and ?? []).map((t) => t.trim()), ...(b.not ?? []).map((t) => t.trim())];
    let modelSha256 = b.modelSha256;
    const vecs = new Map<string, Float32Array>();
    let imageVector: Float32Array | undefined;
    if (texts.length || image) {
      const embed = queryEmbedder();
      if (!embed) return res.status(501).json({ error: 'text and photo queries need the embedding adapter (EMBEDDING_ADAPTER_URL is not set)', code: 'QUERY_EMBEDDING_NOT_AVAILABLE' });
      const results = [];
      for (const t of texts) {
        const r = await embed.text(t);
        vecs.set(t, r.vector);
        results.push(r);
      }
      if (image) {
        const r = await embed.image(image);
        imageVector = r.vector;
        results.push(r);
      }
      const shas = new Set(results.map((r) => r.model.sha256));
      if (shas.size !== 1) return res.status(503).json({ error: 'the embedding model changed during the query; try again', code: 'EMBEDDING_MODEL_CHANGED' });
      const served = results[0].model.sha256;
      if (modelSha256 && modelSha256 !== served) return res.status(409).json({ error: `the embedding adapter serves model ${served}, not the requested ${modelSha256}`, code: 'TEXT_MODEL_MISMATCH' });
      modelSha256 = served;
    }
    if (!modelSha256) {
      const last = await prisma.cropEmbedding.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { modelSha256: true } });
      if (!last) return res.status(404).json({ error: 'no crop has been embedded yet', code: 'NO_EMBEDDINGS' });
      modelSha256 = last.modelSha256;
    }
    let query: Float32Array;
    if (b.cropId) {
      const v = await loadEmbedding(prisma, tenantId, b.cropId, modelSha256);
      if (!v) return res.status(404).json({ error: `crop ${b.cropId} has no embedding from model ${modelSha256}`, code: 'EMBEDDING_NOT_FOUND' });
      query = v;
    } else query = imageVector ?? vecs.get(text!)!;

    const result = await searchTracks(prisma, {
      tenantId,
      modelSha256,
      query,
      and: (b.and ?? []).map((t) => vecs.get(t.trim())!),
      not: (b.not ?? []).map((t) => vecs.get(t.trim())!),
      filters: { ...f, from: f.from ? new Date(f.from) : undefined, to: f.to ? new Date(f.to) : undefined, includePersons: asksPersons },
      excludeCropId: b.cropId,
      limit: b.limit,
      candidates: b.candidates ?? Math.max(DEFAULT_CANDIDATES, b.limit ?? 0),
      exact: b.exact,
    });
    const rows = await prisma.objectTrack.findMany({ where: { id: { in: result.hits.map((h) => h.trackDbId) }, tenantId }, include: trackInclude });
    const byId = new Map(rows.map((t) => [t.id, t]));
    const crops = await bestCropsFor(prisma, rows);
    const details = {
      queryKind: b.cropId ? 'crop' : image ? 'image' : 'text',
      queryText: text ?? null,
      queryCropId: b.cropId ?? null,
      imageSha256: image ? crypto.createHash('sha256').update(image).digest('hex') : null,
      imageBytes: image?.length ?? null,
      and: b.and ?? [],
      not: b.not ?? [],
      filters: f,
      modelSha256,
      mode: result.mode,
      resultCount: result.hits.length,
    };
    if (asksPersons) await recordSensitiveQuery(prisma, req, 'TRACK_PERSON_SEARCH_QUERY', details);
    else if (b.includePlates) await recordSensitiveQuery(prisma, req, 'TRACK_PLATE_SEARCH_QUERY', details);
    else await AuditChainService.record(prisma, { tenantId, userId: req.user!.id, action: 'TRACK_SEARCH_QUERY', resourceType: 'ObjectTrack', ipAddress: req.ip || '127.0.0.1', metadata: details });
    return res.json({
      modelSha256,
      mode: result.mode,
      candidatesScanned: result.candidatesScanned,
      tracksExcludedByNot: result.tracksExcludedByNot,
      results: result.hits
        .filter((h) => byId.has(h.trackDbId))
        .map((h) => ({
          score: h.score,
          matchedCropId: h.bestCropId,
          matchedCropImageUrl: `/api/v1/search/crops/${h.bestCropId}/image`,
          matchedCrops: h.matchedCrops,
          excludedCrops: h.excludedCrops,
          track: presentTrack(byId.get(h.trackDbId)!, crops, b.includePlates === true),
        })),
    });
  } catch (err) {
    return searchFail(res, err);
  }
});

router.get('/:id', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const includePlates = req.query.includePlates === 'true';
  const tenantId = req.user!.tenantId;
  const track = await prisma.objectTrack.findUnique({ where: { id: req.params.id }, include: trackInclude });
  if (!track || track.tenantId !== tenantId) return res.status(404).json({ error: 'track not found', code: 'TRACK_NOT_FOUND' });
  const isPerson = track.objectClass === 'person';
  if (isPerson && includePlates) return res.status(400).json({ error: 'a person track has no plate', code: 'SENSITIVE_CATEGORIES_SEPARATE' });
  if (isPerson && !(await sensitiveAccess(req, res, 'person'))) return;
  if (includePlates && !(await sensitiveAccess(req, res, 'plate'))) return;
  try {
    const details = { trackId: track.id, cameraId: track.cameraId, objectClass: track.objectClass };
    if (isPerson) await recordSensitiveQuery(prisma, req, 'TRACK_PERSON_VIEW', details);
    else if (includePlates) await recordSensitiveQuery(prisma, req, 'TRACK_PLATE_VIEW', details);
    else await AuditChainService.record(prisma, { tenantId, userId: req.user!.id, action: 'TRACK_VIEW', resourceType: 'ObjectTrack', resourceId: track.id, ipAddress: req.ip || '127.0.0.1', metadata: details });
    return res.json({ track: presentTrack(track, await bestCropsFor(prisma, [track]), includePlates) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
