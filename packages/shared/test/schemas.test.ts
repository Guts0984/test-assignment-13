import { describe, expect, it } from 'vitest';
import {
  bidInputSchema,
  idempotencyKeySchema,
  lotCreateInputSchema,
  photoPresignInputSchema,
  registerInputSchema,
  reportQuerySchema,
  searchQuerySchema,
  shipInputSchema,
  topUpInputSchema,
  UAH,
} from '../src/index.js';

const validLot = {
  title: 'Vintage camera',
  description: 'Works fine',
  categoryId: 3,
  cityId: 2,
  condition: 'good',
  startPrice: UAH(100),
  reservePrice: UAH(500),
  buyNowPrice: UAH(900),
  durationDays: 7,
};

const issues = (r: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => r.error?.issues.map((i) => `${i.path.map(String).join('.')}:${i.message}`) ?? [];

describe('lotCreateInputSchema', () => {
  it('accepts a valid lot and defaults optional prices to null', () => {
    expect(lotCreateInputSchema.parse(validLot)).toMatchObject(validLot);
    const { reservePrice: _r, buyNowPrice: _b, ...minimal } = validLot;
    expect(lotCreateInputSchema.parse(minimal)).toMatchObject({
      reservePrice: null,
      buyNowPrice: null,
    });
  });

  it.each([
    ['status', 'active'],
    ['sellerId', '00000000-0000-0000-0000-000000000000'],
    ['bidCount', 99],
    ['currentPrice', 1],
  ])('rejects the server-owned field %s (mass assignment)', (field, value) => {
    expect(lotCreateInputSchema.safeParse({ ...validLot, [field]: value }).success).toBe(false);
  });

  it('rejects a __proto__ payload and does not pollute Object.prototype', () => {
    const evil: unknown = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(validLot).slice(1)}`,
    );
    const r = lotCreateInputSchema.safeParse(evil);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Whether Zod reports the key or not, the parsed value must not carry it.
    if (r.success) expect(Object.getPrototypeOf(r.data)).toBe(Object.prototype);
  });

  it.each([
    [{ startPrice: 100.5 }, 'startPrice:MONEY_NOT_INTEGER_KOPECKS'],
    [{ startPrice: 0 }, 'startPrice:MONEY_NOT_POSITIVE'],
    [{ startPrice: -100 }, 'startPrice:MONEY_NEGATIVE'],
    [{ startPrice: '100' }, 'startPrice:MONEY_NOT_A_NUMBER'],
    [{ reservePrice: UAH(50) }, 'reservePrice:RESERVE_BELOW_START'],
    [{ buyNowPrice: UAH(100) }, 'buyNowPrice:BUY_NOW_NOT_ABOVE_START'],
    [{ buyNowPrice: UAH(400) }, 'buyNowPrice:BUY_NOW_BELOW_RESERVE'],
  ])('price rule %j → %s', (patch, expected) => {
    expect(issues(lotCreateInputSchema.safeParse({ ...validLot, ...patch }))).toContain(expected);
  });

  it.each([0, 11, 1.5, '7', -1])('rejects durationDays=%j', (d) => {
    expect(lotCreateInputSchema.safeParse({ ...validLot, durationDays: d }).success).toBe(false);
  });

  it.each(['ab', 'x'.repeat(121), 'bad\u0000title', 'bell\u0007', '   '])(
    'rejects title %j',
    (title) => {
      expect(lotCreateInputSchema.safeParse({ ...validLot, title }).success).toBe(false);
    },
  );

  it('allows newlines and tabs in the description but trims it', () => {
    const r = lotCreateInputSchema.parse({ ...validLot, description: '  line1\n\tline2  ' });
    expect(r.description).toBe('line1\n\tline2');
  });

  it('rejects unknown condition and non-integer ids', () => {
    expect(lotCreateInputSchema.safeParse({ ...validLot, condition: 'mint' }).success).toBe(false);
    expect(lotCreateInputSchema.safeParse({ ...validLot, categoryId: 1.2 }).success).toBe(false);
    expect(lotCreateInputSchema.safeParse({ ...validLot, cityId: 0 }).success).toBe(false);
    expect(lotCreateInputSchema.safeParse({ ...validLot, cityId: 99999 }).success).toBe(false);
  });
});

describe('bid / top-up / ship / presign', () => {
  it('bid needs kind and integer kopecks, strict', () => {
    expect(bidInputSchema.safeParse({ kind: 'auto', amount: 1000 }).success).toBe(true);
    expect(bidInputSchema.safeParse({ kind: 'auto', amount: 10.5 }).success).toBe(false);
    expect(bidInputSchema.safeParse({ kind: 'snipe', amount: 1000 }).success).toBe(false);
    expect(bidInputSchema.safeParse({ kind: 'auto', amount: 1000, userId: 'x' }).success).toBe(
      false,
    );
  });

  it('top-up bounds', () => {
    expect(topUpInputSchema.safeParse({ amount: 99 }).success).toBe(false);
    expect(topUpInputSchema.safeParse({ amount: 100 }).success).toBe(true);
    expect(topUpInputSchema.safeParse({ amount: 100_000_001 }).success).toBe(false);
  });

  it('tracking number: no HTML or script', () => {
    expect(shipInputSchema.safeParse({ trackingNumber: 'NP 2045-1234' }).success).toBe(true);
    expect(shipInputSchema.safeParse({ trackingNumber: '<script>' }).success).toBe(false);
  });

  it('presign accepts only JPEG/PNG/WebP up to 10 MB', () => {
    expect(
      photoPresignInputSchema.safeParse({ contentType: 'image/png', size: 10 * 1024 * 1024 })
        .success,
    ).toBe(true);
    expect(
      photoPresignInputSchema.safeParse({ contentType: 'image/png', size: 10 * 1024 * 1024 + 1 })
        .success,
    ).toBe(false);
    expect(
      photoPresignInputSchema.safeParse({ contentType: 'image/svg+xml', size: 10 }).success,
    ).toBe(false);
    expect(photoPresignInputSchema.safeParse({ contentType: 'image/gif', size: 10 }).success).toBe(
      false,
    );
    expect(photoPresignInputSchema.safeParse({ contentType: 'image/png', size: 0 }).success).toBe(
      false,
    );
  });
});

describe('searchQuerySchema (URL round trip)', () => {
  const fromUrl = (qs: string) =>
    searchQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(qs)));

  it('parses a full query string', () => {
    const r = fromUrl(
      'q=camera&category=3,5,5&city=1&condition=good,new&priceMin=100&priceMax=5000&noBids=1&endingSoon=true&sort=price_asc&page=2',
    );
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      q: 'camera',
      category: [3, 5],
      city: [1],
      condition: ['good', 'new'],
      priceMin: 100,
      priceMax: 5000,
      noBids: true,
      endingSoon: true,
      sort: 'price_asc',
      page: 2,
      pageSize: 24,
    });
  });

  it('defaults', () => {
    expect(fromUrl('').data).toMatchObject({
      sort: 'relevance',
      page: 1,
      pageSize: 24,
      noBids: false,
      endingSoon: false,
    });
  });

  it.each([
    'priceMin=500&priceMax=100',
    'page=0',
    'page=-1',
    'page=abc',
    'pageSize=1000',
    'sort=DROP TABLE',
    'condition=mint',
    'category=1.5',
    'noBids=yes',
    `q=${'x'.repeat(201)}`,
    `category=${Array.from({ length: 51 }, (_, i) => i + 1).join(',')}`,
  ])('rejects %s', (qs) => expect(fromUrl(qs).success).toBe(false));
});

describe('misc schemas', () => {
  it('register normalises email and is strict', () => {
    expect(
      registerInputSchema.parse({
        email: 'A@Example.COM',
        password: 'password1',
        displayName: 'Ann',
      }).email,
    ).toBe('a@example.com');
    expect(
      registerInputSchema.safeParse({
        email: 'a@b.co',
        password: 'password1',
        displayName: 'Ann',
        role: 'moderator',
      }).success,
    ).toBe(false);
    expect(
      registerInputSchema.safeParse({ email: 'nope', password: 'password1', displayName: 'Ann' })
        .success,
    ).toBe(false);
    expect(
      registerInputSchema.safeParse({ email: 'a@b.co', password: 'short', displayName: 'Ann' })
        .success,
    ).toBe(false);
  });

  it('report period', () => {
    expect(reportQuerySchema.safeParse({ from: '2026-01-01', to: '2026-03-31' }).success).toBe(
      true,
    );
    expect(reportQuerySchema.safeParse({ from: '2026-03-31', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success).toBe(
      false,
    );
    expect(
      reportQuerySchema.safeParse({ from: "2026-01-01' OR 1=1", to: '2026-01-02' }).success,
    ).toBe(false);
  });

  it('idempotency key', () => {
    expect(idempotencyKeySchema.safeParse('0b8f3c2e-1d4a-4e5f-9a8b-7c6d5e4f3a2b').success).toBe(
      true,
    );
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has space in it').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('newline\ninjection').success).toBe(false);
  });
});

describe('query parser hardening', () => {
  it('rejects nested objects/arrays smuggled through qs-style parsing', () => {
    expect(searchQuerySchema.safeParse({ category: { $gt: 1 } }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ category: [[1]] }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ city: ['1', { a: 1 }] }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ category: ['1', '2'] }).data?.category).toEqual([1, 2]);
  });
});

describe('no lenient coercion (Number([1]) === 1, Number(true) === 1, Number("") === 0)', () => {
  it.each([[[1]], [true], [null], [''], ['0x10'], ['1e3'], [' 5'], ['5.0']])(
    'page=%j is rejected',
    (page) => {
      expect(searchQuerySchema.safeParse({ page }).success).toBe(false);
    },
  );

  it.each([true, '3', [3], null])('JSON body categoryId=%j is rejected', (categoryId) => {
    expect(lotCreateInputSchema.safeParse({ ...validLot, categoryId }).success).toBe(false);
  });
});
