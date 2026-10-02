import { EventSeverity, PrismaClient } from '@prisma/client';
import { incidentOrchestrator } from '../incident/orchestrator/incidentOrchestrator.service';
import { workflowConfigFromEnv } from '../incident/workflow/alarmWorkflow.service';
import { FollowError } from './trackFollow.service';

/**
 * A confirmed journey on the floor plan, and a journey turned into an incident (North Star Bucket 4).
 *
 * Map: each sighting is drawn at the position of the camera that saw it, in the floor plan's drawing coordinates.
 * It is not the person's or vehicle's own position on the floor: projecting the picture onto the floor plan needs a
 * calibrated camera, which is not built. A camera with no placement is listed as unplaced, never guessed.
 *
 * Incident: an alarm (the incident workflow is built on alarms) on the first sighting's camera, with the journey's
 * tracks, cameras and times in its metadata (never plate text), and an evidence hold on every camera of the journey
 * over the whole journey, so retention cannot delete the footage. The alarm sweeper pins the segments.
 */
export interface JourneyStep {
  id: string;
  cameraId: string;
  objectClass: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface JourneyMapPoint {
  step: number;
  trackId: string;
  cameraId: string;
  x: number;
  y: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface JourneyMap {
  floorplans: Array<{ id: string; name: string; floorLevel: number; cameras: Array<{ cameraId: string; name: string; x: number; y: number }>; points: JourneyMapPoint[] }>;
  unplaced: Array<{ step: number; trackId: string; cameraId: string; cameraName: string }>;
}

/** Steps (in time order) on the floor plans their cameras are placed on. Steps are numbered from 1 over the whole journey. */
export function layoutJourney(
  steps: JourneyStep[],
  placements: Array<{ cameraId: string; cameraName: string; floorplanId: string; floorplanName: string; floorLevel: number; x: number; y: number }>,
  cameraNames: Map<string, string>
): JourneyMap {
  const byCamera = new Map(placements.map((p) => [p.cameraId, p]));
  const plans = new Map<string, JourneyMap['floorplans'][number]>();
  const unplaced: JourneyMap['unplaced'] = [];
  steps.forEach((s, i) => {
    const p = byCamera.get(s.cameraId);
    if (!p) {
      unplaced.push({ step: i + 1, trackId: s.id, cameraId: s.cameraId, cameraName: cameraNames.get(s.cameraId) ?? s.cameraId });
      return;
    }
    let plan = plans.get(p.floorplanId);
    if (!plan) {
      plan = { id: p.floorplanId, name: p.floorplanName, floorLevel: p.floorLevel, cameras: [], points: [] };
      plans.set(p.floorplanId, plan);
    }
    plan.points.push({ step: i + 1, trackId: s.id, cameraId: s.cameraId, x: p.x, y: p.y, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt });
  });
  // Every placed camera of each plan the journey touches, so the drawing shows the cameras it did not pass too.
  for (const p of placements) plans.get(p.floorplanId)?.cameras.push({ cameraId: p.cameraId, name: p.cameraName, x: p.x, y: p.y });
  return { floorplans: [...plans.values()], unplaced };
}

export async function journeyMap(prisma: PrismaClient, tenantId: string, steps: JourneyStep[]): Promise<JourneyMap> {
  const cameraIds = [...new Set(steps.map((s) => s.cameraId))];
  const own = await prisma.cameraSpatialPlacement.findMany({
    where: { cameraId: { in: cameraIds }, floorplan: { tenantId } },
    select: { floorplanId: true },
  });
  const planIds = [...new Set(own.map((p) => p.floorplanId))];
  const rows = await prisma.cameraSpatialPlacement.findMany({
    where: { floorplanId: { in: planIds }, floorplan: { tenantId } },
    include: { camera: { select: { name: true } }, floorplan: { select: { name: true, floorLevel: true } } },
    orderBy: { cameraId: 'asc' },
  });
  const cams = await prisma.camera.findMany({ where: { tenantId, id: { in: cameraIds } }, select: { id: true, name: true } });
  return layoutJourney(
    steps,
    rows.map((r) => ({ cameraId: r.cameraId, cameraName: r.camera.name, floorplanId: r.floorplanId, floorplanName: r.floorplan.name, floorLevel: r.floorplan.floorLevel, x: r.x, y: r.y })),
    new Map(cams.map((c) => [c.id, c.name]))
  );
}

export interface JourneyIncidentInput {
  title: string;
  description?: string;
  severity: EventSeverity;
  evidenceManifestId?: string;
}

export async function openJourneyIncident(
  prisma: PrismaClient,
  ctx: { tenantId: string; userId: string; clientIp?: string; userAgent?: string },
  startTrackId: string,
  steps: JourneyStep[],
  linkIds: string[],
  input: JourneyIncidentInput,
  now = new Date()
) {
  if (!steps.length) throw new FollowError(400, 'EMPTY_JOURNEY', 'The journey has no sightings');
  if (input.evidenceManifestId) {
    const m = await prisma.evidenceManifest.findFirst({ where: { id: input.evidenceManifestId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!m) throw new FollowError(404, 'EVIDENCE_MANIFEST_NOT_FOUND', 'Evidence package not found');
  }
  const cfg = workflowConfigFromEnv();
  const cameraIds = [...new Set(steps.map((s) => s.cameraId))];
  const first = Math.min(...steps.map((s) => s.firstSeenAt.getTime()));
  const last = Math.max(...steps.map((s) => s.lastSeenAt.getTime()));
  const windowStart = new Date(first - cfg.holdPreSeconds * 1000);
  const windowEnd = new Date(last + cfg.holdPostSeconds * 1000);

  const alarm = await incidentOrchestrator.elevateAlarm(
    {
      tenantId: ctx.tenantId,
      cameraId: steps[0].cameraId,
      title: input.title,
      description: input.description,
      severity: input.severity,
      metadataJson: {
        source: 'JOURNEY',
        startTrackId,
        objectClass: steps[0].objectClass,
        steps: steps.map((s) => ({ trackId: s.id, cameraId: s.cameraId, firstSeenAt: s.firstSeenAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString() })),
        cameraIds,
        linkIds,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        evidenceManifestId: input.evidenceManifestId ?? null,
      },
    },
    { tenantId: ctx.tenantId, actorUserId: ctx.userId, clientIp: ctx.clientIp, userAgent: ctx.userAgent }
  );

  // The alarm is committed; if the holds cannot be written the caller is told, with the alarm id, rather than
  // being shown an incident whose footage is not protected.
  try {
    await prisma.incidentEvidenceHold.createMany({
      data: cameraIds.map((cameraId) => ({
        tenantId: ctx.tenantId,
        alarmId: alarm.id,
        cameraId,
        windowStart,
        windowEnd,
        expiresAt: new Date(now.getTime() + cfg.holdDays * 86_400_000),
        status: 'PENDING',
      })),
      skipDuplicates: true,
    });
  } catch (e: any) {
    throw new FollowError(500, 'JOURNEY_HOLDS_FAILED', `Incident ${alarm.id} was opened but its evidence holds could not be written: ${e.message}`);
  }
  return { alarm, holds: cameraIds.length, windowStart, windowEnd };
}
