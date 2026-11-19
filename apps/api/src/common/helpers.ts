import type { Effects } from '@auction/domain';
import { appError, type ErrorCode } from '@auction/shared';
import { z } from 'zod';
import type { Ctx } from '../core/context.js';
import { parse, type Req } from './http.js';

export const emit = (ctx: Ctx, effects: Effects): void =>
  ctx.emitter.emit(effects, ctx.clock.now().getTime());
export const uid = (req: Req): string => {
  if (!req.user) throw appError('UNAUTHENTICATED', 'sign in first');
  return req.user.id;
};
export const uuidParam = (v: string): string => parse(z.uuid({ error: 'INVALID_ID' }), v);

/**
 * A domain "refusal" result becomes the standard error (HTTP 409 etc.) with the minimum next bid attached.
 * INSUFFICIENT_FUNDS never carries minNextBid: the domain reports the current price there, which is not a
 * bid the user could place to fix the problem (they need to top up, not to bid more). The domain result does
 * not expose the required deposit, so nothing is attached.
 */
export const refuse = (reason: string, minNextBid?: number): never => {
  const useful = reason !== 'INSUFFICIENT_FUNDS' && minNextBid !== undefined;
  throw appError(
    reason as ErrorCode,
    reason.toLowerCase().replaceAll('_', ' '),
    useful ? { meta: { minNextBid } } : {},
  );
};
