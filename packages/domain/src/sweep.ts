import { autoConfirmLot, expirePayment } from './payments.js';
import { closeLot } from './close.js';
import { sweepExpiredClaims } from './moderation.js';
import { mergeEffects, type Deps, type Effects } from './types.js';

/**
 * Everything that is "due" according to Postgres and the clock. This is the single source of
 * truth for timers: BullMQ jobs are only an optimisation to run these sooner. If Redis loses every
 * job, a sweep finds the same lots and the same handlers do the same work, once.
 */
export type DueWork = {
  readonly toClose: readonly string[];
  readonly paymentsExpired: readonly string[];
  readonly toAutoConfirm: readonly string[];
};

export const findDueWork = async (deps: Deps, limit = 200): Promise<DueWork> => {
  const now = deps.clock.now();
  const confirmBefore = new Date(now.getTime() - deps.timings.autoConfirmMs);
  const ids = async (sql: string, params: unknown[]) =>
    (await deps.pool.query<{ id: string }>(sql, params)).rows.map((r) => r.id);
  return {
    toClose: await ids(
      `SELECT id FROM lots WHERE status = 'active' AND ends_at <= $1 ORDER BY ends_at LIMIT $2`,
      [now, limit],
    ),
    paymentsExpired: await ids(
      `SELECT id FROM lots WHERE status = 'awaiting_payment' AND payment_due_at <= $1 ORDER BY payment_due_at LIMIT $2`,
      [now, limit],
    ),
    toAutoConfirm: await ids(
      `SELECT id FROM lots WHERE status = 'shipped' AND shipped_at <= $1 ORDER BY shipped_at LIMIT $2`,
      [confirmBefore, limit],
    ),
  };
};

export type SweepReport = {
  readonly closed: number;
  readonly paymentsExpired: number;
  readonly autoConfirmed: number;
  readonly claimsReleased: number;
  readonly effects: Effects;
};

/** One pass over everything due. Handlers are idempotent, so passes may overlap or repeat. */
export const runSweep = async (deps: Deps): Promise<SweepReport> => {
  const due = await findDueWork(deps);
  const all: Effects[] = [];
  let closed = 0;
  let expired = 0;
  let confirmed = 0;
  for (const id of due.toClose) {
    const r = await closeLot(deps, id);
    if (r.result.status !== 'noop') closed++;
    all.push(r.effects);
  }
  for (const id of due.paymentsExpired) {
    const r = await expirePayment(deps, id);
    if (r.result.status !== 'noop') expired++;
    all.push(r.effects);
  }
  for (const id of due.toAutoConfirm) {
    const r = await autoConfirmLot(deps, id);
    if (r.result.status !== 'noop') confirmed++;
    all.push(r.effects);
  }
  const claimsReleased = await sweepExpiredClaims(deps);
  return {
    closed,
    paymentsExpired: expired,
    autoConfirmed: confirmed,
    claimsReleased,
    effects: mergeEffects(...all),
  };
};
