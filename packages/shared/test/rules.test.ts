import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bidStep,
  COMMISSION_MIN,
  commissionFor,
  DEFAULT_TIMINGS,
  DEPOSIT_MIN,
  depositFor,
  MAX_AMOUNT_KOP,
  sellerPayoutFor,
  UAH,
} from '../src/index.js';

describe('bidStep', () => {
  it.each([
    [0, UAH(5)],
    [UAH(99.99), UAH(5)],
    [UAH(100), UAH(10)],
    [UAH(999.99), UAH(10)],
    [UAH(1000), UAH(50)],
    [UAH(9999.99), UAH(50)],
    [UAH(10_000), UAH(100)],
    [MAX_AMOUNT_KOP, UAH(100)],
  ])('price %d → step %d', (price, step) => expect(bidStep(price)).toBe(step));

  it('is monotonic in price', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_AMOUNT_KOP }),
        fc.integer({ min: 0, max: MAX_AMOUNT_KOP }),
        (a, b) => {
          if (a <= b) expect(bidStep(a)).toBeLessThanOrEqual(bidStep(b));
        },
      ),
    );
  });
});

describe('depositFor', () => {
  it.each([
    [UAH(1), DEPOSIT_MIN],
    [UAH(500), UAH(50)],
    [UAH(500.01), 5001], // 10% of 50 001 = 5 000.1 → rounded up
    [UAH(10_000), UAH(1000)],
  ])('max %d → deposit %d', (max, dep) => expect(depositFor(max)).toBe(dep));

  it('is ≥ 10% and ≥ 50 ₴, and never more than 1 kopeck above max(10%, 50 ₴)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_AMOUNT_KOP }), (max) => {
        const d = depositFor(max);
        expect(d * 10).toBeGreaterThanOrEqual(max);
        expect(d).toBeGreaterThanOrEqual(DEPOSIT_MIN);
        expect(d).toBeLessThanOrEqual(Math.max(max / 10, DEPOSIT_MIN) + 1);
        expect(Number.isSafeInteger(d)).toBe(true);
      }),
    );
  });

  it('a higher max never needs a smaller deposit (raising a max only locks more)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_AMOUNT_KOP }),
        fc.integer({ min: 0, max: UAH(100_000) }),
        (a, d) => {
          expect(depositFor(a + d)).toBeGreaterThanOrEqual(depositFor(a));
        },
      ),
    );
  });
});

describe('commissionFor', () => {
  it.each([
    [UAH(1000), UAH(50)],
    [UAH(100), COMMISSION_MIN], // 5 ₴ < 10 ₴ minimum
    [UAH(200), UAH(10)],
    [UAH(333.33), 1666], // 5% of 33 333 = 1 666.65 → down, seller's favour
    [UAH(5), UAH(5)], // the minimum never exceeds the price itself
  ])('price %d → commission %d', (price, fee) => expect(commissionFor(price)).toBe(fee));

  it('commission + payout = price, payout ≥ 0, commission rounds in the seller’s favour', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_AMOUNT_KOP }), (price) => {
        const fee = commissionFor(price);
        expect(fee + sellerPayoutFor(price)).toBe(price);
        expect(sellerPayoutFor(price)).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(Math.max(price * 0.05, COMMISSION_MIN));
        expect(fee).toBeGreaterThanOrEqual(Math.min(COMMISSION_MIN, price));
        expect(Number.isSafeInteger(fee)).toBe(true);
      }),
    );
  });
});

describe('timings', () => {
  it('match the assignment', () => {
    expect(DEFAULT_TIMINGS).toEqual({
      antiSnipeMs: 2 * 60_000,
      paymentWindowMs: 48 * 3600_000,
      offerWindowMs: 24 * 3600_000,
      reviewClaimMs: 15 * 60_000,
      autoConfirmMs: 7 * 24 * 3600_000,
      outbidEmailThrottleMs: 15 * 60_000,
      favoriteReminderMs: 3600_000,
    });
  });
});
