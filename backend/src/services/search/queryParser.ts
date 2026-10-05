/**
 * Plain-language search requests ("white SUV at Gate 3 between 8 and 10 pm yesterday, not a taxi") turned into the
 * track search's filters, by rules, not by a model: camera and zone names are matched against the tenant's own
 * names, times are read in the site's time zone, classes and colours come from fixed word lists. Common Hinglish
 * and Hindi words are mapped to English first. Anything the rules cannot place stays in the free-text description,
 * which the appearance search ranks by; nothing is guessed. The operator sees the result and can change it before
 * searching.
 *
 * Measured on labelled requests (docs/ai/nl-search-evaluation.md). A local language model is used only to
 * rewrite a request the word list cannot read (Devanagari it does not know) into English, then these rules run.
 */
import { COLOUR_NAMES, DIRECTIONS } from '../tracks/trackMath';

export type Colour = (typeof COLOUR_NAMES)[number];
export type Direction = (typeof DIRECTIONS)[number];

export interface ParseContext {
  cameras: Array<{ id: string; name: string }>;
  zones: Array<{ id: string; name: string; cameraId: string }>;
  now: Date;
  /** IANA time zone of the site, e.g. Asia/Kolkata. Times in the request are read in it. */
  timeZone: string;
}

export interface ParsedFilters {
  cameraIds?: string[];
  zoneId?: string;
  from?: string;
  to?: string;
  objectClasses?: string[];
  upperColour?: Colour;
  lowerColour?: Colour;
  bodyColour?: Colour;
  direction?: Direction;
  minDwellSeconds?: number;
  hasPlate?: boolean;
}

export interface ParsedQuery {
  /** What the object looks like, for the appearance search (places, times and other filters taken out). */
  text: string;
  and: string[];
  not: string[];
  filters: ParsedFilters;
  /** One line per understood part, for the operator to check, e.g. { field: 'cameras', label: 'Gate 3' }. */
  understood: Array<{ field: string; label: string }>;
  /** Place names that are not a camera or zone of this site ("the canteen camera"). */
  unknownPlaces: string[];
  /** The request after the Hinglish/Hindi word list (what the rules read). */
  normalised: string;
  /** Characters outside the word list remain (e.g. Devanagari names): a rewrite may read it better. */
  needsRewrite: boolean;
}

const COLOUR_ALIAS: Record<string, Colour> = { gray: 'grey', silver: 'grey', maroon: 'red', navy: 'blue', golden: 'yellow', violet: 'purple', cream: 'white' };
const UPPER = ['shirt', 'shirts', 'tshirt', 't-shirt', 'jacket', 'hoodie', 'sweater', 'saree', 'sari', 'kurta', 'top', 'dress', 'coat', 'uniform', 'blazer', 'vest', 'burqa', 'dupatta'];
const LOWER = ['trousers', 'pants', 'jeans', 'shorts', 'skirt', 'lower', 'salwar', 'leggings', 'pyjama', 'dhoti'];
const CLASS_WORDS: Array<[string, string[]]> = [
  ['person', ['person', 'persons', 'people', 'man', 'men', 'woman', 'women', 'lady', 'ladies', 'girl', 'girls', 'boy', 'boys', 'guy', 'guys', 'someone', 'somebody', 'anyone', 'child', 'children', 'kid', 'kids', 'staff', 'worker', 'workers', 'visitor', 'visitors', 'intruder', 'delivery']],
  ['car', ['car', 'cars', 'suv', 'suvs', 'van', 'vans', 'hatchback', 'sedan', 'taxi', 'cab', 'jeep']],
  ['motorcycle', ['motorcycle', 'motorcycles', 'motorbike', 'motorbikes', 'bike', 'bikes', 'scooty', 'scooter', 'scooters', 'moped']],
  ['bicycle', ['bicycle', 'bicycles', 'cycle', 'cycles', 'cyclist', 'cyclists']],
  ['bus', ['bus', 'buses']],
  ['truck', ['truck', 'trucks', 'lorry', 'lorries', 'tempo']],
  ['backpack', ['backpack', 'backpacks', 'rucksack']],
  ['handbag', ['handbag', 'handbags', 'purse']],
  ['suitcase', ['suitcase', 'suitcases', 'luggage']],
];
const VEHICLES = ['car', 'motorcycle', 'bus', 'truck', 'bicycle'];
const BAGS = ['backpack', 'handbag', 'suitcase'];
const DIRS: Array<[Direction, RegExp]> = [
  ['STATIONARY', /\b(stood still|standing still|stationary|not moving|stayed still)\b/],
  ['UP_LEFT', /\bup(wards)?[- ]left\b/],
  ['UP_RIGHT', /\bup(wards)?[- ]right\b/],
  ['DOWN_LEFT', /\bdown(wards)?[- ]left\b/],
  ['DOWN_RIGHT', /\bdown(wards)?[- ]right\b/],
  ['LEFT', /\b(going|moving|heading|travell?ing|walking|driving) (to the )?left\b/],
  ['RIGHT', /\b(going|moving|heading|travell?ing|walking|driving) (to the )?right\b/],
  ['UP', /\b(going|moving|heading|walking|driving) up(wards)?\b/],
  ['DOWN', /\b(going|moving|heading|walking|driving) down(wards)?\b/],
];

/**
 * Hinglish (romanised Hindi) and common Devanagari words, to English. Multi-word phrases first. Postpositions
 * (mein, par, pe) become "in"/"at" so the English rules read the place that comes before them.
 */
const PHRASES: Array<[RegExp, string]> = [
  [/\bkal raat\b|कल रात/g, ' last night '],
  [/\baaj subah\b|आज सुबह/g, ' this morning '],
  [/\baaj (dopahar|dopeher)\b|आज दोपहर/g, ' this afternoon '],
  [/\bke paas\b|के पास/g, ' near '],
  [/\bbina number plate\b|बिना नंबर प्लेट/g, ' without a plate '],
  [/\bkoi bhi\b|कोई भी/g, ' any '],
];
const WORDS: Record<string, string> = {
  // colours
  laal: 'red', lal: 'red', neela: 'blue', neeli: 'blue', nila: 'blue', nili: 'blue', safed: 'white', safaid: 'white',
  kaala: 'black', kaali: 'black', kala: 'black', kali: 'black', hara: 'green', hari: 'green', haraa: 'green', peela: 'yellow', peeli: 'yellow', pila: 'yellow', pili: 'yellow',
  gulabi: 'pink', bhura: 'brown', bhoora: 'brown', narangi: 'orange', baingani: 'purple', sleti: 'grey',
  लाल: 'red', नीला: 'blue', नीली: 'blue', सफेद: 'white', सफ़ेद: 'white', काला: 'black', काली: 'black', हरा: 'green', हरी: 'green', पीला: 'yellow', पीली: 'yellow', गुलाबी: 'pink', भूरा: 'brown', नारंगी: 'orange',
  // people and things
  aadmi: 'man', admi: 'man', aurat: 'woman', mahila: 'woman', ladka: 'boy', ladki: 'girl', bacha: 'child', baccha: 'child', banda: 'man', log: 'people',
  gaadi: 'car', gadi: 'car', gaari: 'car', saaman: 'luggage', thaila: 'bag',
  आदमी: 'man', औरत: 'woman', महिला: 'woman', लड़का: 'boy', लड़की: 'girl', बच्चा: 'child', लोग: 'people', गाड़ी: 'car', गाडी: 'car', कार: 'car', बस: 'bus', ट्रक: 'truck',
  बाइक: 'bike', स्कूटी: 'scooty', साइकिल: 'cycle', सूटकेस: 'suitcase', बैग: 'bag', जैकेट: 'jacket', शर्ट: 'shirt', कमीज़: 'shirt', साड़ी: 'saree', कुर्ता: 'kurta', पैंट: 'pants',
  // places and times
  mein: ' in ', par: ' at ', pe: ' at ', में: ' in ', पर: ' at ', पे: ' at ',
  kal: 'yesterday', aaj: 'today', raat: 'night', subah: 'morning', shaam: 'evening', कल: 'yesterday', आज: 'today', रात: 'night', सुबह: 'morning', शाम: 'evening',
  bina: 'without', nahi: 'not', nahin: 'not', बिना: 'without', नहीं: 'not',
  // fillers
  wala: '', wali: '', waala: '', waali: '', vala: '', vali: '', ka: '', ki: '', ke: '', ko: '', se: '', dikhao: '', dhundo: '', lawaris: '', lavaris: '',
  वाला: '', वाली: '', वाले: '', का: '', की: '', के: '', को: '', से: '', दिखाओ: '', लावारिस: '',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const v = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second')) - Math.floor(ms / 1000) * 1000;
}

/** The site's local calendar date of `now`, and a function from (day offset, minutes after local midnight) to UTC. */
function localClock(now: Date, tz: string) {
  const off = tzOffsetMs(now.getTime(), tz);
  const local = new Date(now.getTime() + off);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const at = (dayOffset: number, minutes: number): Date => {
    const guess = Date.UTC(y, m, d + dayOffset, 0, minutes);
    // Two passes settle a daylight-saving boundary (none in India, but sites elsewhere exist).
    let t = guess - tzOffsetMs(guess, tz);
    t = guess - tzOffsetMs(t, tz);
    return new Date(t);
  };
  const label = (dt: Date) => {
    const l = new Date(dt.getTime() + tzOffsetMs(dt.getTime(), tz));
    return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())} ${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
  };
  return { at, label };
}

function clock(h: string, m: string | undefined, ampm: string | undefined): number {
  let hh = Number(h);
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  return hh * 60 + Number(m || 0);
}

const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?';

/** Times in the request, as UTC instants, and the phrase that said it (removed from the description). */
function parseTime(q: string, ctx: ParseContext): { from?: Date; to?: Date; phrase?: string } {
  const { at } = localClock(ctx.now, ctx.timeZone);
  const yesterday = /\byesterday\b/.test(q);
  const offset = yesterday ? -1 : 0;
  let m: RegExpMatchArray | null;
  if ((m = q.match(/\b(?:in the )?(?:last|past) (\d+ |an? |one )?(hours?|minutes?|mins?)\b/))) {
    const n = m[1] && /\d/.test(m[1]) ? Number(m[1]) : 1;
    const ms = n * (m[2].startsWith('hour') ? 3600e3 : 60e3);
    return { from: new Date(ctx.now.getTime() - ms), to: ctx.now, phrase: m[0] };
  }
  if ((m = q.match(new RegExp(`\\bbetween ${TIME} and ${TIME}`)))) {
    const morning = /\b(this morning|morning)\b/.test(q);
    const evening = /\b(tonight|evening|night)\b/.test(q);
    const ap2 = m[6] || (morning ? 'am' : evening ? 'pm' : undefined);
    const ap1 = m[3] || ap2;
    return { from: at(offset, clock(m[1], m[2], ap1)), to: at(offset, clock(m[4], m[5], ap2)), phrase: m[0] };
  }
  if (/\blast night\b/.test(q)) return { from: at(-1, 18 * 60), to: at(0, 6 * 60), phrase: 'last night' };
  if (/\bthis morning\b/.test(q)) return { from: at(0, 6 * 60), to: at(0, 12 * 60), phrase: 'this morning' };
  if (/\bthis afternoon\b/.test(q)) return { from: at(0, 12 * 60), to: ctx.now, phrase: 'this afternoon' };
  if (/\bthis evening\b|\btonight\b/.test(q)) return { from: at(0, 17 * 60), to: ctx.now, phrase: q.match(/\bthis evening\b|\btonight\b/)![0] };
  if (/\bafter midnight\b/.test(q)) return { from: at(0, 0), phrase: 'after midnight' };
  if ((m = q.match(new RegExp(`\\b(after|since|from) ${TIME}`)))) {
    // "after 6" without am/pm reads as evening for a small hour, as people say it.
    return { from: at(offset, clock(m[2], m[3], m[4] || (Number(m[2]) < 8 ? 'pm' : undefined))), phrase: m[0] };
  }
  if ((m = q.match(new RegExp(`\\bbefore ${TIME}`)))) return { to: at(offset, clock(m[1], m[2], m[3])), ...(yesterday ? { from: at(-1, 0) } : {}), phrase: m[0] };
  if (yesterday) return { from: at(-1, 0), to: at(0, 0), phrase: 'yesterday' };
  if (/\btoday\b/.test(q)) return { from: at(0, 0), phrase: 'today' };
  return {};
}

/** Names of `items` that appear in the request; a longer name wins over a shorter one it contains. */
function findNames<T extends { name: string }>(q: string, items: T[]): T[] {
  const hits = items.filter((i) => i.name.trim() && new RegExp(`(^|[^a-z0-9])${escape(i.name.toLowerCase())}($|[^a-z0-9])`).test(q));
  return hits.filter((h) => !hits.some((o) => o !== h && o.name.length > h.name.length && o.name.toLowerCase().includes(h.name.toLowerCase())));
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Applies the Hinglish/Hindi word list. */
export function normalise(raw: string): string {
  let s = ' ' + raw.toLowerCase().normalize('NFC') + ' ';
  for (const [re, en] of PHRASES) s = s.replace(re, en);
  s = s.replace(/[,.;!?।]/g, ' ');
  s = s
    .split(/\s+/)
    .map((w) => (w in WORDS ? WORDS[w] : w))
    .join(' ');
  return (' ' + s.replace(/\s+/g, ' ').trim() + ' ').replace(/\s+/g, ' ');
}

const FILLER = /\b(show me|show|find|search for|search|look for|any|all|the|a|an|at|in|on|near|by|of|please|that|who|which|was|were|is|are|seen|camera|cameras)\b/g;

export function parseSearchRequest(raw: string, ctx: ParseContext): ParsedQuery {
  const q = normalise(raw);
  const understood: ParsedQuery['understood'] = [];
  const filters: ParsedFilters = {};
  let desc = q;
  const take = (phrase: string | undefined) => {
    if (phrase) desc = desc.replace(phrase, ' ');
  };

  const cams = findNames(q, ctx.cameras);
  if (cams.length) {
    filters.cameraIds = cams.map((c) => c.id);
    cams.forEach((c) => {
      understood.push({ field: 'camera', label: c.name });
      take(c.name.toLowerCase());
    });
  }
  const zones = findNames(q, ctx.zones);
  if (zones.length) {
    filters.zoneId = zones[0].id;
    understood.push({ field: 'zone', label: zones[0].name });
    take(zones[0].name.toLowerCase());
  }

  // Exclusions first, so "not a taxi" does not also count as a car.
  let rest = q;
  const not: string[] = [];
  for (const m of q.matchAll(/\b(?:but )?(?:not|without|no) (?:wearing |carrying |having |in )?(?:a |an |the )?([a-z]+)/g)) {
    if (/\b(plate|number)\b/.test(m[0]) || /^(moving|plate|number)$/.test(m[1])) continue;
    not.push(m[1]);
    rest = rest.replace(m[0], ' ');
    take(m[0]);
  }
  const and: string[] = [];
  for (const m of rest.matchAll(/\band (?:also )?(?:wearing |carrying |holding |with )?(?:an? )?([a-z]+)\b/g)) {
    const w = m[1];
    if ((COLOUR_NAMES as readonly string[]).includes(w) || w in COLOUR_ALIAS || /^\d/.test(w) || LOWER.includes(w) || UPPER.includes(w)) continue;
    if (CLASS_WORDS.some(([, words]) => words.includes(w))) continue;
    and.push(w);
    take(m[0]);
  }

  const classes = new Set<string>();
  for (const [cls, words] of CLASS_WORDS) if (words.some((w) => new RegExp(`\\b${w}\\b`).test(rest))) classes.add(cls);
  if (/\bvehicles?\b/.test(rest)) VEHICLES.forEach((v) => classes.add(v));
  // "a person with a backpack" is a person search; the bag stays in the description.
  if (classes.has('person')) BAGS.forEach((b) => classes.delete(b));
  if (classes.size) {
    filters.objectClasses = [...classes];
    understood.push({ field: 'class', label: [...classes].join(', ') });
  }

  const colourWords = [...COLOUR_NAMES, ...Object.keys(COLOUR_ALIAS)].join('|');
  for (const m of rest.matchAll(new RegExp(`\\b(${colourWords})\\b(?:\\s+(\\S+))?`, 'g'))) {
    const c = (COLOUR_ALIAS[m[1]] ?? m[1]) as Colour;
    const next = m[2] || '';
    if (LOWER.includes(next)) filters.lowerColour ??= c;
    else if (UPPER.includes(next) || classes.has('person')) filters.upperColour ??= c;
    else filters.bodyColour ??= c;
  }
  if (filters.upperColour) understood.push({ field: 'upperColour', label: `top: ${filters.upperColour}` });
  if (filters.lowerColour) understood.push({ field: 'lowerColour', label: `bottom: ${filters.lowerColour}` });
  if (filters.bodyColour) understood.push({ field: 'bodyColour', label: `colour: ${filters.bodyColour}` });

  for (const [d, re] of DIRS) {
    const m = rest.match(re);
    if (m) {
      filters.direction = d;
      understood.push({ field: 'direction', label: d === 'STATIONARY' ? 'standing still' : `moving ${d.toLowerCase().replace('_', '-')}` });
      take(m[0]);
      break;
    }
  }
  let m: RegExpMatchArray | null;
  if ((m = rest.match(/\b(?:stayed |stood |for )?(?:more than|over|at least|longer than)\s+(\d+)\s*(minutes?|mins?|seconds?|secs?|hours?)\b/))) {
    filters.minDwellSeconds = Number(m[1]) * (m[2].startsWith('hour') ? 3600 : m[2].startsWith('min') ? 60 : 1);
    understood.push({ field: 'minDwellSeconds', label: `stayed ${m[1]} ${m[2]} or more` });
    take(m[0]);
  }
  if ((m = q.match(/\b(?:has|with|having) a (?:number )?plate\b/))) {
    filters.hasPlate = true;
    understood.push({ field: 'hasPlate', label: 'plate read' });
    take(m[0]);
  } else if ((m = q.match(/\bwithout (?:a )?(?:number )?plate\b/))) {
    filters.hasPlate = false;
    understood.push({ field: 'hasPlate', label: 'no plate read' });
    take(m[0]);
  }

  const t = parseTime(q, ctx);
  if (t.from || t.to) {
    const { label } = localClock(ctx.now, ctx.timeZone);
    if (t.from) filters.from = t.from.toISOString();
    if (t.to) filters.to = t.to.toISOString();
    understood.push({ field: 'time', label: `${t.from ? label(t.from) : '…'} to ${t.to ? label(t.to) : 'now'}` });
    take(t.phrase);
    desc = desc.replace(/\b(yesterday|today|morning|afternoon|evening|night)\b/g, ' ');
  }

  const unknownPlaces: string[] = [];
  if (!cams.length && (m = q.match(/\b(?:the )?([a-z0-9]+(?: [a-z0-9]+)?) camera\b/))) {
    const place = m[1].replace(/^(show me|show|the)\s+/, '').replace(/^(me|the)\s+/, '');
    unknownPlaces.push(place);
    take(m[0]);
  }

  if (not.length) understood.push({ field: 'not', label: `not: ${not.join(', ')}` });
  if (and.length) understood.push({ field: 'and', label: `also: ${and.join(', ')}` });

  let text = desc.replace(FILLER, ' ').replace(/\b(stayed|stood|standing|going|moving|heading|between|after|before|since|from|to|and|or|but)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) text = filters.objectClasses?.join(' or ') ?? q.trim();
  return { text, and, not, filters, understood, unknownPlaces, normalised: q.trim(), needsRewrite: /[^\x00-\x7F]/.test(q) };
}

/**
 * Combines the rules' reading of the original request with their reading of the model's English rewrite. What the
 * word list read in the original (a colour, a class, a time) stands; the rewrite only fills what is missing, in
 * practice place names the word list cannot read. So a model that changes a colour (measured: "लाल ट्रक" rewritten
 * as "white truck") cannot change the search.
 */
export function mergeWithRewrite(original: ParsedQuery, rewritten: ParsedQuery): ParsedQuery {
  const filters: ParsedFilters = { ...rewritten.filters };
  for (const [k, v] of Object.entries(original.filters)) if (v !== undefined) (filters as any)[k] = v;
  const fields = new Set(original.understood.map((u) => u.field));
  // The time row is one row for from and to; take it from whichever reading set the times kept above.
  const timeFromOriginal = original.filters.from !== undefined || original.filters.to !== undefined;
  const understood = [
    ...original.understood,
    ...rewritten.understood.filter((u) => !fields.has(u.field) && !(u.field === 'time' && timeFromOriginal)),
  ];
  return {
    text: rewritten.text,
    and: original.and.length ? original.and : rewritten.and,
    not: original.not.length ? original.not : rewritten.not,
    filters,
    understood,
    unknownPlaces: filters.cameraIds || filters.zoneId ? [] : rewritten.unknownPlaces,
    normalised: original.normalised,
    needsRewrite: false,
  };
}
