import { z } from 'zod';
import { DEFAULT_TIMINGS, type Timings } from '../rules/rules.js';

/**
 * Helpers every process uses in its own env.ts. Rule of thumb:
 * - non-sensitive settings get a default here or in the app's schema;
 * - secrets are `secretSchema` and have NO default, so a missing secret stops the process.
 */

export const envBoolean = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

export const envPositiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

/** A secret: required, at least 16 chars, never logged. */
export const secretSchema = z.string().min(16, { error: 'SECRET_TOO_SHORT_MIN_16' });

export const timingsEnvShape = {
  ANTI_SNIPE_MS: envPositiveInt(DEFAULT_TIMINGS.antiSnipeMs),
  PAYMENT_WINDOW_MS: envPositiveInt(DEFAULT_TIMINGS.paymentWindowMs),
  OFFER_WINDOW_MS: envPositiveInt(DEFAULT_TIMINGS.offerWindowMs),
  REVIEW_CLAIM_MS: envPositiveInt(DEFAULT_TIMINGS.reviewClaimMs),
  AUTO_CONFIRM_MS: envPositiveInt(DEFAULT_TIMINGS.autoConfirmMs),
  OUTBID_EMAIL_THROTTLE_MS: envPositiveInt(DEFAULT_TIMINGS.outbidEmailThrottleMs),
  FAVORITE_REMINDER_MS: envPositiveInt(DEFAULT_TIMINGS.favoriteReminderMs),
} as const;

type TimingsEnv = { [K in keyof typeof timingsEnvShape]: number };

export const timingsFromEnv = (env: TimingsEnv): Timings => ({
  antiSnipeMs: env.ANTI_SNIPE_MS,
  paymentWindowMs: env.PAYMENT_WINDOW_MS,
  offerWindowMs: env.OFFER_WINDOW_MS,
  reviewClaimMs: env.REVIEW_CLAIM_MS,
  autoConfirmMs: env.AUTO_CONFIRM_MS,
  outbidEmailThrottleMs: env.OUTBID_EMAIL_THROTTLE_MS,
  favoriteReminderMs: env.FAVORITE_REMINDER_MS,
});

/**
 * Parses env with a Zod schema. On failure, throws one error that lists every bad variable
 * by name and reason — but never echoes the values (they may be secrets).
 */
export const parseEnv = <S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined>,
): z.infer<S> => {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map(
    (issue) => `  - ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`Invalid environment:\n${lines.join('\n')}`);
};
