import { z } from 'zod';

export const uuidSchema = z.uuid({ error: 'INVALID_ID' });

/** Idempotency-Key header: 8–128 printable token characters. */
export const idempotencyKeySchema = z
  .string()
  .min(8, { error: 'IDEMPOTENCY_KEY_TOO_SHORT' })
  .max(128, { error: 'IDEMPOTENCY_KEY_TOO_LONG' })
  .regex(/^[A-Za-z0-9_\-:.]+$/, { error: 'IDEMPOTENCY_KEY_INVALID_CHARS' });

/**
 * Integer from a URL query: a real number or a plain digit string ("12"). Never `z.coerce`,
 * because Number() happily turns [1], true, null and "" into numbers.
 */
export const queryInt = (min: number, max: number) =>
  z
    .union([
      z.number(),
      z
        .string()
        .regex(/^-?\d{1,15}$/, { error: 'NOT_AN_INTEGER' })
        .transform(Number),
    ])
    .pipe(z.number().int().min(min).max(max));

export const pageSchema = queryInt(1, 1000).default(1);
export const pageSizeSchema = queryInt(1, 100).default(24);

export const paginationQuerySchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
});

/** Accepts "a,b,c", ["a","b"] or a single value from a URL query and returns a unique array. */
export const csvArray = <T extends z.ZodType>(item: T) =>
  z.preprocess((raw) => {
    if (raw === undefined || raw === '') return undefined;
    const list: unknown[] = Array.isArray(raw)
      ? raw
      : typeof raw === 'string' || typeof raw === 'number'
        ? String(raw).split(',')
        : [raw];
    // Non-scalar items (e.g. `?category[a]=1` parsed into an object) are passed through
    // untouched so the item schema rejects them instead of seeing "[object Object]".
    const cleaned = list.map((v) => (typeof v === 'string' ? v.trim() : v));
    return [...new Set(cleaned.filter((v) => v !== ''))];
  }, z.array(item).max(50).optional());

/** "true"/"1" → true, "false"/"0"/absent → false. Anything else is a validation error. */
export const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => v === true || v === 'true' || v === '1');

/** Plain text field: trimmed, no control characters except newline/tab. */
export const textSchema = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    // eslint-disable-next-line no-control-regex -- the point is to reject control characters
    .refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), {
      error: 'CONTROL_CHARACTERS',
    });
