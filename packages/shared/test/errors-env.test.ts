import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  appError,
  DEFAULT_TIMINGS,
  ERROR_CODES,
  envBoolean,
  errorResponseSchema,
  httpStatusFor,
  isAppError,
  lotCreateInputSchema,
  parseEnv,
  secretSchema,
  timingsEnvShape,
  timingsFromEnv,
  zodIssuesToDetails,
} from '../src/index.js';

describe('errors', () => {
  it('every code maps to a 4xx/5xx status, and only infrastructure codes are 5xx', () => {
    for (const code of ERROR_CODES) {
      const status = httpStatusFor(code);
      expect(status).toBeGreaterThanOrEqual(400);
      if (status >= 500)
        expect(['INTERNAL', 'SEARCH_UNAVAILABLE', 'SERVICE_UNAVAILABLE']).toContain(code);
    }
  });

  it('appError is recognised; look-alikes are not', () => {
    const err = appError('BID_TOO_LOW', 'too low', { meta: { minNextBid: 1000 } });
    expect(isAppError(err)).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err.meta).toEqual({ minNextBid: 1000 });
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError({ __appError: true, code: 'INTERNAL', message: 'fake' })).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it('zod issues become details with machine codes', () => {
    const r = lotCreateInputSchema.safeParse({ title: 'ok title', startPrice: 1.5 });
    expect(r.success).toBe(false);
    const details = zodIssuesToDetails(r.error!.issues);
    expect(details).toContainEqual({
      path: 'startPrice',
      code: 'MONEY_NOT_INTEGER_KOPECKS',
      message: 'MONEY_NOT_INTEGER_KOPECKS',
    });
    expect(details.find((d) => d.path === 'condition')?.code).toBe('invalid_value');
    const body = {
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input', details },
      requestId: 'r1',
    };
    expect(errorResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe('env helpers', () => {
  const schema = z.object({
    DATABASE_URL: z.url(),
    SESSION_SECRET: secretSchema,
    PORT: z.coerce.number().int().default(3000),
    FLAG: envBoolean,
    ...timingsEnvShape,
  });

  it('applies defaults for non-sensitive values', () => {
    const env = parseEnv(schema, {
      DATABASE_URL: 'postgres://u:p@h/db',
      SESSION_SECRET: 'x'.repeat(32),
    });
    expect(env.PORT).toBe(3000);
    expect(env.FLAG).toBe(false);
    expect(timingsFromEnv(env)).toEqual(DEFAULT_TIMINGS);
  });

  it('overrides timings from env strings', () => {
    const env = parseEnv(schema, {
      DATABASE_URL: 'postgres://u:p@h/db',
      SESSION_SECRET: 'x'.repeat(32),
      ANTI_SNIPE_MS: '1500',
      FLAG: '1',
    });
    expect(timingsFromEnv(env).antiSnipeMs).toBe(1500);
    expect(env.FLAG).toBe(true);
  });

  it('lists every bad variable and never echoes a secret value', () => {
    const leaked = 'hunter2-short';
    let message = '';
    try {
      parseEnv(schema, {
        SESSION_SECRET: leaked,
        PORT: 'eighty',
        ANTI_SNIPE_MS: '-5',
        FLAG: 'maybe',
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('SESSION_SECRET: SECRET_TOO_SHORT_MIN_16');
    expect(message).toContain('PORT');
    expect(message).toContain('ANTI_SNIPE_MS');
    expect(message).toContain('FLAG');
    expect(message).not.toContain(leaked);
  });
});
