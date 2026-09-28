/**
 * P4.2 Indian plate formats and positional OCR correction (contracts/indianPlate.v1.ts).
 * Cases are written from the published formats; confusion cases model typical OCR errors.
 */
import fs from 'fs';
import path from 'path';
import { normalizeIndianPlate as n, INDIAN_STATE_CODES } from '../contracts/indianPlate.v1';

describe('Indian plate normalisation', () => {
  it.each([
    ['MH12AB1234', 'MH12AB1234', 'MH 12 AB 1234', 'STANDARD', 'MH'],
    ['mh-12-ab-1234', 'MH12AB1234', 'MH 12 AB 1234', 'STANDARD', 'MH'],
    ['KA05C7788', 'KA05C7788', 'KA 05 C 7788', 'STANDARD', 'KA'],
    ['KA01234', 'KA01234', 'KA 01 234', 'STANDARD', 'KA'], // older short number
    ['DL3CAB4521', 'DL3CAB4521', 'DL 3C AB 4521', 'STANDARD', 'DL'],
    ['TG07EA1234', 'TG07EA1234', 'TG 07 EA 1234', 'STANDARD', 'TG'], // Telangana since 2024
    ['TS07EA1234', 'TS07EA1234', 'TS 07 EA 1234', 'STANDARD', 'TS'], // older Telangana plates
    ['22BH4567AA', '22BH4567AA', '22 BH 4567 AA', 'BH', null],
    ['23BH0001C', '23BH0001C', '23 BH 0001 C', 'BH', null],
    ['123CD45', '123CD45', '123 CD 45', 'DIPLOMATIC', null],
  ])('%s -> %s', (raw, norm, display, format, state) => {
    const r = n(raw);
    expect(r).toMatchObject({ normalized: norm, display, format, stateCode: state, valid: true, corrections: 0 });
  });

  it.each([
    ['MHI2ABI234', 'MH12AB1234', 2], // I read for 1 in digit slots
    ['TN09BK33O1', 'TN09BK3301', 1], // O for 0 in the number
    ['TNO9BK3301', 'TN09BK3301', 1], // O for 0 in the district
    ['M412AB1234', 'MA12AB1234', 1], // 4 for A in the state slot: MA is not a state -> rejected below
    ['8R01CD7777', 'BR01CD7777', 1], // 8 for B in the state
    ['22BH4S67AA', '22BH4567AA', 1],
  ])('positional correction %s', (raw, expected, corrections) => {
    const r = n(raw);
    if (expected === 'MA12AB1234') {
      expect(r.valid).toBe(false); // correction never invents a state that does not exist
      return;
    }
    expect(r.normalized).toBe(expected);
    expect(r.corrections).toBe(corrections);
    expect(r.valid).toBe(true);
  });

  it.each([
    ['BH01AB1234', 'BH is a series, not a state'],
    ['MH12AO1234', 'series letters never use O'],
    ['MH12IA1234', 'series letters never use I'],
    ['XX12AB1234', 'unknown state'],
    ['14140', 'too short (HSRP IND strip read as text)'],
    ['MH12AB12345', 'number longer than 4 digits'],
    ['', 'empty'],
  ])('rejects %s (%s)', (raw) => {
    expect(n(raw).valid).toBe(false);
  });

  it('knows every current state/UT code and not BH', () => {
    for (const c of ['AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'PB', 'PY', 'RJ', 'SK', 'TG', 'TN', 'TR', 'UK', 'UP', 'WB']) {
      expect(INDIAN_STATE_CODES.has(c)).toBe(true);
    }
    expect(INDIAN_STATE_CODES.has('BH')).toBe(false);
  });

  it('the ai-worker copy is identical to this authoritative file', () => {
    const a = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'indianPlate.v1.ts'), 'utf8');
    const b = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'services', 'ai-worker', 'src', 'anpr', 'indianPlate.v1.ts'), 'utf8');
    expect(b).toBe(a);
  });
});
