/**
 * Indian registration-plate text handling (P4.2). Authoritative copy; services/ai-worker has a
 * byte-identical copy (checked by backend/src/__tests__/indianPlate.test.ts).
 *
 * Formats (Central Motor Vehicles Rules; MoRTH notifications):
 *  - STANDARD: state (2 letters) + RTO district (1-2 digits) + series (0-3 letters) + number
 *    (1-4 digits), e.g. MH12AB1234, KA05C7788, DL3CAB4521 (Delhi's category letter is part of
 *    the series). Series letters never use I or O.
 *  - BH (Bharat series, 2021): YY BH #### XX, e.g. 22BH4567AA (letters exclude I and O).
 *  - DIPLOMATIC: ### CD|CC|UN ####.
 * Two-line plates (two-wheelers, some commercial) are read top line first, so the caller joins
 * the lines before calling normalizeIndianPlate.
 *
 * OCR confuses letters and digits (0/O, 1/I, 8/B, 5/S, 2/Z ...). Correction is positional: every
 * split of the string into the format's slots is tried, characters are converted only where the
 * slot demands the other class, and the split needing the fewest conversions wins.
 */
export const INDIAN_STATE_CODES: ReadonlySet<string> = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD',
  'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TG', 'TN', 'TR', 'TS', 'UA', 'UK', 'UP', 'WB',
]);

const TO_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '2': 'Z', '4': 'A', '5': 'S', '6': 'G', '7': 'T', '8': 'B' };
const TO_DIGIT: Record<string, string> = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8' };

export type PlateFormat = 'STANDARD' | 'BH' | 'DIPLOMATIC' | 'UNKNOWN';

export interface NormalizedPlate {
  /** Uppercase alphanumerics after positional correction (or cleaned input when no format fits). */
  normalized: string;
  /** Human-readable grouping, e.g. "MH 12 AB 1234". */
  display: string;
  stateCode: string | null;
  format: PlateFormat;
  valid: boolean;
  /** Characters converted between letter and digit to fit the format. */
  corrections: number;
}

type Slot = 'L' | 'D' | 'S'; // letter, digit, series letter (no I/O)

function fit(chars: string[], pattern: Slot[]): { out: string; corrections: number } | null {
  let corrections = 0;
  const out: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = chars[i];
    const want = pattern[i];
    const isDigit = c >= '0' && c <= '9';
    if (want === 'D') {
      if (isDigit) out.push(c);
      else if (TO_DIGIT[c]) {
        out.push(TO_DIGIT[c]);
        corrections++;
      } else return null;
    } else {
      let l = c;
      if (isDigit) {
        if (!TO_LETTER[c]) return null;
        l = TO_LETTER[c];
        corrections++;
      }
      if (want === 'S' && (l === 'I' || l === 'O')) return null;
      out.push(l);
    }
  }
  return { out: out.join(''), corrections };
}

const rep = (n: number, s: Slot): Slot[] => Array.from({ length: n }, () => s);

export function normalizeIndianPlate(raw: string): NormalizedPlate {
  const clean = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const none: NormalizedPlate = { normalized: clean, display: clean, stateCode: null, format: 'UNKNOWN', valid: false, corrections: 0 };
  if (clean.length < 6 || clean.length > 11) return none;
  const chars = clean.split('');
  type Cand = NormalizedPlate & { score: number };
  const cands: Cand[] = [];

  // Bharat series: DD BH DDDD S{1,2}
  for (const s of [2, 1]) {
    if (clean.length !== 8 + s) continue;
    const f = fit(chars, [...rep(2, 'D'), 'L', 'L', ...rep(4, 'D'), ...rep(s, 'S')]);
    if (f && f.out.slice(2, 4) === 'BH') {
      const o = f.out;
      cands.push({ normalized: o, display: `${o.slice(0, 2)} BH ${o.slice(4, 8)} ${o.slice(8)}`, stateCode: null, format: 'BH', valid: true, corrections: f.corrections, score: f.corrections });
    }
  }

  // Diplomatic: D{1,3} (CD|CC|UN) D{1,4}
  for (let a = 1; a <= 3; a++) {
    for (let b = 1; b <= 4; b++) {
      if (a + 2 + b !== clean.length) continue;
      const f = fit(chars, [...rep(a, 'D'), 'L', 'L', ...rep(b, 'D')]);
      if (f && ['CD', 'CC', 'UN'].includes(f.out.slice(a, a + 2))) {
        const o = f.out;
        cands.push({ normalized: o, display: `${o.slice(0, a)} ${o.slice(a, a + 2)} ${o.slice(a + 2)}`, stateCode: null, format: 'DIPLOMATIC', valid: true, corrections: f.corrections, score: f.corrections + 0.5 });
      }
    }
  }

  // Standard: LL D{1,2} S{0,3} D{1,4}
  for (let d = 1; d <= 2; d++) {
    for (let n = 4; n >= 1; n--) {
      const s = clean.length - 2 - d - n;
      if (s < 0 || s > 3) continue;
      const f = fit(chars, ['L', 'L', ...rep(d, 'D'), ...rep(s, 'S'), ...rep(n, 'D')]);
      if (!f) continue;
      const state = f.out.slice(0, 2);
      if (!INDIAN_STATE_CODES.has(state)) continue;
      // RTO district numbers start at 1: "0" / "00" is never a district.
      if (Number(f.out.slice(2, 2 + d)) === 0) continue;
      const o = f.out;
      const series = o.slice(2 + d, 2 + d + s);
      // Prefer the modern layout: 2-digit district, 4-digit number.
      const score = f.corrections + (n === 4 ? 0 : 0.6 * (4 - n)) + (d === 2 ? 0 : 0.3);
      cands.push({
        normalized: o,
        // Delhi writes the vehicle-category letter with the district: DL 3C AB 4521.
        display:
          state === 'DL' && d === 1 && s >= 2
            ? [state, o.slice(2, 4), series.slice(1), o.slice(2 + d + s)].join(' ')
            : [state, o.slice(2, 2 + d), series, o.slice(2 + d + s)].filter(Boolean).join(' '),
        stateCode: state,
        format: 'STANDARD',
        valid: true,
        corrections: f.corrections,
        score,
      });
    }
  }

  if (cands.length === 0) return none;
  cands.sort((a, b) => a.score - b.score || a.normalized.localeCompare(b.normalized));
  const { score: _s, ...best } = cands[0];
  return best;
}

/** Normalises a watchlist entry or query the same way (without letter/digit correction). */
export function cleanPlateText(raw: string): string {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
