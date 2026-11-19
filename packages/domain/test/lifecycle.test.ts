import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, count, fund, lotRow, makeLot, makeUser, makeUsers } from '@auction/test-kit';
import { commissionFor } from '@auction/shared';
import {
  autoConfirmLot,
  buyNow,
  closeLot,
  confirmReceipt,
  expirePayment,
  payForLot,
  reconcile,
  removeLot,
  shipLot,
} from '../src/index.js';
import { accepted, bid, DAY, HOUR, newWorld, UAH, type World } from './world.js';

let w: World;
beforeAll(async () => {
  w = await newWorld();
});
afterAll(async () => {
  await w.close();
});

const ledgerOk = async () => {
  const r = await reconcile(w.t.pool);
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
};
const pay = (lot: string, user: string) =>
  payForLot(w.deps, { lotId: lot, userId: user, idempotencyKey: randomUUID() }).then(
    (r) => r.result,
  );
const status = async (lot: string) => (await lotRow<{ status: string }>(w.t.pool, lot)).status;

/** A closed lot with a winner at the given price (via real bids), time moved past the end. */
const soldLot = async (opts: { price?: number; fundBuyer?: number } = {}) => {
  const seller = await makeUser(w.t.pool);
  const buyer = await makeUser(w.t.pool);
  await fund(w.t.pool, buyer, opts.fundBuyer ?? UAH(5000));
  const lot = await makeLot(w.t.pool, {
    sellerId: seller,
    startPrice: UAH(100),
    now: w.clock.now(),
    endsAt: new Date(w.clock.now().getTime() + 10 * 60_000),
  });
  accepted(await bid(w.deps, lot, buyer, opts.price ?? UAH(1000)));
  w.clock.advance(11 * 60_000);
  const closed = await closeLot(w.deps, lot);
  expect(closed.result.status).toBe('sold');
  return { seller, buyer, lot, price: opts.price ?? UAH(1000) };
};

describe('closing', () => {
  it('no bids → ended_unsold, no money moves', async () => {
    const seller = await makeUser(w.t.pool);
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      now: w.clock.now(),
      endsAt: new Date(w.clock.now().getTime() + 1000),
    });
    w.clock.advance(2000);
    expect((await closeLot(w.deps, lot)).result).toEqual({ status: 'unsold', reason: 'no_bids' });
    expect(await status(lot)).toBe('ended_unsold');
  });

  it('reserve not met → ended_unsold and the leader’s deposit comes back', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(2000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      reservePrice: UAH(5000),
      now: w.clock.now(),
      endsAt: new Date(w.clock.now().getTime() + 10 * 60_000),
    });
    accepted(await bid(w.deps, lot, buyer, UAH(1000), 'auto'));
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(100));
    w.clock.advance(11 * 60_000);
    expect((await closeLot(w.deps, lot)).result).toEqual({
      status: 'unsold',
      reason: 'reserve_not_met',
    });
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(0);
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(2000));
    await ledgerOk();
  });

  it('with a winner: awaiting_payment, 48 h to pay, deposit stays held, winner and seller notified once', async () => {
    const { buyer, lot, seller } = await soldLot();
    const row = await lotRow<{
      status: string;
      buyer_id: string;
      final_price: number;
      payment_due_at: Date;
    }>(w.t.pool, lot);
    expect(row).toMatchObject({
      status: 'awaiting_payment',
      buyer_id: buyer,
      final_price: UAH(1000),
    });
    expect(row.payment_due_at.getTime()).toBe(w.clock.now().getTime() + 48 * HOUR);
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(100));
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM notifications WHERE kind IN ('won','lot_sold') AND payload->>'lotId' = $1`,
        [lot],
      ),
    ).toBe(2);
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM email_log WHERE user_id IN ($1, $2) AND payload->>'lotId' = $3`,
        [buyer, seller, lot],
      ),
    ).toBe(2);
  });

  it('closing a lot twice, or a removed one, is a harmless no-op', async () => {
    const { lot } = await soldLot();
    expect((await closeLot(w.deps, lot)).result).toEqual({ status: 'noop', reason: 'not_active' });
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM lot_events WHERE lot_id = $1 AND type = 'closed'`,
        [lot],
      ),
    ).toBe(1);
  });
});

describe('payment, shipping, confirmation, payout', () => {
  it('pay → ship → confirm: escrow, then seller gets price minus 5%, platform gets the commission', async () => {
    const { buyer, seller, lot, price } = await soldLot({ price: UAH(1000) });
    expect(await pay(lot, buyer)).toMatchObject({ ok: true, price });
    // The 100 ₴ deposit was counted toward the price: buyer is down exactly the price.
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(0);
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(5000) - price);
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(0); // escrow, not yet the seller's
    await shipLot(w.deps, { lotId: lot, sellerId: seller, trackingNumber: 'NP 123456' });
    expect(await status(lot)).toBe('shipped');
    const done = await confirmReceipt(w.deps, { lotId: lot, buyerId: buyer });
    expect(done.result).toEqual({ commission: UAH(50), sellerReceives: UAH(950) });
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(UAH(950));
    expect(await status(lot)).toBe('completed');
    await ledgerOk();
  });

  it('commission is 5%, minimum 10 ₴, rounded down (in the seller’s favour)', async () => {
    for (const price of [UAH(100), UAH(333.33), UAH(1000)]) {
      const { buyer, seller, lot } = await soldLot({ price });
      await pay(lot, buyer);
      await shipLot(w.deps, { lotId: lot, sellerId: seller, trackingNumber: 'NP 111' });
      await confirmReceipt(w.deps, { lotId: lot, buyerId: buyer });
      expect(await balanceOf(w.t.pool, seller, 'available')).toBe(price - commissionFor(price));
    }
    await ledgerOk();
  });

  it('a deposit larger than the price (autobid max far above the price) is refunded in the same payment', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(10_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(w.clock.now().getTime() + 10 * 60_000),
    });
    accepted(await bid(w.deps, lot, buyer, UAH(8000), 'auto')); // price 100, deposit 800
    w.clock.advance(11 * 60_000);
    await closeLot(w.deps, lot);
    expect(await pay(lot, buyer)).toMatchObject({ ok: true, price: UAH(100) });
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(10_000) - UAH(100));
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(0);
    await ledgerOk();
  });

  it('only the winner can pay; others and early/late attempts get a clear answer and nothing moves', async () => {
    const { buyer, lot } = await soldLot();
    const stranger = await makeUser(w.t.pool);
    await fund(w.t.pool, stranger, UAH(5000));
    expect(await pay(lot, stranger)).toMatchObject({ ok: false, reason: 'PAYMENT_NOT_DUE' });
    expect(await balanceOf(w.t.pool, stranger, 'available')).toBe(UAH(5000));
    w.clock.advance(48 * HOUR + 1000);
    expect(await pay(lot, buyer)).toMatchObject({ ok: false, reason: 'PAYMENT_WINDOW_CLOSED' });
  });

  it('not enough money: refused, deposit untouched, can retry after topping up', async () => {
    const { buyer, lot } = await soldLot({ price: UAH(1000), fundBuyer: UAH(150) }); // 100 deposit held, 50 free
    expect(await pay(lot, buyer)).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(100));
    await fund(w.t.pool, buyer, UAH(900));
    expect(await pay(lot, buyer)).toMatchObject({ ok: true });
    await ledgerOk();
  });

  it('10 simultaneous payments (distinct keys): exactly one succeeds, money leaves once', async () => {
    const { buyer, lot, price } = await soldLot();
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(lot, buyer)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(9);
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(5000) - price);
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM ledger_transactions WHERE ref = $1`, [
        `pay:${lot}`,
      ]),
    ).toBe(1);
    await ledgerOk();
  });

  it('the same payment key retried returns the same answer and charges once', async () => {
    const { buyer, lot, price } = await soldLot();
    const key = randomUUID();
    const a = await payForLot(w.deps, { lotId: lot, userId: buyer, idempotencyKey: key });
    const b = await payForLot(w.deps, { lotId: lot, userId: buyer, idempotencyKey: key });
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(a.result);
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(5000) - price);
    await expect(
      payForLot(w.deps, { lotId: randomUUID(), userId: buyer, idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('shipping and confirming have the right actors and the right status; a double confirm pays once', async () => {
    const { buyer, seller, lot } = await soldLot();
    await expect(
      shipLot(w.deps, { lotId: lot, sellerId: seller, trackingNumber: 'NP 1' }),
    ).rejects.toMatchObject({ code: 'LOT_STATUS_CONFLICT' }); // not paid
    await pay(lot, buyer);
    await expect(
      shipLot(w.deps, { lotId: lot, sellerId: buyer, trackingNumber: 'NP 1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' }); // not the seller
    await shipLot(w.deps, { lotId: lot, sellerId: seller, trackingNumber: 'NP 1' });
    await expect(confirmReceipt(w.deps, { lotId: lot, buyerId: seller })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => confirmReceipt(w.deps, { lotId: lot, buyerId: buyer })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM ledger_transactions WHERE ref = $1`, [
        `payout:${lot}`,
      ]),
    ).toBe(1);
    await ledgerOk();
  });

  it('auto-confirms 7 days after shipping, not a minute earlier; once, even from many workers', async () => {
    const { buyer, seller, lot } = await soldLot();
    await pay(lot, buyer);
    await shipLot(w.deps, { lotId: lot, sellerId: seller, trackingNumber: 'NP 2' });
    w.clock.advance(7 * DAY - 60_000);
    expect((await autoConfirmLot(w.deps, lot)).result).toEqual({ status: 'noop' });
    w.clock.advance(60_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => autoConfirmLot(w.deps, lot)),
    );
    expect(results.filter((r) => r.result.status === 'completed')).toHaveLength(1);
    expect(await status(lot)).toBe('completed');
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM email_log WHERE dedupe_key = $1`, [
        `payout:${lot}`,
      ]),
    ).toBe(1);
    await ledgerOk();
  });
});

describe('non-payment and the second chance (invariant 8, acceptance 10)', () => {
  /** Three bidders with distinct maxes: A 3000 (wins at 2050), B 2000, C 1000. */
  const threeBidders = async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b, c] = await makeUsers(w.t.pool, 3);
    for (const u of [a!, b!, c!]) await fund(w.t.pool, u, UAH(10_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(w.clock.now().getTime() + 10 * 60_000),
    });
    await bid(w.deps, lot, c!, UAH(1000), 'auto');
    await bid(w.deps, lot, b!, UAH(2000), 'auto');
    await bid(w.deps, lot, a!, UAH(3000), 'auto');
    w.clock.advance(11 * 60_000);
    await closeLot(w.deps, lot);
    return { seller, a: a!, b: b!, c: c!, lot };
  };

  it('winner does not pay for 48 h → deposit to the seller, offer to the 2nd participant for 24 h, then the 3rd, then unsold', async () => {
    const { seller, a, b, c, lot } = await threeBidders();
    const depositA = await balanceOf(w.t.pool, a, 'held');
    expect(depositA).toBe(UAH(300));
    expect((await expirePayment(w.deps, lot)).result).toEqual({
      status: 'noop',
      reason: 'not_due_yet',
    });

    w.clock.advance(48 * HOUR);
    const first = await expirePayment(w.deps, lot);
    expect(first.result).toMatchObject({ status: 'offered', userId: b, price: UAH(2000) });
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(depositA); // the deposit moved to the seller
    expect(await balanceOf(w.t.pool, a, 'held')).toBe(0);
    expect(await lotRow(w.t.pool, lot)).toMatchObject({
      status: 'awaiting_payment',
      buyer_id: b,
      final_price: UAH(2000),
    });
    expect(first.effects.notifications.map((n) => [n.userId, n.kind]).sort()).toEqual(
      [
        [a, 'payment_missed'],
        [seller, 'deposit_received'],
        [b, 'second_chance'],
      ].sort(),
    );

    // 24 hours later B has not paid either.
    expect((await expirePayment(w.deps, lot)).result).toEqual({
      status: 'noop',
      reason: 'not_due_yet',
    });
    w.clock.advance(24 * HOUR);
    const second = await expirePayment(w.deps, lot);
    expect(second.result).toMatchObject({ status: 'offered', userId: c, price: UAH(1000) });
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(depositA); // B had no deposit to lose

    w.clock.advance(24 * HOUR);
    expect((await expirePayment(w.deps, lot)).result).toEqual({ status: 'unsold' });
    expect(await status(lot)).toBe('ended_unsold');
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM payment_defaults WHERE lot_id = $1`, [lot]),
    ).toBe(3);
    await ledgerOk();
  });

  it('while an offer is open, nobody else can buy the lot and only one offer exists', async () => {
    const { a, b, c, lot } = await threeBidders();
    w.clock.advance(48 * HOUR);
    await expirePayment(w.deps, lot);
    for (const outsider of [a, c])
      expect(await pay(lot, outsider)).toMatchObject({ ok: false, reason: 'PAYMENT_NOT_DUE' });
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM second_chance_offers WHERE lot_id = $1 AND status = 'pending'`,
        [lot],
      ),
    ).toBe(1);
    // B accepts by paying the full amount from the wallet.
    expect(await pay(lot, b)).toMatchObject({ ok: true, price: UAH(2000) });
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM second_chance_offers WHERE lot_id = $1 AND status = 'accepted'`,
        [lot],
      ),
    ).toBe(1);
    expect(await status(lot)).toBe('paid');
    await ledgerOk();
  });

  it('a second chance can still be paid up to the last moment, and not after it', async () => {
    const { b, lot } = await threeBidders();
    w.clock.advance(48 * HOUR);
    await expirePayment(w.deps, lot);
    w.clock.advance(24 * HOUR + 1000);
    expect(await pay(lot, b)).toMatchObject({ ok: false, reason: 'PAYMENT_WINDOW_CLOSED' });
  });

  it('20 workers expiring the same payment at once: one forfeit, one offer, one email', async () => {
    const { seller, a, b, lot } = await threeBidders();
    w.clock.advance(48 * HOUR);
    const results = await Promise.all(Array.from({ length: 20 }, () => expirePayment(w.deps, lot)));
    expect(results.filter((r) => r.result.status === 'offered')).toHaveLength(1);
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM ledger_transactions WHERE ref = $1`, [
        `forfeit:${lot}:${a}`,
      ]),
    ).toBe(1);
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM email_log WHERE dedupe_key = $1`, [
        `offer:${lot}:${b}`,
      ]),
    ).toBe(1);
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(UAH(300));
    await ledgerOk();
  });

  it('a lot nobody else bid on goes straight to unsold after the winner defaults', async () => {
    const { buyer, seller, lot } = await soldLot();
    w.clock.advance(48 * HOUR);
    expect((await expirePayment(w.deps, lot)).result).toEqual({ status: 'unsold' });
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(UAH(100));
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(0);
    await ledgerOk();
  });

  it('buy-now that is never paid forfeits its deposit and ends unsold', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(2000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      buyNowPrice: UAH(1000),
      now: w.clock.now(),
    });
    expect(
      (await buyNow(w.deps, { lotId: lot, userId: buyer, idempotencyKey: randomUUID() })).result,
    ).toMatchObject({ ok: true, price: UAH(1000) });
    w.clock.advance(48 * HOUR);
    expect((await expirePayment(w.deps, lot)).result).toEqual({ status: 'unsold' });
    expect(await balanceOf(w.t.pool, seller, 'available')).toBe(UAH(100));
    await ledgerOk();
  });

  it('buy-now that is paid completes like any sale', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(2000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      buyNowPrice: UAH(1000),
      now: w.clock.now(),
    });
    await buyNow(w.deps, { lotId: lot, userId: buyer, idempotencyKey: randomUUID() });
    expect(await pay(lot, buyer)).toMatchObject({ ok: true, price: UAH(1000) });
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(1000));
    await ledgerOk();
  });
});

describe('removing a lot (moderator)', () => {
  it('annuls the bids, releases every deposit, emails every participant and the seller', async () => {
    const seller = await makeUser(w.t.pool);
    const mod = await makeUser(w.t.pool, 'moderator');
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(2000));
    await fund(w.t.pool, b!, UAH(2000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    await bid(w.deps, lot, a!, UAH(500));
    await bid(w.deps, lot, b!, UAH(800));
    expect(await balanceOf(w.t.pool, b!, 'held')).toBe(UAH(80));

    const r = await removeLot(w.deps, { lotId: lot, moderatorId: mod, reason: 'prohibited item' });
    expect(r.result.released).toBe(1);
    expect(await status(lot)).toBe('removed');
    expect(await balanceOf(w.t.pool, b!, 'held')).toBe(0);
    expect(await balanceOf(w.t.pool, b!, 'available')).toBe(UAH(2000));
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM bids WHERE lot_id = $1 AND annulled_at IS NOT NULL`,
        [lot],
      ),
    ).toBe(2);
    const mails = (
      await w.t.pool.query<{ user_id: string }>(
        `SELECT user_id FROM email_log WHERE kind = 'lot_removed' AND payload->>'lotId' = $1`,
        [lot],
      )
    ).rows
      .map((x) => x.user_id)
      .sort();
    expect(mails).toEqual([a!, b!, seller].sort());
    expect(await bid(w.deps, lot, a!, UAH(900))).toMatchObject({
      ok: false,
      reason: 'LOT_NOT_ACTIVE',
    });
    await ledgerOk();
  });

  it('only a moderator, only a live lot, and twice is a conflict, not a second refund', async () => {
    const seller = await makeUser(w.t.pool);
    const mod = await makeUser(w.t.pool, 'moderator');
    const lot = await makeLot(w.t.pool, { sellerId: seller, now: w.clock.now() });
    await expect(
      removeLot(w.deps, { lotId: lot, moderatorId: seller, reason: 'because' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      removeLot(w.deps, { lotId: lot, moderatorId: mod, reason: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await removeLot(w.deps, { lotId: lot, moderatorId: mod, reason: 'because' });
    await expect(
      removeLot(w.deps, { lotId: lot, moderatorId: mod, reason: 'because' }),
    ).rejects.toMatchObject({ code: 'LOT_STATUS_CONFLICT' });
    const sold = await soldLot();
    await expect(
      removeLot(w.deps, { lotId: sold.lot, moderatorId: mod, reason: 'because' }),
    ).rejects.toMatchObject({ code: 'LOT_STATUS_CONFLICT' });
  });
});
