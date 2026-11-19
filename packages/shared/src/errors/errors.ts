import { z } from 'zod';

/**
 * Every error the API can return. One flat list, so clients can switch on `code` and translate it.
 * HTTP status is part of the definition: the same code always means the same status.
 */
export const ERROR_DEFINITIONS = {
  // 400 — malformed input
  VALIDATION_FAILED: 400,
  MALFORMED_JSON: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  // 401 / 403
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  CSRF_REJECTED: 403,
  STAFF_CANNOT_TRADE: 403,
  // 404
  NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  // 409 — valid request, conflicting state
  CONFLICT: 409,
  EMAIL_TAKEN: 409,
  LOT_NOT_ACTIVE: 409,
  LOT_ENDED: 409,
  LOT_STATUS_CONFLICT: 409,
  LOT_NOT_EDITABLE: 409,
  OWN_LOT: 409,
  BID_TOO_LOW: 409,
  BID_NOT_ABOVE_OWN_MAX: 409,
  BID_INVALID_AMOUNT: 409,
  BUY_NOW_UNAVAILABLE: 409,
  INSUFFICIENT_FUNDS: 409,
  PAYMENT_NOT_DUE: 409,
  PAYMENT_WINDOW_CLOSED: 409,
  REVIEW_CLAIM_LOST: 409,
  REVIEW_QUEUE_EMPTY: 409,
  PHOTO_LIMIT_REACHED: 409,
  PHOTO_NOT_READY: 409,
  // 413 / 415
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  // 422 — semantically invalid
  IDEMPOTENCY_KEY_REUSED: 422,
  WEBHOOK_SIGNATURE_INVALID: 422,
  // 429
  RATE_LIMITED: 429,
  ACCOUNT_LOCKED: 429,
  // 5xx — infrastructure, never caused by input
  SEARCH_UNAVAILABLE: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_DEFINITIONS;
export const ERROR_CODES = Object.keys(ERROR_DEFINITIONS) as [ErrorCode, ...ErrorCode[]];
export const errorCodeSchema = z.enum(ERROR_CODES);

export const httpStatusFor = (code: ErrorCode): number => ERROR_DEFINITIONS[code];

export const errorDetailSchema = z.object({
  /** Dotted path to the offending field, e.g. "photos.2.size". Empty for the whole body. */
  path: z.string(),
  /** Machine-readable reason, e.g. "too_small", "MONEY_NOT_INTEGER_KOPECKS". */
  code: z.string(),
  message: z.string(),
});

/** The one error body used by every endpoint (and documented as such in OpenAPI). */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    /** Extra data clients may use, e.g. `{ minNextBid }` for BID_TOO_LOW. */
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }),
  requestId: z.string(),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * A domain error as plain data (no classes). Thrown values are created with `appError` so that
 * the API's exception filter can recognise them by the brand.
 */
export type AppError = Error & {
  readonly __appError: true;
  readonly code: ErrorCode;
  readonly details?: readonly ErrorDetail[];
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
};

export const appError = (
  code: ErrorCode,
  message: string,
  extra: { details?: readonly ErrorDetail[]; meta?: AppError['meta'] } = {},
): AppError =>
  Object.assign(new Error(message), {
    __appError: true as const,
    code,
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
  });

export const isAppError = (value: unknown): value is AppError =>
  value instanceof Error && (value as Partial<AppError>).__appError === true;

/** Converts Zod issues into the API detail format. */
export const zodIssuesToDetails = (issues: readonly z.core.$ZodIssue[]): ErrorDetail[] =>
  issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    code:
      issue.code === 'custom'
        ? 'custom'
        : issue.message.match(/^[A-Z_]+$/)
          ? issue.message
          : issue.code,
    message: issue.message,
  }));
