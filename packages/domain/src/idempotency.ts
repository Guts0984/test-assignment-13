import { createHash } from 'node:crypto';
import { appError } from '@auction/shared';
import type { Deps, Effects, Outcome, Tx } from './types.js';
import { NO_EFFECTS } from './types.js';
import { withTx } from './tx.js';

/** Stable JSON: object keys sorted, so the same body always hashes the same. */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};

export const requestHash = (body: unknown): string =>
  createHash('sha256').update(canonical(body)).digest('hex');

export type IdempotentCall = {
  readonly userId: string;
  /** The operation: 'bid', 'buy_now', 'pay', 'topup'. Part of the key. */
  readonly scope: string;
  readonly key: string;
  /** Everything that identifies the request (including ids such as the lot). */
  readonly body: unknown;
};

export type IdempotentResult<T> = {
  readonly result: T;
  readonly effects: Effects;
  /** True when a previous call with the same key already did the work. */
  readonly replayed: boolean;
};

/**
 * Runs `op` at most once per (user, scope, key):
 *  - first call: runs `op` and stores its result IN THE SAME TRANSACTION as its writes;
 *  - same key, same body: returns the stored result, writes nothing, no effects to re-emit;
 *  - same key, different body: IDEMPOTENCY_KEY_REUSED.
 * A transaction-scoped advisory lock serialises concurrent calls with one key, so two parallel
 * retries cannot both execute.
 * `op` must return JSON-serialisable data as its result.
 */
export const idempotent = <T>(
  deps: Deps,
  call: IdempotentCall,
  op: (tx: Tx) => Promise<Outcome<T>>,
): Promise<IdempotentResult<T>> =>
  withTx(deps.pool, async (tx) => {
    const hash = requestHash(call.body);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${call.userId}|${call.scope}|${call.key}`,
    ]);
    const existing = await tx.query<{ request_hash: string; response: T }>(
      `SELECT request_hash, response FROM idempotency_keys WHERE user_id = $1 AND scope = $2 AND key = $3`,
      [call.userId, call.scope, call.key],
    );
    const row = existing.rows[0];
    if (row) {
      if (row.request_hash !== hash) {
        throw appError(
          'IDEMPOTENCY_KEY_REUSED',
          'this Idempotency-Key was already used with a different request',
        );
      }
      return { result: row.response, effects: NO_EFFECTS, replayed: true };
    }
    const outcome = await op(tx);
    await tx.query(
      `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status_code, response, created_at)
       VALUES ($1, $2, $3, $4, 200, $5, $6)`,
      [call.userId, call.scope, call.key, hash, JSON.stringify(outcome.result), deps.clock.now()],
    );
    return { result: outcome.result, effects: outcome.effects, replayed: false };
  });
