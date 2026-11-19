import { z } from 'zod';
import { positiveKopecksSchema } from '../money/money.js';

export const BID_KINDS = ['manual', 'auto'] as const;

export const bidInputSchema = z.strictObject({
  kind: z.enum(BID_KINDS),
  /** Manual: the bid. Auto: the maximum. Kopecks. */
  amount: positiveKopecksSchema,
});

export const TOPUP_MIN = 1_00;
export const TOPUP_MAX = 1_000_000_00;

export const topUpInputSchema = z.strictObject({
  amount: positiveKopecksSchema
    .min(TOPUP_MIN, { error: 'TOPUP_TOO_SMALL' })
    .max(TOPUP_MAX, { error: 'TOPUP_TOO_LARGE' }),
});

export type BidInput = z.infer<typeof bidInputSchema>;
export type TopUpInput = z.infer<typeof topUpInputSchema>;
