/**
 * Pure rules of the track index: path thinning and its bound, direction sectors, zone visits with gaps, votes,
 * colour parsing and the plate-in-box test.
 */
import {
  PATH_MAX_POINTS,
  addColourVotes,
  appendPath,
  centreInside,
  colourOf,
  directionOf,
  emptyColourVotes,
  groundPoint,
  majority,
  parseColour,
  updateZoneVisits,
  zonesAt,
  PathPoint,
} from '../services/tracks/trackMath';

const p = (t: number, x: number, y: number): PathPoint => ({ t, x, y });

describe('appendPath', () => {
  it('keeps waypoints at least a second or a step apart, and the newest point as the end', () => {
    let path: PathPoint[] = [];
    // Ten observations 200 ms apart without moving.
    for (let i = 0; i < 10; i++) path = appendPath(path, p(i * 200, 0.5, 0.5));
    // Waypoints at 0 and 1000 ms (a second apart), and the newest observation as the end.
    expect(path.map((q) => q.t)).toEqual([0, 1000, 1800]);
  });

  it('keeps a point when the object moves far enough, even within a second', () => {
    let path = appendPath([], p(0, 0.1, 0.5));
    path = appendPath(path, p(100, 0.2, 0.5));
    path = appendPath(path, p(200, 0.3, 0.5));
    expect(path.map((q) => q.x)).toEqual([0.1, 0.2, 0.3]);
  });

  it('makes a point earlier than the start the new start', () => {
    const path = appendPath(appendPath([], p(1000, 0.1, 0.1)), p(500, 0.9, 0.9));
    expect(path).toEqual([p(500, 0.9, 0.9), p(1000, 0.1, 0.1)]);
  });

  it('ignores a late point that falls inside the path', () => {
    let path = appendPath([], p(0, 0.1, 0.5));
    path = appendPath(path, p(2000, 0.9, 0.5));
    expect(appendPath(path, p(1000, 0.5, 0.9))).toEqual(path);
    expect(appendPath(path, p(0, 0.3, 0.3))).toEqual(path);
  });

  it('keeps the start and a direction when the latest detection of a burst is applied first', () => {
    // A concurrent burst: the newest detection lands first, then the rest, newest to oldest.
    let path: PathPoint[] = [];
    for (let i = 9; i >= 0; i--) path = appendPath(path, p(i * 200, 0.1 + i * 0.05, 0.5));
    expect(path[0].t).toBe(0);
    expect(path[path.length - 1].t).toBe(1800);
    for (let i = 1; i < path.length; i++) expect(path[i].t).toBeGreaterThan(path[i - 1].t);
    expect(directionOf(path)).toBe('RIGHT');
  });

  it('stays bounded on a long track and keeps its first and last points', () => {
    let path: PathPoint[] = [];
    for (let i = 0; i < 2000; i++) path = appendPath(path, p(i * 1000, (i % 100) / 100, 0.5));
    expect(path.length).toBeLessThanOrEqual(PATH_MAX_POINTS);
    expect(path[0].t).toBe(0);
    expect(path[path.length - 1].t).toBe(1999 * 1000);
    for (let i = 1; i < path.length; i++) expect(path[i].t).toBeGreaterThan(path[i - 1].t);
  });
});

describe('directionOf', () => {
  it.each([
    [0.9, 0.5, 'RIGHT'],
    [0.1, 0.5, 'LEFT'],
    [0.5, 0.1, 'UP'],
    [0.5, 0.9, 'DOWN'],
    [0.9, 0.1, 'UP_RIGHT'],
    [0.1, 0.1, 'UP_LEFT'],
    [0.9, 0.9, 'DOWN_RIGHT'],
    [0.1, 0.9, 'DOWN_LEFT'],
    [0.52, 0.51, 'STATIONARY'],
  ])('from the centre to (%s, %s) is %s', (x, y, d) => {
    expect(directionOf([p(0, 0.5, 0.5), p(1000, x as number, y as number)])).toBe(d);
  });
  it('is null for a single point', () => expect(directionOf([p(0, 0.5, 0.5)])).toBeNull());
});

describe('zones', () => {
  const gate = { id: 'z1', name: 'Gate', polygon: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }] };
  const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, s));

  it('tests the ground point (feet), not the box centre', () => {
    const box = { x: 0.2, y: 0.1, width: 0.1, height: 0.3 };
    expect(groundPoint(box)).toEqual({ x: 0.25, y: 0.4 });
    expect(zonesAt(groundPoint(box), [gate])).toEqual([gate]);
    expect(zonesAt({ x: 0.7, y: 0.4 }, [gate])).toEqual([]);
    expect(zonesAt({ x: 0.2, y: 0.4 }, [{ ...gate, polygon: gate.polygon.slice(0, 2) }])).toEqual([]);
  });

  it('extends a visit across short gaps and opens a new one after leaving for longer', () => {
    let v = updateZoneVisits([], [gate], at(0));
    v = updateZoneVisits(v, [gate], at(3));
    v = updateZoneVisits(v, [], at(5));
    v = updateZoneVisits(v, [gate], at(7)); // 4 s since last seen inside: same visit
    expect(v).toEqual([{ zoneId: 'z1', name: 'Gate', enteredAt: at(0).toISOString(), exitedAt: at(7).toISOString() }]);
    v = updateZoneVisits(v, [gate], at(30)); // 23 s away: a second visit
    expect(v.map((x) => [x.enteredAt, x.exitedAt])).toEqual([
      [at(0).toISOString(), at(7).toISOString()],
      [at(30).toISOString(), at(30).toISOString()],
    ]);
  });
});

describe('votes and colours', () => {
  it('majority needs a clear leader', () => {
    expect(majority({ car: 3, truck: 1 })).toBe('car');
    expect(majority({ car: 2, truck: 2 })).toBeNull();
    expect(majority({})).toBeNull();
  });

  it('a colour needs two votes and half the region', () => {
    expect(colourOf({ blue: 1 })).toBeNull();
    expect(colourOf({ blue: 2 })).toBe('blue');
    expect(colourOf({ blue: 2, red: 1, green: 1 })).toBe('blue');
    expect(colourOf({ blue: 2, red: 2, green: 1 })).toBeNull();
    expect(colourOf({ blue: 3, red: 2, green: 2 })).toBeNull();
  });

  it('parses only well-formed colour attributes', () => {
    expect(parseColour({ colour: { method: 'x', monochrome: false, upper: 'blue', lower: 'chartreuse' } })).toEqual({ monochrome: false, upper: 'blue', lower: undefined, body: undefined });
    expect(parseColour({ colour: { upper: 'blue' } })).toBeNull();
    expect(parseColour(undefined)).toBeNull();
    expect(parseColour({ colour: 'blue' })).toBeNull();
  });

  it('counts monochrome detections apart from named ones', () => {
    let v = addColourVotes(emptyColourVotes(), { monochrome: true });
    v = addColourVotes(v, { monochrome: false, body: 'white' });
    v = addColourVotes(v, null);
    expect(v).toEqual({ upper: {}, lower: {}, body: { white: 1 }, monochrome: 1 });
  });
});

describe('centreInside', () => {
  const car = { x: 0.3, y: 0.4, width: 0.3, height: 0.3 };
  it('is true when the plate centre is in the vehicle box', () => expect(centreInside({ x: 0.4, y: 0.62, width: 0.1, height: 0.04 }, car)).toBe(true));
  it('is false otherwise', () => expect(centreInside({ x: 0.55, y: 0.62, width: 0.1, height: 0.04 }, car)).toBe(false));
});
