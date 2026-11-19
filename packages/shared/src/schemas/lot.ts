import { z } from 'zod';
import { kopecksSchema, positiveKopecksSchema } from '../money/money.js';
import { LOT_RULES } from '../rules/rules.js';
import { queryInt, textSchema } from './common.js';

export const ITEM_CONDITIONS = ['new', 'like_new', 'good', 'fair', 'for_parts'] as const;
export type ItemCondition = (typeof ITEM_CONDITIONS)[number];
export const itemConditionSchema = z.enum(ITEM_CONDITIONS);

/** Strict ids for JSON bodies: a number, nothing else. */
export const categoryIdSchema = z.number().int().min(1).max(32767);
export const cityIdSchema = z.number().int().min(1).max(32767);
/** The same ids when they arrive as URL query strings. */
export const categoryIdQuerySchema = queryInt(1, 32767);
export const cityIdQuerySchema = queryInt(1, 32767);

const lotFieldsSchema = z.strictObject({
  title: textSchema(LOT_RULES.titleMin, LOT_RULES.titleMax),
  description: textSchema(0, LOT_RULES.descriptionMax),
  categoryId: categoryIdSchema,
  cityId: cityIdSchema,
  condition: itemConditionSchema,
  startPrice: positiveKopecksSchema,
  reservePrice: kopecksSchema.nullable().default(null),
  buyNowPrice: kopecksSchema.nullable().default(null),
  durationDays: z.number().int().min(LOT_RULES.minDurationDays).max(LOT_RULES.maxDurationDays),
});

type LotFields = z.infer<typeof lotFieldsSchema>;

/** Cross-field price rules, shared by create and full update. */
const checkPrices = (lot: LotFields, ctx: z.RefinementCtx) => {
  if (lot.reservePrice !== null && lot.reservePrice < lot.startPrice) {
    ctx.addIssue({ code: 'custom', path: ['reservePrice'], message: 'RESERVE_BELOW_START' });
  }
  if (lot.buyNowPrice !== null) {
    if (lot.buyNowPrice <= lot.startPrice) {
      ctx.addIssue({ code: 'custom', path: ['buyNowPrice'], message: 'BUY_NOW_NOT_ABOVE_START' });
    }
    if (lot.reservePrice !== null && lot.buyNowPrice < lot.reservePrice) {
      ctx.addIssue({ code: 'custom', path: ['buyNowPrice'], message: 'BUY_NOW_BELOW_RESERVE' });
    }
  }
};

export const lotCreateInputSchema = lotFieldsSchema.superRefine(checkPrices);
export const lotUpdateInputSchema = lotFieldsSchema.superRefine(checkPrices);

/** After the first bid the seller may only append to the description. */
export const lotAppendDescriptionInputSchema = z.strictObject({
  text: textSchema(1, LOT_RULES.descriptionAppendMax),
});

export const lotRejectInputSchema = z.strictObject({
  reason: textSchema(LOT_RULES.rejectReasonMin, LOT_RULES.rejectReasonMax),
});

export const lotRemoveInputSchema = lotRejectInputSchema;

export const shipInputSchema = z.strictObject({
  trackingNumber: textSchema(3, LOT_RULES.trackingNumberMax).regex(/^[A-Za-z0-9\- ]+$/, {
    error: 'TRACKING_NUMBER_INVALID',
  }),
});

export const photoPresignInputSchema = z.strictObject({
  contentType: z.enum(LOT_RULES.photoContentTypes),
  size: z.number().int().min(1).max(LOT_RULES.maxPhotoBytes, { error: 'PHOTO_TOO_LARGE' }),
});

export type LotCreateInput = z.infer<typeof lotCreateInputSchema>;
export type LotUpdateInput = z.infer<typeof lotUpdateInputSchema>;
export type PhotoPresignInput = z.infer<typeof photoPresignInputSchema>;
