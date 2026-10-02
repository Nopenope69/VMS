import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { authorize, hasPermission, Permission } from '../services/rbac/permissions';
import { Role } from '@prisma/client';
import { AuditChainService } from '../services/audit/auditChain.service';
import { recordSensitiveQuery, requirePurpose } from '../services/privacy/dataProtection.service';
import { CropStore } from '../services/crops/cropStore';
import { cropsRoot } from '../services/crops/cropCapture.service';
import { EMBEDDING_DIM, EmbeddingError, MAX_RESULTS, searchSimilar, searchSimilarToCrop, SearchFilters } from '../services/search/cropEmbeddingStore';
import { EmbeddingAdapterClient, EmbeddingResult } from '../services/search/embeddingAdapterClient';
import { defaultQueryEmbedder } from '../services/search/queryEmbedder';

/** Embeds query text with the verified embedding adapter; null when no adapter is configured. */
export type TextEmbedder = (text: string) => Promise<EmbeddingResult>;
const MAX_QUERY_TEXT = 512;

function defaultTextEmbedder(): TextEmbedder | null {
  const q = defaultQueryEmbedder();
  return q ? q.text : null;
}
let textEmbedderOverride: TextEmbedder | null | undefined;
/** Test hook: replace (or with null, remove) the text embedder. undefined restores the default. */
export function setTextEmbedderForTests(fn: TextEmbedder | null | undefined) {
  textEmbedderOverride = fn;
}
const textEmbedder = (): TextEmbedder | null => (textEmbedderOverride !== undefined ? textEmbedderOverride : defaultTextEmbedder());

/**
 * /api/v1/search/crops, behind VIGILONE_FEATURE_SEMANTIC_SEARCH (app.ts) and the ADVANCED_SEARCH licence.
 *
 *  - Query by example (a stored crop `cropId` or a raw vector `embedding`) or by `text`. A text query is
 *    embedded by the embedding adapter's text tower (the same model that embeds crops, so the vectors are
 *    comparable); without EMBEDDING_ADAPTER_URL it is refused with 501 TEXT_QUERY_NOT_AVAILABLE, and if the
 *    adapter is down or serves an unregistered model it is 503, never a guess. Text matching people is
 *    person access like any other: it needs the person permission and a purpose, and the text is audited.
 *  - Non-person crops need SEARCH_VIEW. Anything involving PERSON crops (asking for them, using one as the
 *    example, or viewing one) also needs CROP_PERSON_QUERY and a declared, allowed purpose, and is written
 *    to the audit chain with that purpose (DPDP: appearance search over people behaves like profiling).
 *  - Results are always scoped to the caller's tenant and to a single embedding model.
 */
const router = Router();
router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('ADVANCED_SEARCH'));

const purposeGate = requirePurpose(prisma, 'BIOMETRIC');
/** Person data needs the permission and a purpose. Sends the error response itself and returns false when refused. */
async function personAccess(req: Request, res: Response): Promise<boolean> {
  if (!hasPermission(req.user!.role as Role, Permission.CROP_PERSON_QUERY)) {
    res.status(403).json({ error: `Forbidden: person crops need the '${Permission.CROP_PERSON_QUERY}' permission`, code: 'PERSON_CROP_FORBIDDEN' });
    return false;
  }
  let passed = false;
  await purposeGate(req, res, () => {
    passed = true;
  });
  return passed;
}

const iso = z.string().refine((v) => Number.isFinite(Date.parse(v)), 'must be a date-time');
const Body = z
  .object({
    cropId: z.string().min(1).max(128).optional(),
    embedding: z.array(z.number()).length(EMBEDDING_DIM).optional(),
    text: z.string().optional(),
    modelSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    cameraIds: z.array(z.string().min(1)).max(100).optional(),
    from: iso.optional(),
    to: iso.optional(),
    objectClasses: z.array(z.string().min(1)).max(20).optional(),
    includePersons: z.boolean().optional(),
    personsOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_RESULTS).optional(),
    minScore: z.number().min(-1).max(1).optional(),
    exact: z.boolean().optional(),
  })
  .strict();

const fail = (res: Response, err: any) => {
  if (err instanceof EmbeddingError) {
    const unavailable = ['EMBEDDING_ADAPTER_UNAVAILABLE', 'EMBEDDING_ADAPTER_INVALID', 'EMBEDDING_MODEL_NOT_REGISTERED'].includes(err.code);
    const status = unavailable ? 503 : err.code === 'EMBEDDING_NOT_FOUND' || err.code === 'EMBEDDING_CROP_NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: err.message });
};

router.post('/', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const p = Body.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: `${p.error.issues[0].path.join('.') || 'body'}: ${p.error.issues[0].message}`, code: 'INVALID_SEARCH' });
  const b = p.data;
  if ((b.cropId ? 1 : 0) + (b.embedding ? 1 : 0) + (b.text !== undefined ? 1 : 0) !== 1) return res.status(400).json({ error: 'give exactly one of cropId, embedding or text', code: 'INVALID_SEARCH' });
  const queryText = b.text?.trim();
  if (b.text !== undefined && (!queryText || queryText.length > MAX_QUERY_TEXT)) return res.status(400).json({ error: `text must be 1 to ${MAX_QUERY_TEXT} characters and not blank`, code: 'INVALID_SEARCH' });
  const tenantId = req.user!.tenantId;
  try {
    let queryVector: Float32Array | undefined;
    let modelSha256 = b.modelSha256;
    if (queryText) {
      const embed = textEmbedder();
      if (!embed) return res.status(501).json({ error: 'Text queries need the embedding adapter (EMBEDDING_ADAPTER_URL is not set). Search by example (cropId or embedding).', code: 'TEXT_QUERY_NOT_AVAILABLE' });
      // The text is matched against the model that embedded it; asking for another model's vectors cannot work.
      // (Person access is checked below, before anything is answered, so this does not reveal person data.)
      const r = await embed(queryText);
      if (modelSha256 && modelSha256 !== r.model.sha256) return res.status(409).json({ error: `the text encoder serves model ${r.model.sha256}, not the requested ${modelSha256}`, code: 'TEXT_MODEL_MISMATCH' });
      modelSha256 = r.model.sha256;
      queryVector = r.vector;
    }
    // Which model: the caller's choice, else the most recently used one for this tenant.
    if (!modelSha256) {
      const last = await prisma.cropEmbedding.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { modelSha256: true } });
      if (!last) return res.status(404).json({ error: 'no crop has been embedded yet', code: 'NO_EMBEDDINGS' });
      modelSha256 = last.modelSha256;
    }
    let queryIsPerson = false;
    if (b.cropId) {
      const c = await prisma.objectCrop.findUnique({ where: { id: b.cropId }, select: { tenantId: true, cropClass: true } });
      if (!c || c.tenantId !== tenantId) return res.status(404).json({ error: 'crop not found', code: 'EMBEDDING_CROP_NOT_FOUND' });
      queryIsPerson = c.cropClass === 'PERSON';
    }
    const wantsPersons = b.includePersons === true || b.personsOnly === true || queryIsPerson;
    if (queryIsPerson && b.includePersons !== true) return res.status(400).json({ error: 'the example crop is a person crop; set includePersons: true (and declare a purpose)', code: 'PERSON_QUERY_REQUIRES_INCLUDE' });
    if (wantsPersons && !(await personAccess(req, res))) return;

    const filters: SearchFilters = {
      tenantId,
      modelSha256,
      cameraIds: b.cameraIds,
      from: b.from ? new Date(b.from) : undefined,
      to: b.to ? new Date(b.to) : undefined,
      objectClasses: b.objectClasses,
      includePersons: b.includePersons,
      personsOnly: b.personsOnly,
      limit: b.limit,
      minScore: b.minScore,
      exact: b.exact,
    };
    const result = b.cropId ? await searchSimilarToCrop(prisma, b.cropId, filters) : await searchSimilar(prisma, queryVector ?? Float32Array.from(b.embedding!), filters);
    const model = await prisma.cropEmbedding.findFirst({ where: { tenantId, modelSha256 }, select: { modelName: true, modelVersion: true, modelSha256: true } });
    const details = {
      queryKind: b.cropId ? 'crop' : queryText ? 'text' : 'vector',
      queryCropId: b.cropId ?? null,
      queryText: queryText ?? null,
      modelSha256,
      mode: result.mode,
      filters: { cameraIds: b.cameraIds ?? null, from: b.from ?? null, to: b.to ?? null, objectClasses: b.objectClasses ?? null, includePersons: b.includePersons === true, personsOnly: b.personsOnly === true, minScore: b.minScore ?? null },
      resultCount: result.hits.length,
    };
    // The audit entry is written before the answer is sent; if it cannot be written, nothing is returned.
    if (wantsPersons) await recordSensitiveQuery(prisma, req, 'CROP_PERSON_SEARCH_QUERY', details);
    else await AuditChainService.record(prisma, { tenantId, userId: req.user!.id, action: 'CROP_SEARCH_QUERY', resourceType: 'ObjectCrop', ipAddress: req.ip || '127.0.0.1', metadata: details });
    return res.json({
      model: model ? { name: model.modelName, version: model.modelVersion, sha256: model.modelSha256 } : { sha256: modelSha256 },
      mode: result.mode,
      hits: result.hits.map((h) => ({ ...h, imageUrl: `/api/v1/search/crops/${h.cropId}/image` })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

/** The crop image, with its stored hash checked. Person crops need the person permission and a purpose, and are audited. */
router.get('/:cropId/image', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  try {
    const crop = await prisma.objectCrop.findUnique({ where: { id: req.params.cropId } });
    if (!crop || crop.tenantId !== req.user!.tenantId) return res.status(404).json({ error: 'crop not found', code: 'CROP_NOT_FOUND' });
    if (crop.cropClass === 'PERSON') {
      if (!(await personAccess(req, res))) return;
      await recordSensitiveQuery(prisma, req, 'CROP_PERSON_IMAGE_VIEW', { cropId: crop.id, cameraId: crop.cameraId });
    }
    let bytes: Buffer | null;
    try {
      bytes = new CropStore(cropsRoot()).readVerified(crop.relativePath, crop.sha256);
    } catch (e: any) {
      console.error(`[CropSearch] crop ${crop.id} failed its integrity check: ${e?.message || e}`);
      return res.status(500).json({ error: 'the stored crop does not match its recorded hash', code: 'CROP_INTEGRITY_FAILED' });
    }
    if (!bytes) return res.status(404).json({ error: 'the crop file is gone (retention or removal)', code: 'CROP_FILE_MISSING' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.end(bytes);
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
