/**
 * Near matches of a read plate against the known-plate list, for an operator to review.
 *
 * This is advisory. A near match is never an alert, never sets a watchlist link on an observation and never
 * proves identity: two real vehicles often differ by a single character. The result shows exactly which
 * characters differ so a person can look at the picture and decide.
 *
 * Cost model (edit distance on normalised plates):
 *   - identical character: 0
 *   - look-alike substitution (0/O/Q/D, 1/I/L, 8/B, 5/S, 2/Z, 6/G, M/N, E/F, U/V, C/G): 0.5, a typical OCR slip
 *   - any other substitution, insertion or deletion: 1
 * The default limit of 0.5 therefore allows one look-alike slip and nothing else. Only EXACT list entries are
 * compared; wildcard and regex entries already match by pattern.
 */
const LOOKALIKE_GROUPS = ['0OQD', '1IL', '8B', '5S', '2Z', '6G', 'MN', 'EF', 'UV', 'CG'];

const LOOKALIKE = new Set<string>();
for (const g of LOOKALIKE_GROUPS) {
  for (const a of g) for (const b of g) if (a !== b) LOOKALIKE.add(a + b);
}

export const DEFAULT_MAX_COST = 0.5;
export const HARD_MAX_COST = 1.5;

export interface PlateDifference {
  type: 'substitute' | 'insert' | 'delete';
  /** 0-based position in the plate that was read (for 'insert' the position before which the character is missing). */
  position: number;
  /** Character in the read plate (absent for 'insert'). */
  read?: string;
  /** Character in the listed plate (absent for 'delete'). */
  listed?: string;
  lookalike?: boolean;
}

export interface PlateDistance {
  cost: number;
  differences: PlateDifference[];
}

export function weightedPlateDistance(read: string, listed: string): PlateDistance {
  const n = read.length;
  const m = listed.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i][0] = i;
  for (let j = 1; j <= m; j++) d[0][j] = j;
  const sub = (a: string, b: string) => (a === b ? 0 : LOOKALIKE.has(a + b) ? 0.5 : 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub(read[i - 1], listed[j - 1]));
    }
  }
  // Walk back to name the differences. Ties prefer substitution so the report is the shortest to read.
  const differences: PlateDifference[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + sub(read[i - 1], listed[j - 1])) {
      if (read[i - 1] !== listed[j - 1]) {
        differences.unshift({
          type: 'substitute',
          position: i - 1,
          read: read[i - 1],
          listed: listed[j - 1],
          lookalike: LOOKALIKE.has(read[i - 1] + listed[j - 1]),
        });
      }
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      differences.unshift({ type: 'delete', position: i - 1, read: read[i - 1] });
      i--;
    } else {
      differences.unshift({ type: 'insert', position: i, listed: listed[j - 1] });
      j--;
    }
  }
  return { cost: d[n][m], differences };
}

export interface NearMatchEntry {
  id: string;
  normalizedPlate: string;
  matchType?: string | null;
  category?: string;
}

export interface NearMatch {
  watchlistId: string;
  category?: string;
  listedPlate: string;
  cost: number;
  differences: PlateDifference[];
}

export function findNearMatches(
  plate: string,
  entries: NearMatchEntry[],
  opts: { maxCost?: number; limit?: number } = {}
): NearMatch[] {
  const maxCost = opts.maxCost ?? DEFAULT_MAX_COST;
  if (!(maxCost > 0) || maxCost > HARD_MAX_COST) {
    throw new RangeError(`maxCost must be above 0 and at most ${HARD_MAX_COST}`);
  }
  const limit = Math.min(20, Math.max(1, opts.limit ?? 5));
  const read = String(plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (read.length < 4) return [];

  const out: NearMatch[] = [];
  for (const e of entries) {
    if (e.matchType && e.matchType !== 'EXACT') continue;
    if (e.normalizedPlate === read) continue; // a true match is handled by the watchlist itself
    if (Math.abs(e.normalizedPlate.length - read.length) > 1) continue;
    const { cost, differences } = weightedPlateDistance(read, e.normalizedPlate);
    if (cost > maxCost) continue;
    out.push({ watchlistId: e.id, category: e.category, listedPlate: e.normalizedPlate, cost, differences });
  }
  return out.sort((a, b) => a.cost - b.cost || a.listedPlate.localeCompare(b.listedPlate)).slice(0, limit);
}
