import { type Kopecks, percentCeil, percentFloor } from '../money/money.js';

/**
 * Bid step by current price (all values in kopecks):
 *   price <    100 ₴ →   5 ₴
 *   price <  1 000 ₴ →  10 ₴
 *   price < 10 000 ₴ →  50 ₴
 *   otherwise        → 100 ₴
 */
export const BID_STEP_TABLE: readonly { readonly below: number; readonly step: Kopecks }[] = [
  { below: 100_00, step: 5_00 },
  { below: 1_000_00, step: 10_00 },
  { below: 10_000_00, step: 50_00 },
  { below: Number.POSITIVE_INFINITY, step: 100_00 },
];

export const bidStep = (price: Kopecks): Kopecks => {
  for (const row of BID_STEP_TABLE) {
    if (price < row.below) return row.step;
  }
  /* c8 ignore next */
  throw new Error('unreachable: BID_STEP_TABLE ends with Infinity');
};

/** Deposit: 10% of the max bid (rounded up to a kopeck), never less than 50 ₴. */
export const DEPOSIT_PERCENT = 10;
export const DEPOSIT_MIN: Kopecks = 50_00;

export const depositFor = (maxBid: Kopecks): Kopecks =>
  Math.max(percentCeil(maxBid, DEPOSIT_PERCENT), DEPOSIT_MIN);

/**
 * Commission: 5% of the sale price, never less than 10 ₴, rounded in the seller's favour
 * (down to a kopeck). It can never exceed the sale price itself.
 */
export const COMMISSION_PERCENT = 5;
export const COMMISSION_MIN: Kopecks = 10_00;

export const commissionFor = (salePrice: Kopecks): Kopecks =>
  Math.min(Math.max(percentFloor(salePrice, COMMISSION_PERCENT), COMMISSION_MIN), salePrice);

export const sellerPayoutFor = (salePrice: Kopecks): Kopecks =>
  salePrice - commissionFor(salePrice);

/** Lot listing constraints. */
export const LOT_RULES = {
  minDurationDays: 1,
  maxDurationDays: 10,
  maxPhotos: 10,
  maxPhotoBytes: 10 * 1024 * 1024,
  photoContentTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
  previewWidthPx: 400,
  titleMin: 3,
  titleMax: 120,
  descriptionMax: 5000,
  descriptionAppendMax: 2000,
  rejectReasonMin: 3,
  rejectReasonMax: 500,
  trackingNumberMax: 64,
} as const;

export type PhotoContentType = (typeof LOT_RULES.photoContentTypes)[number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Every duration the rules talk about. Defaults are the assignment's values; processes may
 * override them from env (see each app's env.ts) so tests can compress time.
 */
export const DEFAULT_TIMINGS = {
  antiSnipeMs: 2 * MINUTE,
  paymentWindowMs: 48 * HOUR,
  offerWindowMs: 24 * HOUR,
  reviewClaimMs: 15 * MINUTE,
  autoConfirmMs: 7 * DAY,
  outbidEmailThrottleMs: 15 * MINUTE,
  favoriteReminderMs: 1 * HOUR,
} as const;

export type Timings = { readonly [K in keyof typeof DEFAULT_TIMINGS]: number };

export const DAY_MS = DAY;
