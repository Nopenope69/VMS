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

const trackInclude = { vehicleObservation: { select: { id: true, normalizedPlate: true, stateCode: true, plateFormat: true, bestConfidence: true } } } as const;
type TrackWithPlate = Prisma.ObjectTrackGetPayload<{ include: typeof trackInclude }>;

function present(t: TrackWithPlate, cropByDetection: Map<string, string>, includePlates: boolean) {
  const votes = t.colourVotesJson as any;
  const named = ['upper', 'lower', 'body'].reduce((n, k) => n + Object.values((votes?.[k] || {}) as Record<string, number>).reduce((a, b) => a + b, 0), 0);
  return {
    id: t.id,
    cameraId: t.cameraId,
    trackId: t.trackId,
    objectClass: t.objectClass,
    firstSeenAt: t.firstSeenAt,
    lastSeenAt: t.lastSeenAt,
    dwellSeconds: t.dwellSeconds,
    observationCount: t.observationCount,
    maxConfidence: t.maxConfidence,
    direction: t.direction,
    path: t.pathJson,
    zones: t.zonesJson,
    colours: { upper: t.upperColour, lower: t.lowerColour, body: t.bodyColour, monochromeDetections: votes?.monochrome ?? 0, namedDetections: named },
    bestDetectionId: t.bestDetectionId,
    bestCropId: t.bestDetectionId ? cropByDetection.get(t.bestDetectionId) ?? null : null,
    plate: includePlates
      ? t.vehicleObservation
        ? { vehicleObservationId: t.vehicleObservation.id, plate: t.vehicleObservation.normalizedPlate, stateCode: t.vehicleObservation.stateCode, format: t.vehicleObservation.plateFormat, confidence: t.vehicleObservation.bestConfidence }
        : null
      : { linked: t.vehicleObservationId !== null },
    modelSha256: t.modelSha256,
  };
}

async function cropsFor(tracks: TrackWithPlate[]): Promise<Map<string, string>> {
  const ids = tracks.map((t) => t.bestDetectionId).filter((v): v is string => !!v);
  if (ids.length === 0) return new Map();
  const crops = await prisma.objectCrop.findMany({ where: { detectionEventId: { in: ids } }, select: { id: true, detectionEventId: true } });
  return new Map(crops.map((c) => [c.detectionEventId!, c.id]));
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
    const crops = await cropsFor(tracks);
    const details = {
      filters: { ...q, purpose: undefined, purposeReference: undefined },
      resultCount: tracks.length,
    };
    if (asksPersons) await recordSensitiveQuery(prisma, req, 'TRACK_PERSON_QUERY', details);
    else if (q.includePlates) await recordSensitiveQuery(prisma, req, 'TRACK_PLATE_QUERY', details);
    else await AuditChainService.record(prisma, { tenantId, userId: req.user!.id, action: 'TRACK_QUERY', resourceType: 'ObjectTrack', ipAddress: req.ip || '127.0.0.1', metadata: details });
    return res.json({ tracks: tracks.map((t) => present(t, crops, q.includePlates === true)), limit, offset: q.offset ?? 0 });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
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
    return res.json({ track: present(track, await cropsFor([track]), includePlates) });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
