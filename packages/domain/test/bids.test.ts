import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, count, fund, lotRow, makeLot, makeUser, makeUsers } from '@auction/test-kit';
import { depositFor } from '@auction/shared';
import { buyNow, closeLot, placeBid, reconcile } from '../src/index.js';
import { accepted, bid, newWorld, UAH, type World } from './world.js';

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

describe('a single bid, with the money', () => {
  it('first bid locks the deposit (10%, min 50 ₴) and becomes the price', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(200),
      now: w.clock.now(),
    });

    const r = accepted(await bid(w.deps, lot, buyer, UAH(300)));
    expect(r).toMatchObject({
      outcome: 'leading',
      currentPrice: UAH(300),
      bidCount: 1,
      yourMax: UAH(300),
    });
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(50)); // 10% = 30 → minimum 50
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(UAH(950));
    await ledgerOk();
  });

  it('raising your own max only locks the difference and is silent in the public history', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(5000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    await bid(w.deps, lot, buyer, UAH(1000), 'auto'); // deposit 100
    const r = accepted(await bid(w.deps, lot, buyer, UAH(3000), 'auto')); // deposit 300 → +200
    expect(r.currentPrice).toBe(UAH(100));
    expect(r.bidCount).toBe(1); // no new public row
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(300));
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM deposits WHERE lot_id = $1 AND status = 'held'`,
        [lot],
      ),
    ).toBe(1);
    await ledgerOk();
  });

  it('the displaced leader gets the deposit back IN THE SAME transaction as the bid that outbid them', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(1000));
    await fund(w.t.pool, b!, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    await bid(w.deps, lot, a!, UAH(200));
    expect(await balanceOf(w.t.pool, a!, 'held')).toBe(UAH(50));
    accepted(await bid(w.deps, lot, b!, UAH(500)));
    expect(await balanceOf(w.t.pool, a!, 'held')).toBe(0);
    expect(await balanceOf(w.t.pool, a!, 'available')).toBe(UAH(1000));
    expect(await balanceOf(w.t.pool, b!, 'held')).toBe(UAH(50));

    // Same database transaction: the release and the new hold share one xmin.
    const { rows } = await w.t.pool.query<{ xid: string; ref: string }>(
      `SELECT xmin::text AS xid, ref FROM ledger_transactions WHERE lot_id = $1 AND (ref LIKE 'release:%' OR (ref LIKE 'hold:%' AND user_id = $2))`,
      [lot, b],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.xid)).size).toBe(1);
    await ledgerOk();
  });

  it('outbid notification goes to the displaced user only; the email is throttled to once per 15 minutes per lot', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(5000));
    await fund(w.t.pool, b!, UAH(5000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const emails = () =>
      count(
        w.t.pool,
        `SELECT count(*) AS n FROM email_log WHERE kind = 'outbid' AND user_id = $1`,
        [a],
      );
    const notifs = () =>
      count(
        w.t.pool,
        `SELECT count(*) AS n FROM notifications WHERE kind = 'outbid' AND user_id = $1`,
        [a],
      );

    await bid(w.deps, lot, a!, UAH(100));
    const first = await placeBidFull(lot, b!, UAH(110));
    expect(first.effects.notifications.map((n) => [n.userId, n.kind])).toEqual([[a, 'outbid']]);
    expect(await emails()).toBe(1);

    w.clock.advance(5 * 60_000); // 5 min later: a takes the lead back, b outbids again
    await bid(w.deps, lot, a!, UAH(120));
    await bid(w.deps, lot, b!, UAH(130));
    expect(await notifs()).toBe(2); // in-app: every time, immediately
    expect(await emails()).toBe(1); // email: throttled

    w.clock.advance(11 * 60_000); // 16 min after the first email
    await bid(w.deps, lot, a!, UAH(140));
    await bid(w.deps, lot, b!, UAH(150));
    expect(await emails()).toBe(2);
  });

  const placeBidFull = (lot: string, user: string, amount: number) =>
    placeBid(w.deps, {
      lotId: lot,
      userId: user,
      kind: 'manual',
      amount,
      idempotencyKey: randomUUID(),
    });

  it('rejects with a clear reason and moves no money: own lot, too low, not enough funds, staff', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    const poor = await makeUser(w.t.pool);
    const mod = await makeUser(w.t.pool, 'moderator');
    await fund(w.t.pool, buyer, UAH(1000));
    await fund(w.t.pool, seller, UAH(1000));
    await fund(w.t.pool, poor, UAH(10));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });

    expect(await bid(w.deps, lot, seller, UAH(200))).toMatchObject({
      ok: false,
      reason: 'OWN_LOT',
    });
    expect(await bid(w.deps, lot, buyer, UAH(99))).toMatchObject({
      ok: false,
      reason: 'BID_TOO_LOW',
      minNextBid: UAH(100),
    });
    expect(await bid(w.deps, lot, poor, UAH(100))).toMatchObject({
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
    });
    await expect(bid(w.deps, lot, mod, UAH(100))).rejects.toMatchObject({
      code: 'STAFF_CANNOT_TRADE',
    });
    await expect(bid(w.deps, randomUUID(), buyer, UAH(100))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await balanceOf(w.t.pool, poor, 'held')).toBe(0);
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(0);
    expect((await lotRow<{ bid_count: number }>(w.t.pool, lot)).bid_count).toBe(0);
    await ledgerOk();
  });
});

describe('autobid: same result in every order (invariant 2)', () => {
  const scenario = async (order: ('a' | 'b' | 'c')[], maxes: Record<string, number>) => {
    const seller = await makeUser(w.t.pool);
    const users = {
      a: await makeUser(w.t.pool),
      b: await makeUser(w.t.pool),
      c: await makeUser(w.t.pool),
    };
    for (const u of Object.values(users)) await fund(w.t.pool, u, UAH(50_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    for (const k of order) await bid(w.deps, lot, users[k], maxes[k] as number, 'auto');
    const row = await lotRow<{ current_price: number; leader_id: string }>(w.t.pool, lot);
    const leader = (Object.entries(users).find(([, id]) => id === row.leader_id) ?? ['?'])[0];
    await ledgerOk();
    return { price: row.current_price, leader };
  };

  it('autobids 1 000 ₴ and 1 500 ₴ → 1 050 ₴ and the second leads, in both orders', async () => {
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      expect(await scenario([...order], { a: UAH(1000), b: UAH(1500) })).toEqual({
        price: UAH(1050),
        leader: 'b',
      });
    }
  });

  it('three bidders, all 6 arrival orders → identical final state', async () => {
    const perms = [
      ['a', 'b', 'c'],
      ['a', 'c', 'b'],
      ['b', 'a', 'c'],
      ['b', 'c', 'a'],
      ['c', 'a', 'b'],
      ['c', 'b', 'a'],
    ] as const;
    const results = [];
    for (const p of perms)
      results.push(await scenario([...p], { a: UAH(1000), b: UAH(2500), c: UAH(1800) }));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ price: UAH(1850), leader: 'b' });
  });

  it('equal maxes: the one who bid first leads, in either order', async () => {
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const r = await scenario([...order], { a: UAH(700), b: UAH(700) });
      expect(r.leader).toBe(order[0]);
      expect(r.price).toBe(UAH(700));
    }
  });
});

describe('50 simultaneous bids on one lot (invariant 1)', () => {
  it('price only grows, exactly one leader, every bid has a clear outcome, history and money consistent', async () => {
    const seller = await makeUser(w.t.pool);
    const users = await makeUsers(w.t.pool, 50);
    for (const u of users) await fund(w.t.pool, u, UAH(20_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });

    // A mix: some want the minimum, some jump ahead, half are autobids with big maxes.
    const results = await Promise.all(
      users.map((u, i) =>
        bid(
          w.deps,
          lot,
          u,
          UAH(100 + (i % 7) * 15 + Math.floor(i / 7) * 5),
          i % 2 ? 'auto' : 'manual',
        ).catch((e: unknown) => ({
          crashed: e,
        })),
      ),
    );
    expect(results.filter((r) => 'crashed' in r)).toEqual([]);
    for (const r of results) {
      if ('crashed' in r) continue;
      if (r.ok) expect(['leading', 'outbid_by_autobid']).toContain(r.outcome);
      else
        expect(['BID_TOO_LOW', 'INSUFFICIENT_FUNDS', 'BID_NOT_ABOVE_OWN_MAX']).toContain(r.reason);
    }

    const history = (
      await w.t.pool.query<{ id: number; amount: number; user_id: string }>(
        `SELECT id, amount, user_id FROM bids WHERE lot_id = $1 ORDER BY id`,
        [lot],
      )
    ).rows;
    const amounts = history.map((h) => h.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b)); // never down
    const row = await lotRow<{
      current_price: number;
      leader_id: string;
      bid_count: number;
      leader_max: number;
    }>(w.t.pool, lot);
    expect(row.bid_count).toBe(history.length);
    expect(row.current_price).toBe(amounts.at(-1));
    expect(history.at(-1)?.user_id).toBe(row.leader_id);
    // Exactly one deposit is held: the leader's, and it matches their max.
    const held = (
      await w.t.pool.query<{ user_id: string; amount: number }>(
        `SELECT user_id, amount FROM deposits WHERE lot_id = $1 AND status = 'held'`,
        [lot],
      )
    ).rows;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ user_id: row.leader_id, amount: depositFor(row.leader_max) });
    const accepted50 = results.filter((r) => !('crashed' in r) && r.ok).length;
    expect(accepted50).toBeGreaterThan(0);
    await ledgerOk();
  });
});

describe('time is the server’s (invariant 3)', () => {
  it('a bid one second after the end is refused even though nobody closed the lot', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(w.clock.now().getTime() + 60_000),
    });
    w.clock.advance(61_000);
    expect(await bid(w.deps, lot, buyer, UAH(100))).toMatchObject({
      ok: false,
      reason: 'LOT_ENDED',
    });
    expect((await lotRow<{ status: string }>(w.t.pool, lot)).status).toBe('active'); // worker has not run
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(0);
  });

  it('exactly at the end is already too late; one millisecond before is fine (and extends)', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const ends = w.clock.now().getTime() + 10 * 60_000;
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(ends),
    });
    w.clock.set(ends);
    expect(await bid(w.deps, lot, buyer, UAH(100))).toMatchObject({
      ok: false,
      reason: 'LOT_ENDED',
    });
    w.clock.set(ends - 1);
    const r = accepted(await bid(w.deps, lot, buyer, UAH(100)));
    expect(new Date(r.endsAt).getTime()).toBe(ends - 1 + 120_000);
    // The extended end is now the deadline, to the millisecond.
    w.clock.set(ends - 1 + 120_000);
    expect(await bid(w.deps, lot, buyer, UAH(500), 'auto')).toMatchObject({
      ok: false,
      reason: 'LOT_ENDED',
    });
  });

  it('a bid in the last 2 minutes moves the end to now + 2 minutes, and again, without limit', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(50_000));
    await fund(w.t.pool, b!, UAH(50_000));
    const start = w.clock.now().getTime();
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(start + 3 * 60_000),
    });
    w.clock.set(start + 2 * 60_000 + 30_000); // 30 s left
    const r1 = accepted(await bid(w.deps, lot, a!, UAH(100)));
    expect(r1.extended).toBe(true);
    expect(new Date(r1.endsAt).getTime()).toBe(w.clock.now().getTime() + 120_000);
    for (let i = 0; i < 20; i++) {
      w.clock.advance(100_000); // 20 s left each time
      const r = accepted(await bid(w.deps, lot, i % 2 ? a! : b!, UAH(100 + (i + 1) * 20)));
      expect(new Date(r.endsAt).getTime()).toBe(w.clock.now().getTime() + 120_000);
    }
    expect(await count(w.t.pool, `SELECT count(*) AS n FROM bids WHERE lot_id = $1`, [lot])).toBe(
      21,
    );
  });

  it('a close job queued for the old end time does nothing after the lot was extended', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const start = w.clock.now().getTime();
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(start + 60_000),
    });
    w.clock.set(start + 30_000);
    accepted(await bid(w.deps, lot, buyer, UAH(100))); // extends to start + 150 s
    w.clock.set(start + 61_000); // the OLD end has passed
    const r = await closeLot(w.deps, lot);
    expect(r.result).toEqual({ status: 'noop', reason: 'not_yet_over' });
    expect((await lotRow<{ status: string }>(w.t.pool, lot)).status).toBe('active');
  });

  it('20 workers closing one lot at once: closed exactly once, one winner email, one hold', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const start = w.clock.now().getTime();
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
      endsAt: new Date(start + 10 * 60_000),
    });
    accepted(await bid(w.deps, lot, buyer, UAH(400)));
    w.clock.set(start + 10 * 60_000 + 1000);
    const results = await Promise.all(Array.from({ length: 20 }, () => closeLot(w.deps, lot)));
    expect(results.filter((r) => r.result.status === 'sold')).toHaveLength(1);
    expect(results.filter((r) => r.result.status === 'noop')).toHaveLength(19);
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM email_log WHERE dedupe_key = $1`, [
        `won:${lot}:${buyer}`,
      ]),
    ).toBe(1);
    expect(
      await count(
        w.t.pool,
        `SELECT count(*) AS n FROM lot_events WHERE lot_id = $1 AND type = 'closed'`,
        [lot],
      ),
    ).toBe(1);
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(50)); // still held until payment
    await ledgerOk();
  });
});

describe('available balance is never negative (invariant 4)', () => {
  it('money for 3 deposits and 10 simultaneous bids on 10 different lots: exactly 3 go through', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(150)); // 3 × 50 ₴ minimum deposit
    const lots = await Promise.all(
      Array.from({ length: 10 }, () =>
        makeLot(w.t.pool, { sellerId: seller, startPrice: UAH(200), now: w.clock.now() }),
      ),
    );
    const results = await Promise.all(lots.map((l) => bid(w.deps, l, buyer, UAH(200))));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === 'INSUFFICIENT_FUNDS')).toHaveLength(7);
    expect(await balanceOf(w.t.pool, buyer, 'available')).toBe(0);
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(150));
    await ledgerOk();
  });

  it('a user bidding on many lots with random sizes never overdraws, and held always equals live deposits', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(900));
    const lots = await Promise.all(
      Array.from({ length: 30 }, () =>
        makeLot(w.t.pool, { sellerId: seller, startPrice: UAH(100), now: w.clock.now() }),
      ),
    );
    await Promise.all(lots.map((l, i) => bid(w.deps, l, buyer, UAH(100 + i * 40), 'auto')));
    const available = await balanceOf(w.t.pool, buyer, 'available');
    const held = await balanceOf(w.t.pool, buyer, 'held');
    expect(available).toBeGreaterThanOrEqual(0);
    expect(available + held).toBe(UAH(900));
    await ledgerOk();
  });

  it('two users outbidding each other on two lots in opposite order do not deadlock', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(100_000));
    await fund(w.t.pool, b!, UAH(100_000));
    const [l1, l2] = await Promise.all([
      makeLot(w.t.pool, { sellerId: seller, startPrice: UAH(100), now: w.clock.now() }),
      makeLot(w.t.pool, { sellerId: seller, startPrice: UAH(100), now: w.clock.now() }),
    ]);
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      jobs.push(bid(w.deps, i % 2 ? l1 : l2, i % 3 ? a! : b!, UAH(100 + i * 10)));
      jobs.push(bid(w.deps, i % 2 ? l2 : l1, i % 3 ? b! : a!, UAH(105 + i * 10)));
    }
    const settled = await Promise.allSettled(jobs);
    expect(settled.filter((s) => s.status === 'rejected')).toEqual([]);
    await ledgerOk();
  });
});

describe('"Buy now" and the first bid at the same time (invariant 5)', () => {
  it('exactly one of them wins, every time, and the money is taken once', async () => {
    const seller = await makeUser(w.t.pool);
    for (let round = 0; round < 25; round++) {
      const [bidder, buyer] = await makeUsers(w.t.pool, 2);
      await fund(w.t.pool, bidder!, UAH(2000));
      await fund(w.t.pool, buyer!, UAH(2000));
      const lot = await makeLot(w.t.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        buyNowPrice: UAH(500),
        now: w.clock.now(),
      });
      const [bidRes, buyRes] = await Promise.all([
        bid(w.deps, lot, bidder!, UAH(100)),
        buyNow(w.deps, { lotId: lot, userId: buyer!, idempotencyKey: randomUUID() }).then(
          (r) => r.result,
        ),
      ]);
      const row = await lotRow<{ status: string; bid_count: number; buyer_id: string | null }>(
        w.t.pool,
        lot,
      );
      expect(
        bidRes.ok !== buyRes.ok,
        `round ${round}: bid=${JSON.stringify(bidRes)} buy=${JSON.stringify(buyRes)}`,
      ).toBe(true);
      if (buyRes.ok) {
        expect(row).toMatchObject({ status: 'awaiting_payment', bid_count: 0, buyer_id: buyer });
        expect(await balanceOf(w.t.pool, bidder!, 'held')).toBe(0);
        expect(await balanceOf(w.t.pool, buyer!, 'held')).toBe(UAH(50));
        expect(bidRes).toMatchObject({ ok: false, reason: 'LOT_NOT_ACTIVE' });
      } else {
        expect(row).toMatchObject({ status: 'active', bid_count: 1 });
        expect(buyRes).toMatchObject({ ok: false });
        expect(await balanceOf(w.t.pool, buyer!, 'held')).toBe(0);
        expect(await balanceOf(w.t.pool, bidder!, 'held')).toBe(UAH(50));
      }
    }
    await ledgerOk();
  });

  it('buy now is refused once there is a bid, for the seller, and without funds', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b, poor] = await makeUsers(w.t.pool, 3);
    await fund(w.t.pool, a!, UAH(1000));
    await fund(w.t.pool, b!, UAH(1000));
    await fund(w.t.pool, seller, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      buyNowPrice: UAH(500),
      now: w.clock.now(),
    });
    const buy = (user: string) =>
      buyNow(w.deps, { lotId: lot, userId: user, idempotencyKey: randomUUID() }).then(
        (r) => r.result,
      );
    expect(await buy(seller)).toMatchObject({ ok: false, reason: 'OWN_LOT' });
    expect(await buy(poor!)).toMatchObject({ ok: false, reason: 'INSUFFICIENT_FUNDS' });
    accepted(await bid(w.deps, lot, a!, UAH(100)));
    expect(await buy(b!)).toMatchObject({ ok: false, reason: 'BUY_NOW_UNAVAILABLE' });
    const noPrice = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    expect(
      await buyNow(w.deps, { lotId: noPrice, userId: b!, idempotencyKey: randomUUID() }).then(
        (r) => r.result,
      ),
    ).toMatchObject({ ok: false, reason: 'BUY_NOW_UNAVAILABLE' });
    await ledgerOk();
  });
});

describe('idempotency (invariant 7)', () => {
  it('the same key and body returns the same result and bids once', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const input = {
      lotId: lot,
      userId: buyer,
      kind: 'manual' as const,
      amount: UAH(150),
      idempotencyKey: randomUUID(),
    };
    const first = await placeBid(w.deps, input);
    const again = await placeBid(w.deps, input);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(again.effects).toEqual({ events: [], notifications: [] }); // nothing is pushed twice
    expect(await count(w.t.pool, `SELECT count(*) AS n FROM bids WHERE lot_id = $1`, [lot])).toBe(
      1,
    );
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(50));
  });

  it('the same key with a different body is refused, and nothing changes', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const other = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const key = randomUUID();
    await placeBid(w.deps, {
      lotId: lot,
      userId: buyer,
      kind: 'manual',
      amount: UAH(150),
      idempotencyKey: key,
    });
    for (const changed of [
      { lotId: lot, kind: 'manual' as const, amount: UAH(160) },
      { lotId: lot, kind: 'auto' as const, amount: UAH(150) },
      { lotId: other, kind: 'manual' as const, amount: UAH(150) },
    ]) {
      await expect(
        placeBid(w.deps, { userId: buyer, idempotencyKey: key, ...changed }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM bids WHERE user_id = $1`, [buyer]),
    ).toBe(1);
  });

  it('30 parallel retries with one key execute once and all get the identical answer', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const input = {
      lotId: lot,
      userId: buyer,
      kind: 'manual' as const,
      amount: UAH(150),
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all(Array.from({ length: 30 }, () => placeBid(w.deps, input)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const first = results.find((r) => !r.replayed)?.result;
    for (const r of results) expect(r.result).toEqual(first); // deep equality (jsonb reorders keys)
    expect(await count(w.t.pool, `SELECT count(*) AS n FROM bids WHERE lot_id = $1`, [lot])).toBe(
      1,
    );
    expect(await balanceOf(w.t.pool, buyer, 'held')).toBe(UAH(50));
  });

  it('a rejection is a result too: retrying it returns the same rejection', async () => {
    const seller = await makeUser(w.t.pool);
    const buyer = await makeUser(w.t.pool);
    await fund(w.t.pool, buyer, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const input = {
      lotId: lot,
      userId: buyer,
      kind: 'manual' as const,
      amount: UAH(50),
      idempotencyKey: randomUUID(),
    };
    const a = await placeBid(w.deps, input);
    const b = await placeBid(w.deps, input);
    expect(a.result).toMatchObject({ ok: false, reason: 'BID_TOO_LOW' });
    expect(b).toMatchObject({ replayed: true, result: a.result });
  });

  it('keys are per user: another user may reuse the same key string', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(1000));
    await fund(w.t.pool, b!, UAH(1000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    const key = randomUUID();
    const r1 = await placeBid(w.deps, {
      lotId: lot,
      userId: a!,
      kind: 'manual',
      amount: UAH(100),
      idempotencyKey: key,
    });
    const r2 = await placeBid(w.deps, {
      lotId: lot,
      userId: b!,
      kind: 'manual',
      amount: UAH(110),
      idempotencyKey: key,
    });
    expect([r1.replayed, r2.replayed]).toEqual([false, false]);
  });
});

describe('public data never carries the reserve price (invariant 14)', () => {
  const RESERVE = UAH(7_777.77);

  it('while the reserve is not met, no event, result or notification contains it, only "not met"', async () => {
    const seller = await makeUser(w.t.pool);
    const [a, b] = await makeUsers(w.t.pool, 2);
    await fund(w.t.pool, a!, UAH(50_000));
    await fund(w.t.pool, b!, UAH(50_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      reservePrice: RESERVE,
      now: w.clock.now(),
    });
    const outputs: unknown[] = [];
    for (const [u, amt, kind] of [
      [a!, UAH(200), 'manual'],
      [b!, UAH(5000), 'auto'],
      [a!, UAH(300), 'manual'],
    ] as const) {
      const r = await placeBid(w.deps, {
        lotId: lot,
        userId: u,
        kind,
        amount: amt,
        idempotencyKey: randomUUID(),
      });
      outputs.push(r.result, r.effects);
    }
    outputs.push(
      (await w.t.pool.query(`SELECT payload FROM lot_events WHERE lot_id = $1`, [lot])).rows,
    );
    const text = JSON.stringify(outputs);
    expect(text).not.toContain(String(RESERVE));
    expect(text.toLowerCase()).not.toMatch(/reserve_?price/);
    const events = (
      await w.t.pool.query<{ payload: { reserveMet: boolean | null } }>(
        `SELECT payload FROM lot_events WHERE lot_id = $1`,
        [lot],
      )
    ).rows;
    expect(events.every((e) => e.payload.reserveMet === false)).toBe(true);
  });

  it('once it is met the lot says only "met"; there is never a reserve field, whoever asks', async () => {
    const seller = await makeUser(w.t.pool);
    const a = await makeUser(w.t.pool);
    await fund(w.t.pool, a, UAH(50_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      reservePrice: RESERVE,
      now: w.clock.now(),
    });
    const r = await placeBid(w.deps, {
      lotId: lot,
      userId: a,
      kind: 'auto',
      amount: UAH(9000),
      idempotencyKey: randomUUID(),
    });
    expect(r.result).toMatchObject({ ok: true, reserveMet: true });
    const dump = JSON.stringify([
      r.result,
      r.effects,
      (await w.t.pool.query(`SELECT payload FROM lot_events WHERE lot_id = $1`, [lot])).rows,
    ]);
    // The visible price now equals the reserve (documented decision), but nothing is *labelled* as it.
    expect(dump.toLowerCase()).not.toMatch(/reserve_?price|"reserve"/);
  });
});

describe('history records who bid what, with autobids marked', () => {
  it('bids carry the is_auto flag and masked names appear in the event, not real ones', async () => {
    const seller = await makeUser(w.t.pool);
    const a = await makeUser(w.t.pool, 'user', 'olena_7');
    const b = await makeUser(w.t.pool, 'user', 'Богдан');
    await fund(w.t.pool, a, UAH(5000));
    await fund(w.t.pool, b, UAH(5000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: w.clock.now(),
    });
    await bid(w.deps, lot, a, UAH(1000), 'auto');
    await bid(w.deps, lot, b, UAH(200), 'manual');
    const rows = (
      await w.t.pool.query<{ is_auto: boolean; user_id: string; amount: number }>(
        `SELECT is_auto, user_id, amount FROM bids WHERE lot_id = $1 ORDER BY id`,
        [lot],
      )
    ).rows;
    expect(rows.map((r) => [r.user_id === a ? 'a' : 'b', r.amount, r.is_auto])).toEqual([
      ['a', UAH(100), true],
      ['b', UAH(200), false],
      ['a', UAH(210), true],
    ]);
    const payloads = JSON.stringify(
      (await w.t.pool.query(`SELECT payload FROM lot_events WHERE lot_id = $1`, [lot])).rows,
    );
    expect(payloads).toContain('o***7');
    expect(payloads).toContain('б***н');
    expect(payloads).not.toContain('olena');
    expect(payloads).not.toContain('Богдан');
  });
});
