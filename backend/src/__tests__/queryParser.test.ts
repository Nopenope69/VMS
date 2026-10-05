/**
 * Plain-language search requests turned into track-search filters by rules (services/search/queryParser.ts):
 * the labelled sets as a floor (a change that lowers the score fails), and the behaviours the operator relies on.
 */
import fs from 'fs';
import path from 'path';
import { parseSearchRequest, normalise, ParseContext } from '../services/search/queryParser';
import { evaluate, LabelledSet } from '../services/search/queryParserEval';

const set = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/nl-search', `${name}.json`), 'utf8')) as LabelledSet;

const ctx: ParseContext = {
  cameras: [
    { id: 'c-gate3', name: 'Gate 3' },
    { id: 'c-main', name: 'Main Gate' },
    { id: 'c-lobby', name: 'Lobby' },
  ],
  zones: [{ id: 'z-visitor', name: 'Visitor Bay', cameraId: 'c-lobby' }],
  // 15:30 in Kolkata.
  now: new Date('2026-10-04T10:00:00Z'),
  timeZone: 'Asia/Kolkata',
};

describe('labelled sets (rules only; numbers in docs/ai/nl-search-evaluation.md)', () => {
  it.each([
    ['dev', 39],
    ['holdout-1', 29],
    ['holdout-2', 29],
  ])('%s: at least %i requests fully right', async (name, floor) => {
    const r = await evaluate(set(name));
    expect(r.fullyRight).toBeGreaterThanOrEqual(floor);
    expect(r.fieldAccuracy).toBeGreaterThanOrEqual(0.98);
  });
});

describe('parseSearchRequest', () => {
  it('reads cameras, class, colour and a time window in the site time zone, as UTC', () => {
    const p = parseSearchRequest('white SUV at Gate 3 between 8 and 10 pm yesterday', ctx);
    expect(p.filters).toEqual({
      cameraIds: ['c-gate3'],
      objectClasses: ['car'],
      bodyColour: 'white',
      // 20:00 and 22:00 in Kolkata on 3 Oct.
      from: '2026-10-03T14:30:00.000Z',
      to: '2026-10-03T16:30:00.000Z',
    });
    expect(p.understood.map((u) => u.label)).toEqual(['Gate 3', 'car', 'colour: white', '2026-10-03 20:00 to 2026-10-03 22:00']);
  });

  it('keeps only the appearance in the search text', () => {
    expect(parseSearchRequest('man in a blue shirt in the Lobby this morning, not in uniform', ctx).text).toBe('man blue shirt');
    expect(parseSearchRequest('white van but not a taxi at the main gate', ctx).text).toBe('white van');
  });

  it('a longer camera name wins over a shorter one inside it', () => {
    const cams = [...ctx.cameras, { id: 'c-gate', name: 'Gate' }];
    expect(parseSearchRequest('car at main gate', { ...ctx, cameras: cams }).filters.cameraIds).toEqual(['c-main']);
    expect(parseSearchRequest('car at the gate', { ...ctx, cameras: cams }).filters.cameraIds).toEqual(['c-gate']);
  });

  it('a place that is not a camera of the site is reported, not guessed', () => {
    const p = parseSearchRequest('show me the canteen camera', ctx);
    expect(p.unknownPlaces).toEqual(['canteen']);
    expect(p.filters.cameraIds).toBeUndefined();
  });

  it('NOT and AND terms, plate, dwell and direction', () => {
    const p = parseSearchRequest('people who stayed more than 5 minutes in the visitor bay, not wearing a mask and carrying an umbrella', ctx);
    expect(p.filters).toMatchObject({ zoneId: 'z-visitor', objectClasses: ['person'], minDwellSeconds: 300 });
    expect(p.not).toEqual(['mask']);
    expect(p.and).toEqual(['umbrella']);
    expect(parseSearchRequest('cars without a plate', ctx).filters.hasPlate).toBe(false);
    expect(parseSearchRequest('vehicles going left', ctx).filters).toMatchObject({ direction: 'LEFT', objectClasses: ['car', 'motorcycle', 'bus', 'truck', 'bicycle'] });
  });

  it('relative times: the last hour, after 6, this afternoon', () => {
    expect(parseSearchRequest('cars in the last hour', ctx).filters).toMatchObject({ from: '2026-10-04T09:00:00.000Z', to: '2026-10-04T10:00:00.000Z' });
    expect(parseSearchRequest('trucks after 6', ctx).filters.from).toBe('2026-10-04T12:30:00.000Z');
    expect(parseSearchRequest('bus this afternoon', ctx).filters).toMatchObject({ from: '2026-10-04T06:30:00.000Z', to: '2026-10-04T10:00:00.000Z' });
  });

  it('Hinglish and Hindi through the word list', () => {
    expect(normalise('lobby mein laal shirt wala aadmi').trim()).toBe('lobby in red shirt man');
    expect(parseSearchRequest('gate 3 पर लाल कार', ctx).filters).toMatchObject({ cameraIds: ['c-gate3'], objectClasses: ['car'], bodyColour: 'red' });
    expect(parseSearchRequest('main gate pe kal raat safed gaadi', ctx).filters).toMatchObject({ cameraIds: ['c-main'], bodyColour: 'white', from: '2026-10-03T12:30:00.000Z', to: '2026-10-04T00:30:00.000Z' });
  });

  it('asks for a rewrite only when unread script remains', () => {
    expect(parseSearchRequest('gate 3 पर लाल कार', ctx).needsRewrite).toBe(false);
    expect(parseSearchRequest('मुख्य गेट पर बस', ctx).needsRewrite).toBe(true);
    expect(parseSearchRequest('white car', ctx).needsRewrite).toBe(false);
  });
});
