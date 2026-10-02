import api from './api';

/**
 * Calls the investigation workspace makes: track list and search (Bucket 2), following and journeys (Bucket 3), and
 * sealing a journey as evidence. Person and plate data need a declared purpose: it travels as the
 * X-VigilOne-Purpose headers, and the backend refuses (and the page shows the refusal) when it is missing.
 */
export interface Purpose {
  purpose: string;
  reference?: string;
}

export interface TrackRecord {
  id: string;
  cameraId: string;
  trackId: string;
  objectClass: string;
  firstSeenAt: string;
  lastSeenAt: string;
  dwellSeconds: number;
  direction: string | null;
  path: Array<{ t: number; x: number; y: number }>;
  zones: Array<{ zoneId: string; name: string; enteredAt: string; exitedAt: string }>;
  colours: { upper: string | null; lower: string | null; body: string | null; monochromeDetections: number; namedDetections: number };
  bestCropId: string | null;
  plate: { linked: boolean } | { plate: string; stateCode: string | null } | null;
}

export interface SearchResult {
  score: number;
  matchedCropId: string;
  matchedCrops: number;
  excludedCrops: number;
  track: TrackRecord;
}

export interface Candidate {
  score: number;
  gapSeconds: number;
  decision: 'CONFIRMED' | 'REJECTED' | null;
  matchedCropId?: string;
  track: TrackRecord;
}

export interface Filters {
  cameraIds?: string[];
  from?: string;
  to?: string;
  objectClasses?: string[];
  direction?: string;
  upperColour?: string;
  lowerColour?: string;
  bodyColour?: string;
  minDwellSeconds?: number;
  hasPlate?: boolean;
}

const headers = (p?: Purpose | null) =>
  p?.purpose ? { 'x-vigilone-purpose': p.purpose, ...(p.reference ? { 'x-vigilone-purpose-reference': p.reference } : {}) } : {};

/** The backend's refusal as one line ("message (CODE)"), or the fallback. */
export const refusalText = (err: any, fallback: string): string => {
  const data = err?.response?.data;
  if (!data?.error) return err?.message || fallback;
  return data.code ? `${data.error} (${data.code})` : data.error;
};

export async function allowedPurposes(): Promise<{ allowed: string[]; needReference: string[] }> {
  const res = await api.get('/privacy/dpdp/purposes');
  return { allowed: res.data.allowed || [], needReference: res.data.needReference || [] };
}

/** Filters only, newest first (no embedding adapter needed). */
export async function listTracks(f: Filters, includePersons: boolean, p?: Purpose | null): Promise<TrackRecord[]> {
  const params: Record<string, string> = { limit: '50' };
  if (f.cameraIds?.length) params.cameraIds = f.cameraIds.join(',');
  if (f.from) params.from = f.from;
  if (f.to) params.to = f.to;
  if (f.objectClasses?.length) params.objectClasses = f.objectClasses.join(',');
  for (const k of ['direction', 'upperColour', 'lowerColour', 'bodyColour'] as const) if (f[k]) params[k] = f[k]!;
  if (f.minDwellSeconds !== undefined) params.minDwellSeconds = String(f.minDwellSeconds);
  if (f.hasPlate !== undefined) params.hasPlate = String(f.hasPlate);
  if (includePersons) params.includePersons = 'true';
  const res = await api.get('/tracks', { params, headers: headers(includePersons ? p : null) });
  return res.data.tracks;
}

export async function searchTracks(
  q: { text?: string; imageJpegBase64?: string; and?: string[]; not?: string[] },
  f: Filters,
  includePersons: boolean,
  p?: Purpose | null
): Promise<SearchResult[]> {
  const res = await api.post('/tracks/search', { ...q, filters: f, includePersons: includePersons || undefined, limit: 30 }, { headers: headers(includePersons ? p : null) });
  return res.data.results;
}

export async function candidates(trackId: string, method: 'appearance' | 'plate', p?: Purpose | null) {
  const res = await api.get(`/tracks/${trackId}/candidates`, { params: { method }, headers: headers(p) });
  return res.data as { adjacency?: string; outsideTravelTime?: number; readsWithoutTrack?: Array<{ cameraId: string; firstSeenAt: string }>; candidates: Candidate[] };
}

export async function decide(trackId: string, body: { toTrackId: string; method: 'APPEARANCE' | 'PLATE'; decision: 'CONFIRMED' | 'REJECTED' }, p?: Purpose | null) {
  const res = await api.post(`/tracks/${trackId}/links`, body, { headers: headers(p) });
  return res.data.link;
}

export async function journey(trackId: string, p?: Purpose | null) {
  const res = await api.get(`/tracks/${trackId}/journey`, { headers: headers(p) });
  return res.data as { steps: TrackRecord[]; cameras: string[]; links: unknown[]; truncated: boolean };
}

/** Seals the journey's cameras over its whole time span (plus a margin) as one evidence package. */
export async function sealJourney(steps: TrackRecord[], legalHold: boolean, note: string) {
  const start = Math.min(...steps.map((s) => Date.parse(s.firstSeenAt))) - 30_000;
  const end = Math.max(...steps.map((s) => Date.parse(s.lastSeenAt))) + 30_000;
  const res = await api.post('/evidence/manifests', {
    cameraIds: [...new Set(steps.map((s) => s.cameraId))],
    startUtc: new Date(start).toISOString(),
    endUtc: new Date(end).toISOString(),
    legalHold,
    notes: note,
  });
  return res.data as { id: string };
}

/** A crop picture as an object URL (the request carries the token, and the purpose for person crops). */
export async function cropImageUrl(cropId: string, p?: Purpose | null): Promise<string> {
  const res = await api.get(`/search/crops/${cropId}/image`, { responseType: 'blob', headers: headers(p) });
  return URL.createObjectURL(res.data);
}

export interface JourneyMapData {
  floorplans: Array<{
    id: string;
    name: string;
    floorLevel: number;
    cameras: Array<{ cameraId: string; name: string; x: number; y: number }>;
    points: Array<{ step: number; trackId: string; cameraId: string; x: number; y: number; firstSeenAt: string; lastSeenAt: string }>;
  }>;
  unplaced: Array<{ step: number; trackId: string; cameraId: string; cameraName: string }>;
}

/** The journey on the floor plans its cameras are placed on (each sighting at the position of its camera). */
export async function journeyFloorplan(trackId: string, p?: Purpose | null): Promise<JourneyMapData> {
  const res = await api.get(`/tracks/${trackId}/journey/floorplan`, { headers: headers(p) });
  return res.data;
}

/** Opens an incident (an alarm) from the journey; the server takes the journey from the confirmed links, not from here. */
export async function openJourneyIncident(
  trackId: string,
  body: { title: string; description?: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; evidenceManifestId?: string },
  p?: Purpose | null
) {
  const res = await api.post(`/tracks/${trackId}/journey/incident`, body, { headers: headers(p) });
  return res.data as { alarm: { id: string }; holds: number; windowStart: string; windowEnd: string };
}
