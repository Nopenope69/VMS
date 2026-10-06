import { findNearMatches, weightedPlateDistance, DEFAULT_MAX_COST } from '../services/anpr/plateNearMatch';

const e = (id: string, normalizedPlate: string, matchType = 'EXACT') => ({ id, normalizedPlate, matchType, category: 'BLACKLIST' });

describe('weightedPlateDistance', () => {
  it('is zero for identical plates', () => {
    expect(weightedPlateDistance('MH12AB1234', 'MH12AB1234')).toEqual({ cost: 0, differences: [] });
  });

  it('charges 0.5 for a look-alike slip and names it', () => {
    const r = weightedPlateDistance('MH12A81234', 'MH12AB1234'); // B read as 8
    expect(r.cost).toBe(0.5);
    expect(r.differences).toEqual([{ type: 'substitute', position: 5, read: '8', listed: 'B', lookalike: true }]);
  });

  it('charges 1 for any other substitution', () => {
    const r = weightedPlateDistance('MH12AB1235', 'MH12AB1234');
    expect(r.cost).toBe(1);
    expect(r.differences[0]).toMatchObject({ type: 'substitute', position: 9, read: '5', listed: '4', lookalike: false });
  });

  it('reports a dropped character as a delete from the read plate or an insert from the list', () => {
    const missing = weightedPlateDistance('MH12AB123', 'MH12AB1234'); // last digit not read
    expect(missing.cost).toBe(1);
    expect(missing.differences).toEqual([{ type: 'insert', position: 9, listed: '4' }]);
    const extra = weightedPlateDistance('MH12AB12344', 'MH12AB1234');
    expect(extra.cost).toBe(1);
    expect(extra.differences[0].type).toBe('delete');
  });

  it('adds costs for several differences', () => {
    expect(weightedPlateDistance('MH12A81Z34', 'MH12AB1234').cost).toBe(1); // 8/B and Z/2 are both look-alikes
  });
});

describe('findNearMatches', () => {
  const list = [e('a', 'MH12AB1234'), e('b', 'KA05C7788'), e('c', 'DL3CAB4521'), e('w', 'MH12*', 'WILDCARD')];

  it('finds a plate read with one look-alike slip', () => {
    const r = findNearMatches('MH12A81234', list);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ watchlistId: 'a', listedPlate: 'MH12AB1234', cost: 0.5, category: 'BLACKLIST' });
  });

  it('does not offer a one-digit difference by default, since that is usually another vehicle', () => {
    expect(findNearMatches('MH12AB1235', list)).toEqual([]);
    expect(DEFAULT_MAX_COST).toBe(0.5);
  });

  it('offers it when the operator widens the limit', () => {
    expect(findNearMatches('MH12AB1235', list, { maxCost: 1 }).map((m) => m.watchlistId)).toEqual(['a']);
  });

  it('never returns the exact match itself, wildcard or regex entries', () => {
    expect(findNearMatches('MH12AB1234', list)).toEqual([]);
    expect(findNearMatches('MH12A81234', [e('w', 'MH12*', 'WILDCARD'), e('r', 'MH12[A-Z]{2}1234', 'REGEX')])).toEqual([]);
  });

  it('ranks by cost then plate and honours the limit', () => {
    const entries = [e('x', 'MH12AB1235'), e('y', 'MH12A81234'), e('z', 'MH12AB1234')];
    const r = findNearMatches('MH12AB1D34', entries, { maxCost: 1.5, limit: 2 }); // D/0 look-alike
    expect(r).toHaveLength(2);
    expect(r[0].cost).toBeLessThanOrEqual(r[1].cost);
  });

  it('ignores very short or empty reads and normalises case and separators', () => {
    expect(findNearMatches('MH1', list)).toEqual([]);
    expect(findNearMatches('', list)).toEqual([]);
    expect(findNearMatches('mh-12 a8 1234', list)).toHaveLength(1);
  });

  it.each([0, -1, 1.6, NaN])('rejects maxCost %p', (v) => {
    expect(() => findNearMatches('MH12AB1234', list, { maxCost: v })).toThrow(RangeError);
  });
});
