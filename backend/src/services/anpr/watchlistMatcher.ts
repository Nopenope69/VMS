/**
 * Known-plate list matching (P4.1): EXACT (normalised plate), WILDCARD (* = any run, ? = one
 * character) and REGEX. Regexes are restricted so a list entry cannot hurt the appliance:
 * uppercase letters, digits, character classes, . ? * + {m,n} and | only, no groups, at most 64
 * characters, and always anchored. Plates are at most 11 characters, so matching is bounded.
 */
export type MatchType = 'EXACT' | 'WILDCARD' | 'REGEX';

export class WatchlistPatternError extends Error {}

const WILDCARD_OK = /^[A-Z0-9*?]{1,20}$/;
const REGEX_OK = /^[A-Z0-9\[\]\-.?*+{},|^$]{1,64}$/;

export function compilePattern(matchType: MatchType, pattern: string): RegExp | null {
  const p = String(pattern || '').toUpperCase().replace(/\s+/g, '');
  if (matchType === 'EXACT') return null;
  if (matchType === 'WILDCARD') {
    if (!WILDCARD_OK.test(p) || !/[A-Z0-9]/.test(p)) throw new WatchlistPatternError('wildcard patterns use A-Z, 0-9, * and ? and must contain at least one character');
    return new RegExp('^' + p.replace(/\*/g, '[A-Z0-9]*').replace(/\?/g, '[A-Z0-9]') + '$');
  }
  if (!REGEX_OK.test(p)) throw new WatchlistPatternError('regex may use A-Z, 0-9, [], -, ., ?, *, +, {m,n}, | and anchors only (no groups), up to 64 characters');
  const body = p.replace(/^\^/, '').replace(/\$$/, '');
  try {
    return new RegExp(`^(?:${body})$`);
  } catch (e: any) {
    throw new WatchlistPatternError(`invalid regex: ${e.message}`);
  }
}

export interface WatchlistEntryLike {
  id: string;
  normalizedPlate: string;
  matchType: string;
}

/** Returns the matching entries, exact matches first. */
export function matchWatchlist<T extends WatchlistEntryLike>(plate: string, entries: T[]): T[] {
  const exact: T[] = [];
  const patterns: T[] = [];
  for (const e of entries) {
    if (e.matchType === 'EXACT' || !e.matchType) {
      if (e.normalizedPlate === plate) exact.push(e);
      continue;
    }
    try {
      const re = compilePattern(e.matchType as MatchType, e.normalizedPlate);
      if (re && re.test(plate)) patterns.push(e);
    } catch {
      // Stored patterns are validated on write; an invalid one never matches.
    }
  }
  return [...exact, ...patterns];
}
