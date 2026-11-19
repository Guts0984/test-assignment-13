import { appError, commissionFor, depositFor } from '@auction/shared';
import { releaseHeldDeposits } from './close.js';
import { idempotent } from './idempotency.js';
import { book, ensureEscrow, ensureSystemAccounts, ensureWallet, lockBalances } from './ledger.js';
import {
  appendEvent,
  audit,
  lockLot,
  notify,
  queueEmail,
  queueLotSync,
  requireTrader,
} from './support.js';
import { withTx } from './tx.js';
import { NO_EFFECTS, type Deps, type Notification, type Outcome, type Tx } from './types.js';

export type PayResult =
  | { readonly ok: true; readonly price: number; readonly paidAt: string }
  | {
      readonly ok: false;
      readonly reason: 'PAYMENT_NOT_DUE' | 'PAYMENT_WINDOW_CLOSED' | 'INSUFFICIENT_FUNDS';
    };

/**
 * The winner (or the current second-chance offeree) pays from their wallet. The deposit already
 * held for the lot counts toward the price; if it was larger than the price, the surplus goes
 * back to the available balance. All in one ledger transaction.
 */
export const payForLot = (
  deps: Deps,
  input: { lotId: string; userId: string; idempotencyKey: string },
) =>
  idempotent<PayResult>(
    deps,
    { userId: input.userId, scope: 'pay', key: input.idempotencyKey, body: { lotId: input.lotId } },
    async (tx): Promise<Outcome<PayResult>> => {
      const now = deps.clock.now();
      const lot = await lockLot(tx, input.lotId);
      await requireTrader(tx, input.userId);
      const reject = (reason: Extract<PayResult, { ok: false }>['reason']): Outcome<PayResult> => ({
        result: { ok: false, reason },
        effects: NO_EFFECTS,
      });
      if (
        lot.status !== 'awaiting_payment' ||
        lot.buyer_id !== input.userId ||
        lot.final_price === null
      ) {
        return reject('PAYMENT_NOT_DUE');
      }
      if (!lot.payment_due_at || lot.payment_due_at.getTime() < now.getTime()) {
        return reject('PAYMENT_WINDOW_CLOSED');
      }

      const price = lot.final_price;
      const dep = (
        await tx.query<{ id: string; amount: number }>(
          `SELECT id, amount FROM deposits WHERE lot_id = $1 AND user_id = $2 AND status = 'held'`,
          [lot.id, input.userId],
        )
      ).rows[0];
      const held = dep?.amount ?? 0;
      const toPay = price - held; // negative when the deposit exceeded the price

      const w = await ensureWallet(tx, input.userId);
      const escrow = await ensureEscrow(tx, lot.id);
      const balances = await lockBalances(tx, [w.available, w.held, escrow]);
      if (toPay > 0 && (balances.get(w.available) ?? 0) < toPay)
        return reject('INSUFFICIENT_FUNDS');

      await book(tx, {
        kind: 'pay',
        ref: `pay:${lot.id}`,
        lotId: lot.id,
        userId: input.userId,
        at: now,
        entries: [
          { account: w.held, amount: -held },
          { account: w.available, amount: -toPay },
          { account: escrow, amount: price },
        ],
      });
      if (dep) {
        await tx.query(`UPDATE deposits SET status = 'applied', resolved_at = $2 WHERE id = $1`, [
          dep.id,
          now,
        ]);
      }
      await tx.query(
        `UPDATE second_chance_offers SET status = 'accepted', resolved_at = $3
          WHERE lot_id = $1 AND user_id = $2 AND status = 'pending'`,
        [lot.id, input.userId, now],
      );
      await tx.query(
        `UPDATE lots SET status = 'paid', paid_at = $2, event_seq = event_seq + 1, version = version + 1, updated_at = $2 WHERE id = $1`,
        [lot.id, now],
      );
      const event = await appendEvent(tx, lot, 1, 'status', { status: 'paid' }, now);
      await audit(tx, lot.id, input.userId, 'paid', now, { price });
      const notifications = [
        await notify(
          tx,
          {
            userId: lot.seller_id,
            kind: 'lot_paid',
            payload: { lotId: lot.id, title: lot.title, price },
          },
          now,
        ),
      ];
      await queueEmail(
        tx,
        {
          userId: lot.seller_id,
          kind: 'lot_paid',
          dedupeKey: `paid:${lot.id}`,
          payload: { lotId: lot.id, title: lot.title, price },
        },
        now,
      );
      await queueLotSync(tx, lot.id, now);
      return {
        result: { ok: true, price, paidAt: now.toISOString() },
        effects: { events: [event], notifications },
      };
    },
  );

// -------------------------------------------------------------------------------------------
// Non-payment and the second chance
// -------------------------------------------------------------------------------------------

export type ExpireResult =
  | { readonly status: 'noop'; readonly reason: 'not_awaiting' | 'not_due_yet' }
  | {
      readonly status: 'offered';
      readonly userId: string;
      readonly price: number;
      readonly expiresAt: string;
    }
  | { readonly status: 'unsold' };

/**
 * The payment (or offer) deadline passed. Idempotent and clock-driven, like closing:
 *  1. the current buyer's deposit goes to the seller (a second-chance offeree has none);
 *  2. the lot is offered to the participant with the next-highest maximum, for 24 hours, at that
 *     maximum - only if that maximum reaches the hidden reserve (if any) - never to someone already offered or who already defaulted;
 *  3. nobody left → the lot ends unsold.
 * Only one offer exists at a time (database partial unique index), and while it is open the lot
 * is `awaiting_payment` for that one user only, so nobody else can buy it.
 */
export const expirePayment = (deps: Deps, lotId: string): Promise<Outcome<ExpireResult>> =>
  withTx(deps.pool, async (tx): Promise<Outcome<ExpireResult>> => {
    const now = deps.clock.now();
    const lot = await lockLot(tx, lotId);
    if (lot.status !== 'awaiting_payment' || !lot.buyer_id || lot.final_price === null) {
      return { result: { status: 'noop', reason: 'not_awaiting' }, effects: NO_EFFECTS };
    }
    if (!lot.payment_due_at || lot.payment_due_at.getTime() > now.getTime()) {
      return { result: { status: 'noop', reason: 'not_due_yet' }, effects: NO_EFFECTS };
    }

    const defaulter = lot.buyer_id;
    const notifications: Notification[] = [];

    // 1. forfeit the deposit to the seller
    const dep = (
      await tx.query<{ id: string; amount: number }>(
        `SELECT id, amount FROM deposits WHERE lot_id = $1 AND user_id = $2 AND status = 'held' FOR UPDATE`,
        [lot.id, defaulter],
      )
    ).rows[0];
    const forfeited = dep?.amount ?? 0;
    if (dep) {
      const dw = await ensureWallet(tx, defaulter);
      const sw = await ensureWallet(tx, lot.seller_id);
      await lockBalances(tx, [dw.held, sw.available]);
      await book(tx, {
        kind: 'forfeit',
        ref: `forfeit:${lot.id}:${defaulter}`,
        lotId: lot.id,
        userId: defaulter,
        at: now,
        entries: [
          { account: dw.held, amount: -dep.amount },
          { account: sw.available, amount: dep.amount },
        ],
      });
      await tx.query(`UPDATE deposits SET status = 'forfeited', resolved_at = $2 WHERE id = $1`, [
        dep.id,
        now,
      ]);
    }
    await tx.query(
      `UPDATE second_chance_offers SET status = 'expired', resolved_at = $3
        WHERE lot_id = $1 AND user_id = $2 AND status = 'pending'`,
      [lot.id, defaulter, now],
    );
    await tx.query(
      `INSERT INTO payment_defaults (lot_id, user_id, amount, forfeited, created_at) VALUES ($1, $2, $3, $4, $5)`,
      [lot.id, defaulter, lot.final_price, forfeited, now],
    );
    notifications.push(
      await notify(
        tx,
        {
          userId: defaulter,
          kind: 'payment_missed',
          payload: { lotId: lot.id, title: lot.title, forfeited },
        },
        now,
      ),
    );
    if (forfeited > 0) {
      notifications.push(
        await notify(
          tx,
          {
            userId: lot.seller_id,
            kind: 'deposit_received',
            payload: { lotId: lot.id, title: lot.title, amount: forfeited },
          },
          now,
        ),
      );
    }

    // 2. next participant by their maximum
    const next = (
      await tx.query<{ user_id: string; max_amount: number }>(
        `SELECT user_id, MAX(amount) AS max_amount
           FROM bids
          WHERE lot_id = $1 AND annulled_at IS NULL AND user_id <> $2
            AND user_id NOT IN (SELECT user_id FROM payment_defaults WHERE lot_id = $1)
            AND user_id NOT IN (SELECT user_id FROM second_chance_offers WHERE lot_id = $1)
          GROUP BY user_id
         HAVING $3::bigint IS NULL OR MAX(amount) >= $3::bigint
          ORDER BY MAX(amount) DESC, MIN(id) ASC
          LIMIT 1`,
        [lot.id, lot.seller_id, lot.reserve_price],
      )
    ).rows[0];

    if (next) {
      const expires = new Date(now.getTime() + deps.timings.offerWindowMs);
      await tx.query(
        `INSERT INTO second_chance_offers (lot_id, user_id, amount, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [lot.id, next.user_id, next.max_amount, expires, now],
      );
      await tx.query(
        `UPDATE lots SET buyer_id = $2, final_price = $3, payment_due_at = $4,
                event_seq = event_seq + 1, version = version + 1, updated_at = $5 WHERE id = $1`,
        [lot.id, next.user_id, next.max_amount, expires, now],
      );
      const event = await appendEvent(
        tx,
        lot,
        1,
        'status',
        { status: 'awaiting_payment', offer: true },
        now,
      );
      await audit(tx, lot.id, null, 'second_chance_offered', now, {
        userId: next.user_id,
        price: next.max_amount,
      });
      notifications.push(
        await notify(
          tx,
          {
            userId: next.user_id,
            kind: 'second_chance',
            payload: {
              lotId: lot.id,
              title: lot.title,
              price: next.max_amount,
              expiresAt: expires.toISOString(),
            },
          },
          now,
        ),
      );
      await queueEmail(
        tx,
        {
          userId: next.user_id,
          kind: 'second_chance',
          dedupeKey: `offer:${lot.id}:${next.user_id}`,
          payload: {
            lotId: lot.id,
            title: lot.title,
            price: next.max_amount,
            expiresAt: expires.toISOString(),
          },
        },
        now,
      );
      await queueLotSync(tx, lot.id, now);
      return {
        result: {
          status: 'offered',
          userId: next.user_id,
          price: next.max_amount,
          expiresAt: expires.toISOString(),
        },
        effects: { events: [event], notifications },
      };
    }

    // 3. nobody left
    await tx.query(
      `UPDATE lots SET status = 'ended_unsold', buyer_id = NULL, final_price = NULL, payment_due_at = NULL,
              event_seq = event_seq + 1, version = version + 1, updated_at = $2 WHERE id = $1`,
      [lot.id, now],
    );
    const event = await appendEvent(tx, lot, 1, 'closed', { status: 'ended_unsold' }, now);
    await audit(tx, lot.id, null, 'unsold_after_non_payment', now);
    notifications.push(
      await notify(
        tx,
        { userId: lot.seller_id, kind: 'lot_unsold', payload: { lotId: lot.id, title: lot.title } },
        now,
      ),
    );
    await queueLotSync(tx, lot.id, now);
    return { result: { status: 'unsold' }, effects: { events: [event], notifications } };
  });

// -------------------------------------------------------------------------------------------
// Shipping, confirmation and payout
// -------------------------------------------------------------------------------------------

export const shipLot = (
  deps: Deps,
  input: { lotId: string; sellerId: string; trackingNumber: string },
) =>
  withTx(deps.pool, async (tx): Promise<Outcome<{ shippedAt: string }>> => {
    const now = deps.clock.now();
    const lot = await lockLot(tx, input.lotId);
    if (lot.seller_id !== input.sellerId) throw appError('NOT_FOUND', 'lot not found');
    if (lot.status !== 'paid')
      throw appError('LOT_STATUS_CONFLICT', 'only a paid lot can be shipped');
    await tx.query(
      `UPDATE lots SET status = 'shipped', shipped_at = $2, tracking_number = $3,
              event_seq = event_seq + 1, version = version + 1, updated_at = $2 WHERE id = $1`,
      [lot.id, now, input.trackingNumber],
    );
    const event = await appendEvent(tx, lot, 1, 'status', { status: 'shipped' }, now);
    await audit(tx, lot.id, input.sellerId, 'shipped', now, {
      trackingNumber: input.trackingNumber,
    });
    const notifications = lot.buyer_id
      ? [
          await notify(
            tx,
            {
              userId: lot.buyer_id,
              kind: 'lot_shipped',
              payload: { lotId: lot.id, title: lot.title, trackingNumber: input.trackingNumber },
            },
            now,
          ),
        ]
      : [];
    if (lot.buyer_id) {
      await queueEmail(
        tx,
        {
          userId: lot.buyer_id,
          kind: 'lot_shipped',
          dedupeKey: `shipped:${lot.id}`,
          payload: { lotId: lot.id, title: lot.title, trackingNumber: input.trackingNumber },
        },
        now,
      );
    }
    await queueLotSync(tx, lot.id, now);
    return {
      result: { shippedAt: now.toISOString() },
      effects: { events: [event], notifications },
    };
  });

export type PayoutResult = { readonly commission: number; readonly sellerReceives: number };

/** Releases escrow: price minus commission to the seller, commission to the platform. Once. */
const payout = async (
  deps: Deps,
  tx: Tx,
  lot: Awaited<ReturnType<typeof lockLot>>,
  actorId: string | null,
  how: 'confirmed' | 'auto_confirmed',
): Promise<Outcome<PayoutResult>> => {
  const now = deps.clock.now();
  if (lot.final_price === null) throw appError('INTERNAL', 'shipped lot without a price');
  const price = lot.final_price;
  const commission = commissionFor(price);
  const escrow = await ensureEscrow(tx, lot.id);
  const sw = await ensureWallet(tx, lot.seller_id);
  const sys = await ensureSystemAccounts(tx);
  await lockBalances(tx, [escrow, sw.available, sys.commission]);
  await book(tx, {
    kind: 'payout',
    ref: `payout:${lot.id}`,
    lotId: lot.id,
    userId: lot.seller_id,
    at: now,
    entries: [
      { account: escrow, amount: -price },
      { account: sw.available, amount: price - commission },
      { account: sys.commission, amount: commission },
    ],
  });
  await tx.query(
    `UPDATE lots SET status = 'completed', completed_at = $2, commission = $3,
            event_seq = event_seq + 1, version = version + 1, updated_at = $2 WHERE id = $1`,
    [lot.id, now, commission],
  );
  const event = await appendEvent(tx, lot, 1, 'status', { status: 'completed' }, now);
  await audit(tx, lot.id, actorId, how, now, { price, commission });
  const notifications = [
    await notify(
      tx,
      {
        userId: lot.seller_id,
        kind: 'payout',
        payload: { lotId: lot.id, title: lot.title, amount: price - commission },
      },
      now,
    ),
  ];
  await queueEmail(
    tx,
    {
      userId: lot.seller_id,
      kind: 'payout',
      dedupeKey: `payout:${lot.id}`,
      payload: { lotId: lot.id, title: lot.title, amount: price - commission },
    },
    now,
  );
  await queueLotSync(tx, lot.id, now);
  return {
    result: { commission, sellerReceives: price - commission },
    effects: { events: [event], notifications },
  };
};

export const confirmReceipt = (deps: Deps, input: { lotId: string; buyerId: string }) =>
  withTx(deps.pool, async (tx) => {
    const lot = await lockLot(tx, input.lotId);
    if (lot.buyer_id !== input.buyerId) throw appError('NOT_FOUND', 'lot not found');
    if (lot.status !== 'shipped')
      throw appError('LOT_STATUS_CONFLICT', 'the lot is not waiting for confirmation');
    return payout(deps, tx, lot, input.buyerId, 'confirmed');
  });

export type AutoConfirmResult =
  { readonly status: 'completed'; readonly payout: PayoutResult } | { readonly status: 'noop' };

/** 7 days after shipping the receipt confirms itself. Clock-driven and idempotent. */
export const autoConfirmLot = (deps: Deps, lotId: string): Promise<Outcome<AutoConfirmResult>> =>
  withTx(deps.pool, async (tx): Promise<Outcome<AutoConfirmResult>> => {
    const now = deps.clock.now();
    const lot = await lockLot(tx, lotId);
    if (lot.status !== 'shipped' || !lot.shipped_at)
      return { result: { status: 'noop' }, effects: NO_EFFECTS };
    if (lot.shipped_at.getTime() + deps.timings.autoConfirmMs > now.getTime()) {
      return { result: { status: 'noop' }, effects: NO_EFFECTS };
    }
    const done = await payout(deps, tx, lot, null, 'auto_confirmed');
    return { result: { status: 'completed', payout: done.result }, effects: done.effects };
  });

// Re-exported for the moderation module (removing a lot releases deposits the same way).
export { releaseHeldDeposits, depositFor };
