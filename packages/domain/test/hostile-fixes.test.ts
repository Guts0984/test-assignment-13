import { describe, expect, it } from 'vitest';
import { balanceOf, count, fund, lotRow, makeLot, makeUser, makeUsers } from '@auction/test-kit';
import {
  appendDescription,
  approveLot,
  claimNextLot,
  closeLot,
  expirePayment,
  reconcile,
  updateLot,
  type FetchManyProvider,
} from '../src/index.js';
import { accepted, bid, HOUR, newWorld, UAH } from './world.js';

describe('N1: the second chance never sells below the hidden reserve', () => {
  const chain = async (reserve: number | null, maxes: [number, number, number]) => {
    const w = await newWorld();
    const seller = await makeUser(w.t.pool);
    const [a, b, c] = await makeUsers(w.t.pool, 3);
    for (const u of [a!, b!, c!]) await fund(w.t.pool, u, UAH(10_000));
    const lot = await makeLot(w.t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      reservePrice: reserve,
      now: w.clock.now(),
      endsAt: new Date(w.clock.now().getTime() + 10 * 60_000),
    });
    // ascending so each placement is accepted; C lowest, A highest
    accepted(await bid(w.deps, lot, c!, maxes[2], 'auto'));
    accepted(await bid(w.deps, lot, b!, maxes[1], 'auto'));
    accepted(await bid(w.deps, lot, a!, maxes[0], 'auto'));
    w.clock.advance(11 * 60_000);
    expect((await closeLot(w.deps, lot)).result.status).toBe('sold');
    return { w, seller, a: a!, b: b!, c: c!, lot };
  };

  it('A(3000) defaults, B(2000) lapses, C(1220) is below reserve 1499.60 → never offered, unsold, money reconciles', async () => {
    const { w, a, b, c, lot } = await chain(149_960, [UAH(3000), UAH(2000), UAH(1220)]);
    try {
      w.clock.advance(48 * HOUR);
      expect((await expirePayment(w.deps, lot)).result).toMatchObject({
        status: 'offered',
        userId: b,
        price: UAH(2000),
      });
      w.clock.advance(24 * HOUR);
      expect((await expirePayment(w.deps, lot)).result).toEqual({ status: 'unsold' });
      expect(await lotRow(w.t.pool, lot)).toMatchObject({
        status: 'ended_unsold',
        buyer_id: null,
        final_price: null,
      });
      expect(
        await count(
          w.t.pool,
          `SELECT count(*) AS n FROM second_chance_offers WHERE lot_id = $1 AND user_id = $2`,
          [lot, c],
        ),
      ).toBe(0);
      // idempotent afterwards, nothing resurrects the offer
      expect((await expirePayment(w.deps, lot)).result).toMatchObject({ status: 'noop' });
      expect(await balanceOf(w.t.pool, c, 'held')).toBe(0);
      expect(await balanceOf(w.t.pool, a, 'held')).toBe(0);
      const r = await reconcile(w.t.pool);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    } finally {
      await w.close();
    }
  });

  it('when even the 2nd participant is below the reserve the lot goes unsold right after the default', async () => {
    const { w, lot } = await chain(UAH(2500), [UAH(3000), UAH(2000), UAH(1220)]);
    try {
      w.clock.advance(48 * HOUR);
      expect((await expirePayment(w.deps, lot)).result).toEqual({ status: 'unsold' });
      expect((await reconcile(w.t.pool)).ok).toBe(true);
    } finally {
      await w.close();
    }
  });

  it('a participant whose max equals the reserve exactly is still offered; no reserve = old behaviour', async () => {
    const eq = await chain(UAH(1220), [UAH(3000), UAH(2000), UAH(1220)]);
    try {
      eq.w.clock.advance(48 * HOUR);
      await expirePayment(eq.w.deps, eq.lot);
      eq.w.clock.advance(24 * HOUR);
      expect((await expirePayment(eq.w.deps, eq.lot)).result).toMatchObject({
        status: 'offered',
        userId: eq.c,
        price: UAH(1220),
      });
    } finally {
      await eq.w.close();
    }
    const none = await chain(null, [UAH(3000), UAH(2000), UAH(1220)]);
    try {
      none.w.clock.advance(48 * HOUR);
      await expirePayment(none.w.deps, none.lot);
      none.w.clock.advance(24 * HOUR);
      expect((await expirePayment(none.w.deps, none.lot)).result).toMatchObject({
        status: 'offered',
        userId: none.c,
      });
    } finally {
      await none.w.close();
    }
  });
});

describe('N2: editing a published lot sends it back to moderation', () => {
  const patch = (over: Record<string, unknown> = {}) => ({
    title: 'Rewritten title',
    description: 'Totally different',
    categoryId: 1,
    cityId: 1,
    condition: 'good',
    startPrice: UAH(1),
    reservePrice: null,
    buyNowPrice: null,
    durationDays: 7,
    ...over,
  });

  it('active, zero bids → in_review, out of the public query, event + outbox + audit, re-claim, approve restarts the clock', async () => {
    const w = await newWorld();
    try {
      const seller = await makeUser(w.t.pool);
      const mod = await makeUser(w.t.pool, 'moderator');
      const lot = await makeLot(w.t.pool, { sellerId: seller, now: w.clock.now() });
      const seqBefore = Number((await lotRow<{ event_seq: string }>(w.t.pool, lot)).event_seq);

      w.clock.advance(HOUR);
      const out = await updateLot(w.deps, { lotId: lot, sellerId: seller, patch: patch() });
      expect(out.result).toEqual({ status: 'in_review' });
      expect(out.effects.events).toHaveLength(1);
      expect(out.effects.events[0]).toMatchObject({
        lotId: lot,
        type: 'closed',
        payload: { status: 'in_review' },
      });
      expect(JSON.stringify(out.effects.events[0]?.payload)).not.toContain('Rewritten');

      const row = await lotRow(w.t.pool, lot);
      expect(row).toMatchObject({
        status: 'in_review',
        title: 'Rewritten title',
        starts_at: null,
        ends_at: null,
        claimed_by: null,
      });
      expect(Number(row.event_seq)).toBe(seqBefore + 1);
      expect(
        await count(w.t.pool, `SELECT count(*) AS n FROM lots WHERE id = $1 AND status = 'active'`, [
          lot,
        ]),
      ).toBe(0);
      expect(
        await count(
          w.t.pool,
          `SELECT count(*) AS n FROM lot_events WHERE lot_id = $1 AND type = 'closed' AND payload->>'status' = 'in_review'`,
          [lot],
        ),
      ).toBe(1);
      expect(
        await count(
          w.t.pool,
          `SELECT count(*) AS n FROM outbox WHERE topic = 'lot.upsert' AND aggregate_id = $1`,
          [lot],
        ),
      ).toBe(1);
      expect(
        await count(
          w.t.pool,
          `SELECT count(*) AS n FROM lot_audit WHERE lot_id = $1 AND action = 'edited'`,
          [lot],
        ),
      ).toBe(1);

      // a stale second edit still works (it is in review now, which is not editable): hostile
      await expect(
        updateLot(w.deps, { lotId: lot, sellerId: seller, patch: patch({ title: 'again' }) }),
      ).rejects.toMatchObject({ code: 'LOT_NOT_EDITABLE' });

      // the moderator can claim it, and approval restarts the clock from the approval time
      w.clock.advance(HOUR);
      expect((await claimNextLot(w.deps, mod))?.lotId).toBe(lot);
      const approved = await approveLot(w.deps, { lotId: lot, moderatorId: mod });
      const after = await lotRow<{ status: string; starts_at: Date; ends_at: Date }>(w.t.pool, lot);
      expect(after.status).toBe('active');
      expect(after.starts_at.getTime()).toBe(w.clock.now().getTime());
      expect(after.ends_at.toISOString()).toBe(approved.endsAt);
      expect(after.ends_at.getTime()).toBe(w.clock.now().getTime() + 7 * 86_400_000);
    } finally {
      await w.close();
    }
  });

  it('appendDescription on a live lot stays allowed without review; nothing else changes', async () => {
    const w = await newWorld();
    try {
      const seller = await makeUser(w.t.pool);
      const lot = await makeLot(w.t.pool, { sellerId: seller, now: w.clock.now() });
      const r = await appendDescription(w.deps, { lotId: lot, sellerId: seller, text: 'more info' });
      expect(r.effects.events).toHaveLength(1);
      expect(await lotRow(w.t.pool, lot)).toMatchObject({ status: 'active' });
    } finally {
      await w.close();
    }
  });

  it('a lot with bids can neither be edited nor sent back to review, even by raw SQL', async () => {
    const w = await newWorld();
    try {
      const seller = await makeUser(w.t.pool);
      const buyer = await makeUser(w.t.pool);
      await fund(w.t.pool, buyer, UAH(1000));
      const lot = await makeLot(w.t.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        now: w.clock.now(),
      });
      accepted(await bid(w.deps, lot, buyer, UAH(100)));
      await expect(
        updateLot(w.deps, { lotId: lot, sellerId: seller, patch: patch() }),
      ).rejects.toMatchObject({ code: 'LOT_NOT_EDITABLE' });
      await expect(
        w.t.pool.query(
          `UPDATE lots SET status = 'in_review', starts_at = NULL, ends_at = NULL WHERE id = $1`,
          [lot],
        ),
      ).rejects.toThrow(/cannot go back to review/);
      expect(await lotRow(w.t.pool, lot)).toMatchObject({ status: 'active' });
    } finally {
      await w.close();
    }
  });
});

describe('N3: bulk provider reconciliation', () => {
  it('5000 top-ups reconcile in under 1 s with the bulk fetcher and give the same answer as the sequential path', async () => {
    const w = await newWorld();
    try {
      const user = await makeUser(w.t.pool);
      await w.t.pool.query(
        `INSERT INTO topups (user_id, amount, status, provider_payment_id, settled_at)
         SELECT $1, 10000 + g, 'succeeded', gen_random_uuid(), now() FROM generate_series(1, 5000) g`,
        [user],
      );
      const rows = (
        await w.t.pool.query<{ id: string; provider_payment_id: string; amount: string }>(
          `SELECT id, provider_payment_id, amount FROM topups ORDER BY id`,
        )
      ).rows;
      // the provider agrees except: every 100th failed, every 250th has another amount,
      // every 700th is unknown to it
      const truth = new Map<string, { status: 'succeeded' | 'failed'; amount: number } | null>();
      rows.forEach((r, i) => {
        const amount = Number(r.amount);
        truth.set(
          r.provider_payment_id,
          i % 700 === 0
            ? null
            : i % 100 === 0
              ? { status: 'failed', amount }
              : i % 250 === 0
                ? { status: 'succeeded', amount: amount + 1 }
                : { status: 'succeeded', amount },
        );
      });
      const single = (id: string) => {
        const f = truth.get(id);
        return Promise.resolve(f ?? { status: 'not_found' as const });
      };
      let calls = 0;
      let biggest = 0;
      const many: FetchManyProvider = (ids) => {
        calls++;
        biggest = Math.max(biggest, ids.length);
        const m = new Map<string, { status: 'succeeded' | 'failed'; amount: number }>();
        for (const id of ids) {
          const f = truth.get(id);
          if (f) m.set(id, f);
        }
        return Promise.resolve(m);
      };

      const t0 = performance.now();
      const bulk = await reconcile(w.t.pool, undefined, { fetchManyProvider: many });
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(1000);
      expect(calls).toBe(10);
      expect(biggest).toBe(500);

      const seq = await reconcile(w.t.pool, single);
      const key = (m: { topupId: string }) => m.topupId;
      expect([...bulk.providerMismatches].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
        [...seq.providerMismatches].sort((x, y) => key(x).localeCompare(key(y))),
      );
      expect(bulk.providerMismatches.length).toBeGreaterThan(40);
      expect(bulk.providerMismatches.some((m) => m.provider === 'amount_differs')).toBe(true);
      expect(bulk.providerMismatches.some((m) => m.provider === 'not_found')).toBe(true);
      expect(bulk.ok).toBe(false);
    } finally {
      await w.close();
    }
  });
});
