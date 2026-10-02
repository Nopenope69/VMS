import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { loadTenantLicense, requireFeature } from '../middleware/license';
import { sensitiveAccess } from '../middleware/sensitiveAccess';
import { authorize, Permission } from '../services/rbac/permissions';
import { AuditChainService } from '../services/audit/auditChain.service';
import { recordSensitiveQuery } from '../services/privacy/dataProtection.service';
import { FeatureFlag, isFeatureEnabled } from '../config/featureFlags';
import { FollowError, TrackFollowService } from '../services/tracks/trackFollow.service';
import { bestCropsFor, presentTrack, trackInclude } from '../services/tracks/trackPresenter';
import { journeyMap, openJourneyIncident } from '../services/tracks/journeyIncident';

/**
 * Cross-camera following (feature TRACK_INDEX; appearance candidates also need SEMANTIC_SEARCH). Mounted at
 * /api/v1/tracks before the track routes, so /camera-neighbours is not read as a track id.
 *
 * Privacy: following a person is person data (CROP_PERSON_QUERY and a purpose); following by plate is plate data
 * (PLATE_DATA_QUERY and a purpose). Every candidate query, decision and journey view is audited before the answer
 * is sent. Plate text is shown only with includePlates and the plate purpose.
 */
const router = Router();
router.use(requireAuth);
router.use(loadTenantLicense);
router.use(requireFeature('ADVANCED_SEARCH'));
const svc = new TrackFollowService(prisma);

const fail = (res: Response, err: any) => {
  if (err instanceof FollowError) return res.status(err.status).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: err.message });
};
const invalid = (res: Response, e: z.ZodError) => res.status(400).json({ error: `${e.issues[0].path.join('.') || 'body'}: ${e.issues[0].message}`, code: 'INVALID_FOLLOW_REQUEST' });
const audit = (req: Request, action: string, metadata: Record<string, unknown>) =>
  AuditChainService.record(prisma, { tenantId: req.user!.tenantId, userId: req.user!.id, action, resourceType: 'ObjectTrack', ipAddress: req.ip || '127.0.0.1', metadata });

/** Person data or plate data gate for a track; returns the category, or null when the response was already sent. */
async function gateFor(req: Request, res: Response, isPerson: boolean, plate: boolean): Promise<'person' | 'plate' | 'none' | null> {
  if (isPerson) return (await sensitiveAccess(req, res, 'person')) ? 'person' : null;
  if (plate) return (await sensitiveAccess(req, res, 'plate')) ? 'plate' : null;
  return 'none';
}
async function record(req: Request, kind: 'person' | 'plate' | 'none', action: string, details: Record<string, unknown>) {
  if (kind === 'none') await audit(req, action, details);
  else await recordSensitiveQuery(prisma, req, action, details);
}

async function present(ids: string[], tenantId: string, includePlates: boolean) {
  const rows = await prisma.objectTrack.findMany({ where: { tenantId, id: { in: ids } }, include: trackInclude });
  const crops = await bestCropsFor(prisma, rows);
  return new Map(rows.map((t) => [t.id, presentTrack(t, crops, includePlates)]));
}

// ------------------------------------------------------------------ camera neighbours

const Neighbours = z
  .object({
    neighbours: z
      .array(
        z
          .object({
            cameraAId: z.string().min(1),
            cameraBId: z.string().min(1),
            minTransitSeconds: z.number().int().min(0).max(86_400).default(0),
            maxTransitSeconds: z.number().int().min(0).max(86_400).default(120),
          })
          .strict()
      )
      .max(500),
  })
  .strict();

router.get('/camera-neighbours', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  try {
    return res.json({ neighbours: await svc.listNeighbours(req.user!.tenantId) });
  } catch (err) {
    return fail(res, err);
  }
});

router.put('/camera-neighbours', authorize(Permission.CAMERA_CONFIG), async (req: Request, res: Response) => {
  const p = Neighbours.safeParse(req.body);
  if (!p.success) return invalid(res, p.error);
  try {
    const list = await svc.setNeighbours(req.user!.tenantId, req.user!.id, p.data.neighbours);
    await audit(req, 'CAMERA_NEIGHBOURS_SET', { count: list.length, neighbours: list.map((n) => ({ a: n.cameraAId, b: n.cameraBId, min: n.minTransitSeconds, max: n.maxTransitSeconds })) });
    return res.json({ neighbours: list });
  } catch (err) {
    return fail(res, err);
  }
});

// ------------------------------------------------------------------ candidates

const CandidateQuery = z
  .object({
    method: z.enum(['appearance', 'plate']),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    windowSeconds: z.coerce.number().int().min(60).max(7 * 86_400).optional(),
    includePlates: z.enum(['true', 'false']).optional(),
    purpose: z.string().optional(),
    purposeReference: z.string().optional(),
  })
  .strict();

router.get('/:id/candidates', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const p = CandidateQuery.safeParse(req.query);
  if (!p.success) return invalid(res, p.error);
  const q = p.data;
  const tenantId = req.user!.tenantId;
  try {
    const source = await svc.track(tenantId, req.params.id);
    const isPerson = source.objectClass === 'person';
    if (q.method === 'plate' && isPerson) return res.status(400).json({ error: 'a person track has no plate', code: 'NO_PLATE' });
    if (q.method === 'appearance' && !isFeatureEnabled(FeatureFlag.SEMANTIC_SEARCH)) {
      return res.status(501).json({ error: 'following by appearance needs the semantic search feature (VIGILONE_FEATURE_SEMANTIC_SEARCH)', code: 'FEATURE_DISABLED', feature: FeatureFlag.SEMANTIC_SEARCH });
    }
    const kind = await gateFor(req, res, isPerson, q.method === 'plate' || q.includePlates === 'true');
    if (!kind) return;
    const r = q.method === 'plate' ? await svc.plateCandidates(tenantId, source.id, { windowSeconds: q.windowSeconds }) : await svc.appearanceCandidates(tenantId, source.id, { limit: q.limit });
    const shown = await present(r.candidates.map((c) => c.trackDbId), tenantId, kind === 'plate' && q.includePlates === 'true');
    await record(req, kind, 'TRACK_FOLLOW_QUERY', { sourceTrackId: source.id, method: q.method, candidates: r.candidates.length, ...('adjacency' in r ? { adjacency: r.adjacency } : {}) });
    return res.json({
      source: (await present([source.id], tenantId, kind === 'plate' && q.includePlates === 'true')).get(source.id),
      method: q.method,
      ...('adjacency' in r ? { adjacency: r.adjacency, modelSha256: r.modelSha256, sourceCrops: r.sourceCrops, outsideTravelTime: r.outsideTravelTime } : {}),
      ...('readsWithoutTrack' in r ? { readsWithoutTrack: r.readsWithoutTrack } : {}),
      candidates: r.candidates
        .filter((c) => shown.has(c.trackDbId))
        .map((c) => ({ score: c.score, gapSeconds: c.gapSeconds, decision: c.decision, ...('matchedCropId' in c ? { matchedCropId: c.matchedCropId } : {}), track: shown.get(c.trackDbId) })),
    });
  } catch (err) {
    return fail(res, err);
  }
});

// ------------------------------------------------------------------ decisions

const Decision = z
  .object({
    toTrackId: z.string().min(1),
    method: z.enum(['PLATE', 'APPEARANCE']),
    decision: z.enum(['CONFIRMED', 'REJECTED']),
    note: z.string().max(500).optional(),
  })
  .strict();

router.post('/:id/links', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  const p = Decision.safeParse(req.body);
  if (!p.success) return invalid(res, p.error);
  const tenantId = req.user!.tenantId;
  try {
    const source = await svc.track(tenantId, req.params.id);
    const kind = await gateFor(req, res, source.objectClass === 'person', p.data.method === 'PLATE');
    if (!kind) return;
    const link = await svc.decide(tenantId, req.user!.id, source.id, p.data);
    await record(req, kind, `TRACK_LINK_${p.data.decision}`, { linkId: link.id, fromTrackId: link.fromTrackId, toTrackId: link.toTrackId, method: link.method, evidence: link.evidenceJson, note: link.note });
    return res.json({ link });
  } catch (err) {
    return fail(res, err);
  }
});

// ------------------------------------------------------------------ journey

/** The journey from a track, after the person or plate gate; null when the gate already answered. */
async function gatedJourney(req: Request, res: Response, includePlates: boolean) {
  const tenantId = req.user!.tenantId;
  const start = await svc.track(tenantId, req.params.id);
  const kind = await gateFor(req, res, start.objectClass === 'person', includePlates);
  if (!kind) return null;
  const j = await svc.journey(tenantId, start.id);
  const shown = await present(j.trackIds, tenantId, kind === 'plate');
  const steps = [...shown.values()].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
  return { start, kind, j, steps };
}

router.get('/:id/journey', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  try {
    const g = await gatedJourney(req, res, req.query.includePlates === 'true');
    if (!g) return;
    await record(req, g.kind, 'TRACK_JOURNEY_VIEW', { trackId: g.start.id, tracks: g.steps.length, links: g.j.links.length });
    return res.json({ trackId: g.start.id, truncated: g.j.truncated, cameras: g.steps.map((s) => s.cameraId), steps: g.steps, links: g.j.links });
  } catch (err) {
    return fail(res, err);
  }
});

/** The journey on the floor plans its cameras are placed on (camera positions, not the object's own position). */
router.get('/:id/journey/floorplan', authorize(Permission.SEARCH_VIEW), async (req: Request, res: Response) => {
  try {
    const g = await gatedJourney(req, res, false);
    if (!g) return;
    const map = await journeyMap(prisma, req.user!.tenantId, g.steps);
    await record(req, g.kind, 'TRACK_JOURNEY_MAP_VIEW', { trackId: g.start.id, tracks: g.steps.length, floorplans: map.floorplans.map((f) => f.id), unplaced: map.unplaced.length });
    return res.json({ trackId: g.start.id, truncated: g.j.truncated, ...map });
  } catch (err) {
    return fail(res, err);
  }
});

const Incident = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('WARNING'),
    evidenceManifestId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Opens an incident (an alarm) from the confirmed journey, computed here from the stored links, never from a list
 * the client sends. Every camera of the journey gets an evidence hold over the whole journey.
 */
router.post('/:id/journey/incident', authorize(Permission.SEARCH_VIEW), authorize(Permission.ALARM_MANAGE), async (req: Request, res: Response) => {
  const p = Incident.safeParse(req.body);
  if (!p.success) return invalid(res, p.error);
  try {
    const g = await gatedJourney(req, res, false);
    if (!g) return;
    const out = await openJourneyIncident(
      prisma,
      { tenantId: req.user!.tenantId, userId: req.user!.id, clientIp: req.ip, userAgent: req.get('user-agent') },
      g.start.id,
      g.steps,
      g.j.links.map((l) => l.id),
      p.data
    );
    await record(req, g.kind, 'TRACK_JOURNEY_INCIDENT', { trackId: g.start.id, alarmId: out.alarm.id, tracks: g.steps.length, cameras: out.holds, evidenceManifestId: p.data.evidenceManifestId ?? null });
    return res.status(201).json({ alarm: out.alarm, holds: out.holds, windowStart: out.windowStart, windowEnd: out.windowEnd, truncated: g.j.truncated });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
