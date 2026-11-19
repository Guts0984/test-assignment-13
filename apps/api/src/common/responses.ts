import { z } from 'zod';

/**
 * Response schemas of the endpoints whose handlers return database rows or domain reports. They are the
 * single source for the OpenAPI document (and therefore the generated web client); test/responses.test.ts
 * validates a real response of every endpoint against them, so a handler that changes shape fails a test.
 * Timestamps are ISO strings on the wire.
 */
const int = z.number().int();

export const myBidsSchema = z.array(
  z.object({
    id: int,
    lotId: z.string(),
    title: z.string(),
    amount: int,
    isAuto: z.boolean(),
    at: z.string(),
    status: z.string(),
    leading: z.boolean(),
  }),
);

export const myLotsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      currentPrice: int,
      bidCount: int,
      endsAt: z.string().nullable(),
      finalPrice: int.nullable(),
      reservePrice: int.nullable(),
    }),
  ),
  pendingPayout: int,
});

export const myWinsSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    price: int.nullable(),
    payBy: z.string().nullable(),
  }),
);

export const myFavoritesSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    currentPrice: int,
    endsAt: z.string().nullable(),
  }),
);

export const myNotificationsSchema = z.array(
  z.object({
    id: int,
    kind: z.string(),
    payload: z.record(z.string(), z.unknown()),
    at: z.string(),
    read: z.boolean(),
  }),
);

export const moderationLotSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  categoryId: int,
  cityId: int,
  condition: z.string(),
  startPrice: int,
  buyNowPrice: int.nullable(),
  durationDays: int,
  claimExpiresAt: z.string(),
  photos: z.array(z.object({ id: z.string(), url: z.string(), previewUrl: z.string().nullable() })),
});

export const financeReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  turnover: int,
  commission: int,
  paidLots: int,
  winsOffered: int,
  unpaidWins: int,
  unpaidShare: z.number(),
  byCategory: z.array(z.object({ categoryId: int, lots: int, turnover: int, commission: int })),
});

export const reconciliationSchema = z.object({
  entriesSum: int,
  unbalancedTransactions: z.array(z.string()),
  balanceMismatches: z.array(z.object({ account: z.string(), balance: int, entriesSum: int })),
  negativeBalances: z.array(z.string()),
  heldMismatches: z.array(z.object({ userId: z.string(), held: int, deposits: int })),
  escrowDiff: int,
  commissionDiff: int,
  providerMismatches: z.array(
    z.object({
      topupId: z.string(),
      ours: z.string(),
      provider: z.enum(['pending', 'succeeded', 'failed', 'not_found', 'amount_differs']),
    }),
  ),
  ok: z.boolean(),
});
