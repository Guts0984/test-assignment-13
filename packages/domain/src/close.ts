import { depositFor } from '@auction/shared';
import { idempotent } from './idempotency.js';
import { book, ensureWallet, lockBalances } from './ledger.js';
import {
  appendEvent,
  audit,
  lockLot,
  notify,
  publicState,
  queueEmail,
  queueLotSync,
  requireTrader,
  type LotRow,
} from './support.js';
import { withTx } from './tx.js';
import { NO_EFFECTS, type Deps, type Notification, type Outcome, type Tx } from './types.js';

/** Releases every deposit still held on the lot (leader after an unsold close, or all on removal). */
export const releaseHeldDeposits = async (
  tx: Tx,
  lotId: string,
  at: Date,
  tag: string,
): Promise<string[]> => {
  const { rows } = await tx.query<{ id: string; user_id: string; amount: number }>(
    `SELECT id, user_id, amount FROM deposits WHERE lot_id = $1 AND status = 'held' ORDER BY user_id FOR UPDATE`,
    [lotId],
  );
  const released: string[] = [];
  for (const d of rows) {
    const w = await ensureWallet(tx, d.user_id);
    await lockBalances(tx, [w.available, w.held]);
    await book(tx, {
      kind: 'release',
      ref: `release:${lotId}:${d.user_id}:${tag}`,
      lotId,
      userId: d.user_id,
      at,
      entries: [
        { account: w.held, amount: -d.amount },
        { account: w.available, amount: d.amount },
      ],
    });
    await tx.query(`UPDATE deposits SET status = 'released', resolved_at = $2 WHERE id = $1`, [
      d.id,
      at,
    ]);
    released.push(d.user_id);
  }
  return released;
};

export type CloseResult =
  | {
      readonly status: 'sold';
      readonly buyerId: string;
      readonly price: number;
      readonly paymentDueAt: string;
    }
  | { readonly status: 'unsold'; readonly reason: 'no_bids' | 'reserve_not_met' }
  | { readonly status: 'noop'; readonly reason: 'not_active' | 'not_yet_over' };

/**
 * Closes a lot whose time is up. Safe to call any number of times, from any number of workers,
 * with stale or duplicate jobs: the decision is made from the lot row under its lock and from
 * the SERVER clock, never from the job's payload.
 *   - not active (already closed/removed)  → noop
 *   - ends_at is still in the future (it was extended after the job was queued) → noop
 */
export const closeLot = (deps: Deps, lotId: string): Promise<Outcome<CloseResult>> =>
  withTx(deps.pool, async (tx): Promise<Outcome<CloseResult>> => {
    const now = deps.clock.now();
    const lot = await lockLot(tx, lotId);
    if (lot.status !== 'active')
      return { result: { status: 'noop', reason: 'not_active' }, effects: NO_EFFECTS };
    if (!lot.ends_at || lot.ends_at.getTime() > now.getTime()) {
      return { result: { status: 'noop', reason: 'not_yet_over' }, effects: NO_EFFECTS };
    }

    const notifications: Notification[] = [];
    const hasWinner =
      lot.bid_count > 0 &&
      lot.leader_id !== null &&
      (lot.reserve_price === null || lot.current_price >= lot.reserve_price);

    if (!hasWinner) {
      await releaseHeldDeposits(tx, lot.id, now, 'unsold');
      await tx.query(
        `UPDATE lots SET status = 'ended_unsold', event_seq = event_seq + 1, version = version + 1, updated_at = $2 WHERE id = $1`,
        [lot.id, now],
      );
      const event = await appendEvent(
        tx,
        lot,
        1,
        'closed',
        { status: 'ended_unsold', ...publicState(lot) },
        now,
      );
      await audit(tx, lot.id, null, 'closed_unsold', now);
      notifications.push(
        await notify(
          tx,
          {
            userId: lot.seller_id,
            kind: 'lot_unsold',
            payload: { lotId: lot.id, title: lot.title },
          },
          now,
        ),
      );
      await queueEmail(
        tx,
        {
          userId: lot.seller_id,
          kind: 'lot_unsold',
          dedupeKey: `unsold:${lot.id}`,
          payload: { lotId: lot.id, title: lot.title },
        },
        now,
      );
      await queueLotSync(tx, lot.id, now);
      return {
        result: { status: 'unsold', reason: lot.bid_count === 0 ? 'no_bids' : 'reserve_not_met' },
        effects: { events: [event], notifications },
      };
    }

    const due = new Date(now.getTime() + deps.timings.paymentWindowMs);
    const buyerId = lot.leader_id as string;
    await tx.query(
      `UPDATE lots SET status = 'awaiting_payment', buyer_id = $2, final_price = $3, sold_at = $4,
              payment_due_at = $5, event_seq = event_seq + 1, version = version + 1, updated_at = $4
        WHERE id = $1`,
      [lot.id, buyerId, lot.current_price, now, due],
    );
    const event = await appendEvent(
      tx,
      lot,
      1,
      'closed',
      { status: 'awaiting_payment', ...publicState(lot) },
      now,
    );
    await audit(tx, lot.id, null, 'closed_sold', now, { price: lot.current_price });
    notifications.push(
      await notify(
        tx,
        {
          userId: buyerId,
          kind: 'won',
          payload: {
            lotId: lot.id,
            title: lot.title,
            price: lot.current_price,
            payBy: due.toISOString(),
          },
        },
        now,
      ),
      await notify(
        tx,
        {
          userId: lot.seller_id,
          kind: 'lot_sold',
          payload: { lotId: lot.id, title: lot.title, price: lot.current_price },
        },
        now,
      ),
    );
    await queueEmail(
      tx,
      {
        userId: buyerId,
        kind: 'won',
        dedupeKey: `won:${lot.id}:${buyerId}`,
        payload: {
          lotId: lot.id,
          title: lot.title,
          price: lot.current_price,
          payBy: due.toISOString(),
        },
      },
      now,
    );
    await queueEmail(
      tx,
      {
        userId: lot.seller_id,
        kind: 'lot_sold',
        dedupeKey: `sold:${lot.id}`,
        payload: { lotId: lot.id, title: lot.title, price: lot.current_price },
      },
      now,
    );
    await queueLotSync(tx, lot.id, now);
    return {
      result: {
        status: 'sold',
        buyerId,
        price: lot.current_price,
        paymentDueAt: due.toISOString(),
      },
      effects: { events: [event], notifications },
    };
  });

// -------------------------------------------------------------------------------------------
// Buy now
// -------------------------------------------------------------------------------------------

export type BuyNowResult =
  | { readonly ok: true; readonly price: number; readonly paymentDueAt: string }
  | {
      readonly ok: false;
      readonly reason:
        'LOT_NOT_ACTIVE' | 'LOT_ENDED' | 'OWN_LOT' | 'BUY_NOW_UNAVAILABLE' | 'INSUFFICIENT_FUNDS';
    };

/**
 * "Buy now" is allowed only while the lot has no bids. It locks the same deposit a winning bid
 * would, closes the lot at once and gives the buyer the usual 48 hours to pay. It takes the same
 * lot row lock as bidding, so a bid and a buy-now racing each other are strictly ordered:
 * whichever gets the lock first wins, and the other sees the lot as taken.
 */
export const buyNow = (
  deps: Deps,
  input: { lotId: string; userId: string; idempotencyKey: string },
) =>
  idempotent<BuyNowResult>(
    deps,
    {
      userId: input.userId,
      scope: 'buy_now',
      key: input.idempotencyKey,
      body: { lotId: input.lotId },
    },
    async (tx): Promise<Outcome<BuyNowResult>> => {
      const now = deps.clock.now();
      const lot: LotRow = await lockLot(tx, input.lotId);
      await requireTrader(tx, input.userId);
      const reject = (
        reason: Extract<BuyNowResult, { ok: false }>['reason'],
      ): Outcome<BuyNowResult> => ({
        result: { ok: false, reason },
        effects: NO_EFFECTS,
      });
      if (lot.status !== 'active') return reject('LOT_NOT_ACTIVE');
      if (!lot.ends_at || lot.ends_at.getTime() <= now.getTime()) return reject('LOT_ENDED');
      if (lot.seller_id === input.userId) return reject('OWN_LOT');
      if (lot.bid_count > 0 || lot.buy_now_price === null) return reject('BUY_NOW_UNAVAILABLE');

      const price = lot.buy_now_price;
      const deposit = depositFor(price);
      const w = await ensureWallet(tx, input.userId);
      const balances = await lockBalances(tx, [w.available, w.held]);
      if ((balances.get(w.available) ?? 0) < deposit) return reject('INSUFFICIENT_FUNDS');

      await book(tx, {
        kind: 'hold',
        ref: `hold:${lot.id}:${input.userId}:buy_now`,
        lotId: lot.id,
        userId: input.userId,
        at: now,
        entries: [
          { account: w.available, amount: -deposit },
          { account: w.held, amount: deposit },
        ],
      });
      await tx.query(
        `INSERT INTO deposits (lot_id, user_id, amount, created_at) VALUES ($1, $2, $3, $4)`,
        [lot.id, input.userId, deposit, now],
      );
      const due = new Date(now.getTime() + deps.timings.paymentWindowMs);
      await tx.query(
        `UPDATE lots SET status = 'awaiting_payment', buyer_id = $2, final_price = $3, sold_at = $4,
                payment_due_at = $5, event_seq = event_seq + 1, version = version + 1, updated_at = $4
          WHERE id = $1`,
        [lot.id, input.userId, price, now, due],
      );
      const event = await appendEvent(
        tx,
        lot,
        1,
        'closed',
        { status: 'awaiting_payment', via: 'buy_now', ...publicState(lot) },
        now,
      );
      await audit(tx, lot.id, input.userId, 'buy_now', now, { price });
      const notifications = [
        await notify(
          tx,
          {
            userId: lot.seller_id,
            kind: 'lot_sold',
            payload: { lotId: lot.id, title: lot.title, price },
          },
          now,
        ),
        await notify(
          tx,
          {
            userId: input.userId,
            kind: 'won',
            payload: { lotId: lot.id, title: lot.title, price, payBy: due.toISOString() },
          },
          now,
        ),
      ];
      await queueEmail(
        tx,
        {
          userId: lot.seller_id,
          kind: 'lot_sold',
          dedupeKey: `sold:${lot.id}`,
          payload: { lotId: lot.id, title: lot.title, price },
        },
        now,
      );
      await queueLotSync(tx, lot.id, now);
      return {
        result: { ok: true, price, paymentDueAt: due.toISOString() },
        effects: { events: [event], notifications },
      };
    },
  );
