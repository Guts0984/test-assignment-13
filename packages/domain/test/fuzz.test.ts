import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fund, makeLot, makeUser, makeUsers } from '@auction/test-kit';
import { isAppError, minNextBid, type BidKind } from '@auction/shared';
import {
  buyNow,
  confirmReceipt,
  expirePayment,
  payForLot,
  placeBid,
  reconcile,
  removeLot,
  runSweep,
  shipLot,
} from '../src/index.js';
import { DAY, newWorld, UAH, type World } from './world.js';

/**
 * Model-based fuzz: hundreds of random operations, run in concurrent batches, by random users,
 * against random lots, with the clock jumping around. After EVERY batch the ledger must
 * reconcile and the structural invariants must hold; at the end every lot is driven to a final
 * state. The test fails on any error that is not a documented business error (a deadlock, a
 * constraint violation or an internal error means a real bug).
 */

const mulberry = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

let w: World;
beforeAll(async () => {
  w = await newWorld(30);
});
afterAll(async () => {
  await w.close();
});

type LotInfo = {
  id: string;
  status: string;
  seller_id: string;
  current_price: number;
  bid_count: number;
  buyer_id: string | null;
  final_price: number | null;
  ends_at: Date | null;
  buy_now_price: number | null;
};

const run = async (seed: number, steps: number, batch: number) => {
  const rnd = mulberry(seed);
  const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const f = await newWorld(30);
  const { deps } = f;
  try {
    const sellers = await makeUsers(f.t.pool, 4);
    const buyers = await makeUsers(f.t.pool, 10);
    const mod = await makeUser(f.t.pool, 'moderator');
    for (const b of buyers) await fund(f.t.pool, b, UAH(int(200, 20_000)));
    const startLot = async () => {
      const seller = pick(sellers);
      const start = pick([50, 100, 200, 1000, 5000]);
      return makeLot(f.t.pool, {
        sellerId: seller,
        startPrice: UAH(start),
        reservePrice: rnd() < 0.3 ? UAH(start + pick([100, 1500, 8000])) : null,
        buyNowPrice: rnd() < 0.3 ? UAH(pick([12000, 20000])) : null,
        now: f.clock.now(),
        endsAt: new Date(f.clock.now().getTime() + int(1, 90) * 60_000),
      });
    };
    const lotIds: string[] = [];
    for (let i = 0; i < 8; i++) lotIds.push(await startLot());
    const usedKeys: {
      userId: string;
      lotId: string;
      kind: BidKind;
      amount: number;
      key: string;
    }[] = [];
    const unexpected: string[] = [];

    const lots = async (): Promise<LotInfo[]> =>
      (
        await f.t.pool.query<LotInfo>(
          `SELECT id, status, seller_id, current_price, bid_count, buyer_id, final_price, ends_at, buy_now_price FROM lots`,
        )
      ).rows;

    const op = async (): Promise<void> => {
      const all = await lots();
      const lot = pick(all);
      const roll = rnd();
      if (roll < 0.45) {
        const user = pick(buyers);
        const min = minNextBid({
          bidCount: lot.bid_count,
          currentPrice: lot.current_price,
          startPrice: lot.current_price,
        });
        const amount = Math.max(1, min + int(-2, 40) * 500);
        const kind: BidKind = rnd() < 0.5 ? 'auto' : 'manual';
        const key = randomUUID();
        usedKeys.push({ userId: user, lotId: lot.id, kind, amount, key });
        await placeBid(deps, { lotId: lot.id, userId: user, kind, amount, idempotencyKey: key });
      } else if (roll < 0.52) {
        await buyNow(deps, { lotId: lot.id, userId: pick(buyers), idempotencyKey: randomUUID() });
      } else if (roll < 0.6 && usedKeys.length > 0) {
        const again = pick(usedKeys); // a client retry, possibly long after
        await placeBid(deps, {
          lotId: again.lotId,
          userId: again.userId,
          kind: again.kind,
          amount: again.amount,
          idempotencyKey: again.key,
        });
      } else if (roll < 0.68) {
        const payable = all.filter((l) => l.status === 'awaiting_payment' && l.buyer_id);
        if (payable.length > 0) {
          const l = pick(payable);
          await payForLot(deps, {
            lotId: l.id,
            userId: rnd() < 0.85 ? (l.buyer_id as string) : pick(buyers),
            idempotencyKey: randomUUID(),
          });
        }
      } else if (roll < 0.74) {
        const l = all.filter((x) => x.status === 'paid');
        if (l.length > 0)
          await shipLot(deps, {
            lotId: pick(l).id,
            sellerId: pick(l).seller_id,
            trackingNumber: 'NP 12345',
          });
      } else if (roll < 0.78) {
        const l = all.filter((x) => x.status === 'shipped');
        if (l.length > 0) {
          const t = pick(l);
          await confirmReceipt(deps, {
            lotId: t.id,
            buyerId: t.buyer_id ?? pick(buyers),
          });
        }
      } else if (roll < 0.8) {
        const l = all.filter((x) => x.status === 'active');
        if (l.length > 0)
          await removeLot(deps, { lotId: pick(l).id, moderatorId: mod, reason: 'fuzz removal' });
      } else if (roll < 0.9) {
        f.clock.advance(rnd() < 0.8 ? int(1, 20) * 60_000 : int(1, 3) * DAY);
      } else if (roll < 0.95) {
        await runSweep(deps);
      } else if (roll < 0.97) {
        await fund(f.t.pool, pick(buyers), UAH(int(50, 3000)));
      } else if (roll < 0.99) {
        const l = all.filter((x) => x.status === 'awaiting_payment');
        if (l.length > 0) await expirePayment(deps, pick(l).id);
      } else if (all.filter((x) => x.status === 'active').length < 6) {
        lotIds.push(await startLot());
      }
    };

    const safely = async (): Promise<void> => {
      try {
        await op();
      } catch (e) {
        // Business errors are fine. Anything else (deadlock, constraint, internal) is a bug.
        if (isAppError(e)) return;
        const code = (e as { code?: string }).code ?? '';
        unexpected.push(`${code} ${(e as Error).message}`);
      }
    };

    const invariants = async (when: string) => {
      const r = await reconcile(f.t.pool);
      expect(r, `${when}: ${JSON.stringify(r)}`).toMatchObject({ ok: true });
      const { rows } = await f.t.pool.query<{ problem: string }>(`
        SELECT 'two held deposits' AS problem FROM deposits WHERE status = 'held' GROUP BY lot_id, user_id HAVING count(*) > 1
        UNION ALL SELECT 'held deposit on a finished lot' FROM deposits d JOIN lots l ON l.id = d.lot_id
          WHERE d.status = 'held' AND l.status NOT IN ('active', 'awaiting_payment')
        UNION ALL SELECT 'live lot whose held deposit is not its leader''s' FROM deposits d JOIN lots l ON l.id = d.lot_id
          WHERE d.status = 'held' AND l.status = 'active' AND d.user_id IS DISTINCT FROM l.leader_id
        UNION ALL SELECT 'bid count mismatch' FROM lots l WHERE l.bid_count <> (SELECT count(*) FROM bids b WHERE b.lot_id = l.id)
        UNION ALL SELECT 'price is not the last bid' FROM lots l
          WHERE l.bid_count > 0 AND l.current_price <> (SELECT amount FROM bids b WHERE b.lot_id = l.id ORDER BY id DESC LIMIT 1)
        UNION ALL SELECT 'two pending offers' FROM second_chance_offers WHERE status = 'pending' GROUP BY lot_id HAVING count(*) > 1
        UNION ALL SELECT 'pending offer on a lot that is not awaiting payment' FROM second_chance_offers o JOIN lots l ON l.id = o.lot_id
          WHERE o.status = 'pending' AND l.status <> 'awaiting_payment'
        UNION ALL SELECT 'duplicate email dedupe' FROM email_log GROUP BY dedupe_key HAVING count(*) > 1
        UNION ALL SELECT 'event numbering gap' FROM lots l WHERE l.event_seq <> COALESCE((SELECT max(seq) FROM lot_events e WHERE e.lot_id = l.id), 0)
        UNION ALL SELECT 'negative available' FROM accounts WHERE kind = 'user_available' AND balance < 0`);
      expect(
        rows.map((x) => x.problem),
        when,
      ).toEqual([]);
    };

    for (let done = 0; done < steps; done += batch) {
      await Promise.all(Array.from({ length: batch }, () => safely()));
      await invariants(`after ${done + batch} operations`);
    }

    // Drive everything to a final state with no new activity.
    for (let i = 0; i < 12; i++) {
      f.clock.advance(4 * DAY);
      await runSweep(deps);
    }
    await invariants('at the end');
    const finalLots = await lots();
    const open = finalLots.filter((l) => ['active', 'awaiting_payment'].includes(l.status));
    expect(open, 'every lot reached a final or waiting-for-human state').toEqual([]);
    expect(unexpected, 'unexpected (non-business) errors').toEqual([]);
    return finalLots;
  } finally {
    await f.close();
  }
};

describe('model-based fuzz (concurrent random operations)', () => {
  it.each([1, 2, 3])('seed %d: 600 operations in batches of 6', async (seed) => {
    const lots = await run(seed, 600, 6);
    // Sanity: the run actually did something interesting.
    expect(lots.some((l) => l.bid_count > 0)).toBe(true);
  });

  it('seed 99: heavier contention, batches of 20', async () => {
    await run(99, 400, 20);
  });
});
