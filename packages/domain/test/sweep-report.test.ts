import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, count, fund, lotRow, makeLot, makeUser, makeUsers } from '@auction/test-kit';
import { commissionFor } from '@auction/shared';
import {
  closeLot,
  confirmReceipt,
  expirePayment,
  financeReport,
  findDueWork,
  payForLot,
  reconcile,
  runSweep,
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

describe('the sweeper replaces every timer (invariant 13: nothing depends on Redis)', () => {
  it('with no jobs at all, one sweep closes due lots, expires payments, auto-confirms, frees claims', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const [a, b] = await makeUsers(f.t.pool, 2);
      await fund(f.t.pool, a!, UAH(5000));
      await fund(f.t.pool, b!, UAH(5000));
      const now = f.clock.now().getTime();
      const mk = (mins: number) =>
        makeLot(f.t.pool, {
          sellerId: seller,
          startPrice: UAH(100),
          now: f.clock.now(),
          endsAt: new Date(now + mins * 60_000),
        });

      const toSell = await mk(10);
      const toExpire = await mk(10);
      const toConfirm = await mk(10);
      const later = await mk(60 * 24);
      for (const lot of [toSell, toExpire, toConfirm])
        accepted(await bid(f.deps, lot, a!, UAH(500)));
      accepted(await bid(f.deps, later, b!, UAH(200)));

      // Walk time forward step by step, running ONLY the sweeper, as a worker with an empty Redis would.
      f.clock.advance(11 * 60_000);
      const due = await findDueWork(f.deps);
      for (const lot of [toSell, toExpire, toConfirm]) expect(due.toClose).toContain(lot);
      const first = await runSweep(f.deps);
      expect(first.closed).toBe(3);
      expect(await lotRow(f.t.pool, later)).toMatchObject({ status: 'active' });

      // toConfirm gets paid and shipped; toSell is paid; toExpire is ignored.
      await payForLot(f.deps, { lotId: toConfirm, userId: a!, idempotencyKey: randomUUID() });
      await shipLot(f.deps, { lotId: toConfirm, sellerId: seller, trackingNumber: 'NP 1' });
      f.clock.advance(48 * HOUR);
      const second = await runSweep(f.deps);
      expect(second.closed).toBe(1); // `later` ended during the jump
      expect(second.paymentsExpired).toBe(2); // toSell and toExpire were never paid
      f.clock.advance(HOUR); // `later` is now past its own 48 h deadline too
      f.clock.advance(7 * DAY);
      const third = await runSweep(f.deps);
      expect(third.autoConfirmed).toBe(1);
      expect(await lotRow(f.t.pool, toConfirm)).toMatchObject({ status: 'completed' });
      // Payout of the confirmed sale, plus the 50 ₴ deposit forfeited by each of the three winners
      // who never paid (toSell, toExpire, and `later`, which closed during the 48 h jump).
      expect(await balanceOf(f.t.pool, seller, 'available')).toBe(
        UAH(500) - commissionFor(UAH(500)) + 3 * UAH(50),
      );
      expect((await reconcile(f.t.pool)).ok).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('sweeping again changes nothing: no second email, no second ledger transaction', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const a = await makeUser(f.t.pool);
      await fund(f.t.pool, a, UAH(5000));
      const lot = await makeLot(f.t.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        now: f.clock.now(),
        endsAt: new Date(f.clock.now().getTime() + 600_000),
      });
      await bid(f.deps, lot, a, UAH(500));
      f.clock.advance(11 * 60_000);
      await runSweep(f.deps);
      const snapshot = async () => ({
        emails: await count(f.t.pool, 'SELECT count(*) AS n FROM email_log'),
        ledger: await count(f.t.pool, 'SELECT count(*) AS n FROM ledger_transactions'),
        events: await count(f.t.pool, 'SELECT count(*) AS n FROM lot_events'),
        notifications: await count(f.t.pool, 'SELECT count(*) AS n FROM notifications'),
      });
      const before = await snapshot();
      for (let i = 0; i < 5; i++) await runSweep(f.deps);
      expect(await snapshot()).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('five workers sweeping at the same moment do each unit of work once', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const buyers = await makeUsers(f.t.pool, 12);
      for (const u of buyers) await fund(f.t.pool, u, UAH(5000));
      const lots: string[] = [];
      for (let i = 0; i < 12; i++) {
        const lot = await makeLot(f.t.pool, {
          sellerId: seller,
          startPrice: UAH(100),
          now: f.clock.now(),
          endsAt: new Date(f.clock.now().getTime() + 600_000),
        });
        lots.push(lot);
        await bid(f.deps, lot, buyers[i]!, UAH(300 + i));
      }
      f.clock.advance(11 * 60_000);
      const reports = await Promise.all(Array.from({ length: 5 }, () => runSweep(f.deps)));
      expect(reports.reduce((a, r) => a + r.closed, 0)).toBe(12); // each lot closed by exactly one worker
      expect(await count(f.t.pool, `SELECT count(*) AS n FROM email_log WHERE kind = 'won'`)).toBe(
        12,
      );
      expect(
        await count(f.t.pool, `SELECT count(*) AS n FROM lot_events WHERE type = 'closed'`),
      ).toBe(12);
      expect((await reconcile(f.t.pool)).ok).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('a close that raced with a late bid is decided by the clock under the lot lock, not by who was first', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const a = await makeUser(f.t.pool);
      await fund(f.t.pool, a, UAH(5000));
      const ends = f.clock.now().getTime() + 600_000;
      const lot = await makeLot(f.t.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        now: f.clock.now(),
        endsAt: new Date(ends),
      });
      f.clock.set(ends + 1);
      const [b, c] = await Promise.all([bid(f.deps, lot, a, UAH(100)), closeLot(f.deps, lot)]);
      expect(b).toMatchObject({ ok: false, reason: 'LOT_ENDED' });
      expect(c.result).toEqual({ status: 'unsold', reason: 'no_bids' });
    } finally {
      await f.close();
    }
  });
});

describe('finance report', () => {
  it('turnover, commission and per-category breakdown over the period match what was sold', async () => {
    const f = await newWorld();
    try {
      await f.t.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'c1','к','c','k'), (2,'c2','к2','c2','k2') ON CONFLICT DO NOTHING`,
      );
      const seller = await makeUser(f.t.pool);
      const buyer = await makeUser(f.t.pool);
      await fund(f.t.pool, buyer, UAH(100_000));
      const sell = async (price: number, category: number) => {
        const lot = await makeLot(f.t.pool, {
          sellerId: seller,
          startPrice: UAH(100),
          now: f.clock.now(),
          endsAt: new Date(f.clock.now().getTime() + 600_000),
        });
        await f.t.pool.query('UPDATE lots SET category_id = $2 WHERE id = $1', [lot, category]);
        accepted(await bid(f.deps, lot, buyer, price));
        f.clock.advance(11 * 60_000);
        await closeLot(f.deps, lot);
        await payForLot(f.deps, { lotId: lot, userId: buyer, idempotencyKey: randomUUID() });
        return lot;
      };
      const day = f.clock.now().toISOString().slice(0, 10);
      await sell(UAH(1000), 1);
      await sell(UAH(333.33), 1);
      await sell(UAH(100), 2);
      f.clock.advance(3 * DAY);
      await sell(UAH(5000), 2); // outside the first day

      const first = await financeReport(f.t.pool, day, day);
      const expectedCommission =
        commissionFor(UAH(1000)) + commissionFor(UAH(333.33)) + commissionFor(UAH(100));
      expect(first).toMatchObject({
        turnover: UAH(1000) + UAH(333.33) + UAH(100),
        commission: expectedCommission,
        paidLots: 3,
      });
      expect(first.byCategory).toEqual([
        {
          categoryId: 1,
          lots: 2,
          turnover: UAH(1333.33),
          commission: commissionFor(UAH(1000)) + commissionFor(UAH(333.33)),
        },
        { categoryId: 2, lots: 1, turnover: UAH(100), commission: commissionFor(UAH(100)) },
      ]);
      const wide = await financeReport(
        f.t.pool,
        day,
        new Date(f.clock.now().getTime()).toISOString().slice(0, 10),
      );
      expect(wide.turnover).toBe(first.turnover + UAH(5000));
      const empty = await financeReport(f.t.pool, '2020-01-01', '2020-01-31');
      expect(empty).toMatchObject({
        turnover: 0,
        commission: 0,
        paidLots: 0,
        unpaidShare: 0,
        byCategory: [],
      });
    } finally {
      await f.close();
    }
  });

  it('commission in the report equals what payout actually booked', async () => {
    const f = await newWorld();
    try {
      await f.t.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'c1','к','c','k') ON CONFLICT DO NOTHING`,
      );
      const seller = await makeUser(f.t.pool);
      const buyer = await makeUser(f.t.pool);
      await fund(f.t.pool, buyer, UAH(100_000));
      for (const p of [UAH(10), UAH(99.99), UAH(333.33), UAH(1234.56), UAH(7777.77)]) {
        const lot = await makeLot(f.t.pool, {
          sellerId: seller,
          startPrice: UAH(5),
          now: f.clock.now(),
          endsAt: new Date(f.clock.now().getTime() + 600_000),
        });
        await bid(f.deps, lot, buyer, p);
        f.clock.advance(11 * 60_000);
        await closeLot(f.deps, lot);
        await payForLot(f.deps, { lotId: lot, userId: buyer, idempotencyKey: randomUUID() });
        await shipLot(f.deps, { lotId: lot, sellerId: seller, trackingNumber: 'NP 1' });
        await confirmReceipt(f.deps, { lotId: lot, buyerId: buyer });
      }
      const day = f.clock.now().toISOString().slice(0, 10);
      const report = await financeReport(f.t.pool, day, day);
      const booked = (
        await f.t.pool.query<{ s: number }>(
          `SELECT balance AS s FROM accounts WHERE kind = 'platform_commission'`,
        )
      ).rows[0]?.s;
      expect(report.commission).toBe(booked);
    } finally {
      await f.close();
    }
  });

  it('the unpaid-win share counts defaults against everything offered, second chances included', async () => {
    const f = await newWorld();
    try {
      await f.t.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'c1','к','c','k') ON CONFLICT DO NOTHING`,
      );
      const seller = await makeUser(f.t.pool);
      const [a, b] = await makeUsers(f.t.pool, 2);
      await fund(f.t.pool, a!, UAH(10_000));
      await fund(f.t.pool, b!, UAH(10_000));
      const mkLot = async () => {
        const lot = await makeLot(f.t.pool, {
          sellerId: seller,
          startPrice: UAH(100),
          now: f.clock.now(),
          endsAt: new Date(f.clock.now().getTime() + 600_000),
        });
        await bid(f.deps, lot, b!, UAH(500), 'auto');
        await bid(f.deps, lot, a!, UAH(900), 'auto');
        f.clock.advance(11 * 60_000);
        await closeLot(f.deps, lot);
        return lot;
      };
      const paidLot = await mkLot();
      await payForLot(f.deps, { lotId: paidLot, userId: a!, idempotencyKey: randomUUID() });
      const lostLot = await mkLot();
      f.clock.advance(48 * HOUR);
      await expirePayment(f.deps, lostLot); // a defaults, b is offered
      await payForLot(f.deps, { lotId: lostLot, userId: b!, idempotencyKey: randomUUID() });
      const day = f.clock.now().toISOString().slice(0, 10);
      const wide = await financeReport(f.t.pool, '2026-06-01', day);
      // offered: 2 first winners + 1 second-chance offer = 3; unpaid: 1
      expect(wide).toMatchObject({ winsOffered: 3, unpaidWins: 1 });
      expect(wide.unpaidShare).toBeCloseTo(1 / 3, 10);
    } finally {
      await f.close();
    }
  });
});
