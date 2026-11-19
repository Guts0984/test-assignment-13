import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatMoney,
  isKopecks,
  kopecksSchema,
  MAX_AMOUNT_KOP,
  parseMoneyInput,
  percentCeil,
  percentFloor,
  positiveKopecksSchema,
  UAH,
} from '../src/index.js';

const NBSP = ' ';

describe('formatMoney', () => {
  it('formats per locale', () => {
    expect(formatMoney(123_450, 'uk')).toBe(`1${NBSP}234,50${NBSP}₴`);
    expect(formatMoney(123_450, 'en')).toBe('₴1,234.50');
    // Polish does not group 4-digit numbers; 5+ digits are grouped.
    expect(formatMoney(123_450, 'pl')).toBe(`1234,50${NBSP}₴`);
    expect(formatMoney(1_234_550, 'pl')).toBe(`12${NBSP}345,50${NBSP}₴`);
  });

  it('always shows two decimals, including 0 and 1 kopeck', () => {
    expect(formatMoney(0, 'uk')).toBe(`0,00${NBSP}₴`);
    expect(formatMoney(1, 'en')).toBe('₴0.01');
  });

  it('is exact for every amount up to the maximum (no float drift)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_AMOUNT_KOP }), (kop) => {
        expect(parseMoneyInput(formatMoney(kop, 'uk'))).toBe(kop);
        expect(parseMoneyInput(formatMoney(kop, 'pl'))).toBe(kop);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseMoneyInput', () => {
  it.each([
    ['1234', 123_400],
    ['1234,5', 123_450],
    ['1234.50', 123_450],
    [`1${NBSP}234,50`, 123_450],
    ['1 234,50 ₴', 123_450],
    ['0,01', 1],
    ['  7  ', 700],
  ])('parses %j → %d', (raw, kop) => expect(parseMoneyInput(raw)).toBe(kop));

  it.each([
    '',
    '-5',
    '1,234.50',
    '1.234',
    '12,345',
    'abc',
    '1e5',
    '0x10',
    '1,2,3',
    'NaN',
    'Infinity',
    '9999999999',
  ])('rejects %j', (raw) => expect(parseMoneyInput(raw)).toBeNull());
});

describe('kopecks validation', () => {
  it.each([0, 1, MAX_AMOUNT_KOP])('accepts %d', (v) => {
    expect(isKopecks(v)).toBe(true);
    expect(kopecksSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    -1,
    0.5,
    1.000001,
    MAX_AMOUNT_KOP + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '100',
    null,
    undefined,
    {},
    [],
    true,
  ])('rejects %j', (v) => {
    expect(isKopecks(v)).toBe(false);
    expect(kopecksSchema.safeParse(v).success).toBe(false);
  });

  it('positive schema rejects zero', () => {
    expect(positiveKopecksSchema.safeParse(0).success).toBe(false);
    expect(positiveKopecksSchema.safeParse(1).success).toBe(true);
  });

  it('error messages are machine codes', () => {
    const r = kopecksSchema.safeParse(1.5);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('MONEY_NOT_INTEGER_KOPECKS');
  });
});

describe('percent helpers', () => {
  it('floor/ceil bracket the exact value and differ by at most one kopeck', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_AMOUNT_KOP }),
        fc.integer({ min: 0, max: 100 }),
        (a, p) => {
          const lo = percentFloor(a, p);
          const hi = percentCeil(a, p);
          expect(lo * 100).toBeLessThanOrEqual(a * p);
          expect(hi * 100).toBeGreaterThanOrEqual(a * p);
          expect(hi - lo).toBeLessThanOrEqual(1);
          expect(Number.isSafeInteger(lo) && Number.isSafeInteger(hi)).toBe(true);
        },
      ),
    );
  });

  it('UAH() converts hryvnias without float noise', () => {
    expect(UAH(0.1 + 0.2)).toBe(30);
    expect(UAH(1050)).toBe(105_000);
    expect(UAH(99.99)).toBe(9_999);
  });
});
