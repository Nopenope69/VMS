/**
 * Scores the plain-language search parser on labelled requests (backend/src/__tests__/fixtures/nl-search/*.json).
 * Used by the unit test (rules only) and by scripts/eval/nl-search.ts (rules, with a local model rewriting the
 * requests the word list cannot read). Expected times are local wall-clock times at the site, "YYYY-MM-DDTHH:MM".
 */
import { mergeWithRewrite, ParseContext, ParsedQuery, parseSearchRequest } from './queryParser';

export interface LabelledSet {
  now: string;
  cameras: string[];
  zones: string[];
  cases: Array<{ q: string; e: Record<string, unknown> }>;
}

export interface EvalResult {
  cases: number;
  fullyRight: number;
  fieldAccuracy: number;
  rewrites: number;
  misses: Array<{ q: string; read: string; wrong: string[] }>;
}

const FIELDS = ['cameras', 'unknownCameras', 'zone', 'objectClasses', 'upperColour', 'lowerColour', 'bodyColour', 'direction', 'minDwellSeconds', 'hasPlate', 'from', 'to', 'and', 'not'];
const TZ = 'Asia/Kolkata';

/** "2026-10-04T15:30" at the site (Asia/Kolkata, +05:30) to a Date. */
const local = (s: string) => new Date(`${s}:00+05:30`);
const sortedLower = (a: unknown) => JSON.stringify(((a as string[]) || []).map((s) => String(s).toLowerCase().trim()).sort());

export function contextFor(set: LabelledSet): ParseContext {
  return {
    cameras: set.cameras.map((name, i) => ({ id: `cam-${i}`, name })),
    zones: set.zones.map((name, i) => ({ id: `zone-${i}`, name, cameraId: 'cam-0' })),
    now: local(set.now),
    timeZone: TZ,
  };
}

/** The parser's answer in the labelled sets' vocabulary (names, local times). */
export function asLabelled(p: ParsedQuery, ctx: ParseContext): Record<string, unknown> {
  const f = p.filters;
  const name = (id: string, list: Array<{ id: string; name: string }>) => list.find((x) => x.id === id)?.name;
  const toLocal = (iso?: string) => {
    if (!iso) return undefined;
    const d = new Date(new Date(iso).getTime() + 330 * 60_000);
    return d.toISOString().slice(0, 16);
  };
  return {
    cameras: f.cameraIds?.map((id) => name(id, ctx.cameras)),
    unknownCameras: p.unknownPlaces.length ? p.unknownPlaces : undefined,
    zone: f.zoneId ? name(f.zoneId, ctx.zones) : undefined,
    objectClasses: f.objectClasses,
    upperColour: f.upperColour,
    lowerColour: f.lowerColour,
    bodyColour: f.bodyColour,
    direction: f.direction,
    minDwellSeconds: f.minDwellSeconds,
    hasPlate: f.hasPlate,
    from: toLocal(f.from),
    to: toLocal(f.to),
    and: p.and.length ? p.and : undefined,
    not: p.not.length ? p.not : undefined,
  };
}

function fieldOk(f: string, got: Record<string, unknown>, exp: Record<string, unknown>): boolean {
  const g = got[f];
  const e = exp[f];
  if (['cameras', 'objectClasses', 'unknownCameras'].includes(f)) return sortedLower(g) === sortedLower(e);
  if (f === 'and' || f === 'not') {
    const gs = ((g as string[]) || []).map((x) => x.toLowerCase());
    const es = (e as string[]) || [];
    return es.length === gs.length && es.every((x) => gs.some((y) => y.includes(x.toLowerCase())));
  }
  return (g ?? null) === (e ?? null);
}

/**
 * Scores a set. `rewrite`, when given, is asked for an English version of each request the word list leaves
 * unreadable (ParsedQuery.needsRewrite); the rules then read that.
 */
export async function evaluate(set: LabelledSet, rewrite?: (q: string) => Promise<string>): Promise<EvalResult> {
  const ctx = contextFor(set);
  let right = 0;
  let total = 0;
  let fully = 0;
  let rewrites = 0;
  const misses: EvalResult['misses'] = [];
  for (const c of set.cases) {
    let p = parseSearchRequest(c.q, ctx);
    let read = p.normalised;
    if (rewrite && p.needsRewrite) {
      const en = await rewrite(c.q);
      rewrites++;
      p = mergeWithRewrite(p, parseSearchRequest(en, ctx));
      read = `${en} (rewritten)`;
    }
    const got = asLabelled(p, ctx);
    const wrong: string[] = [];
    for (const f of FIELDS) {
      if (got[f] === undefined && c.e[f] === undefined) continue;
      total++;
      if (fieldOk(f, got, c.e)) right++;
      else wrong.push(`${f}: got ${JSON.stringify(got[f])}, want ${JSON.stringify(c.e[f])}`);
    }
    if (wrong.length === 0) fully++;
    else misses.push({ q: c.q, read, wrong });
  }
  return { cases: set.cases.length, fullyRight: fully, fieldAccuracy: Math.round((right / total) * 1000) / 1000, rewrites, misses };
}
