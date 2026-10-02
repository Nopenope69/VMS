/**
 * How a track is shown by the API (the track list, one track, and track search). Plate text is included only when
 * the caller passed the plate purpose gate; otherwise the track says only whether a plate is linked.
 */
import { Prisma, PrismaClient } from '@prisma/client';

export const trackInclude = { vehicleObservation: { select: { id: true, normalizedPlate: true, stateCode: true, plateFormat: true, bestConfidence: true } } } as const;
export type TrackWithPlate = Prisma.ObjectTrackGetPayload<{ include: typeof trackInclude }>;

export function presentTrack(t: TrackWithPlate, cropByDetection: Map<string, string>, includePlates: boolean) {
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

/** The crop of each track's best detection, if the crop store kept one: detection id -> crop id. */
export async function bestCropsFor(prisma: PrismaClient, tracks: Array<{ bestDetectionId: string | null }>): Promise<Map<string, string>> {
  const ids = tracks.map((t) => t.bestDetectionId).filter((v): v is string => !!v);
  if (ids.length === 0) return new Map();
  const crops = await prisma.objectCrop.findMany({ where: { detectionEventId: { in: ids } }, select: { id: true, detectionEventId: true } });
  return new Map(crops.map((c) => [c.detectionEventId!, c.id]));
}
