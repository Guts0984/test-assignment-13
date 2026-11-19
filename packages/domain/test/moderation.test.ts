import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, lotRow, makeLot, makeUser, makeUsers } from '@auction/test-kit';
import {
  appendDescription,
  approveLot,
  claimNextLot,
  createLot,
  rejectLot,
  sweepExpiredClaims,
  submitLot,
  updateLot,
} from '../src/index.js';
import { HOUR, newWorld, UAH, type World } from './world.js';

let w: World;
beforeAll(async () => {
  w = await newWorld();
});
afterAll(async () => {
  await w.close();
});

const queued = async (n: number) => {
  const seller = await makeUser(w.t.pool);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      await makeLot(w.t.pool, {
        sellerId: seller,
        status: 'in_review',
        now: new Date(w.clock.now().getTime() + i * 1000),
      }),
    );
  }
  return { seller, ids };
};

describe('two moderators never get one lot (invariant 9, acceptance 11)', () => {
  it('one lot in the queue, 20 moderators at once: exactly one gets it, the rest get nothing', async () => {
    const { ids } = await queued(1);
    const mods = await makeUsers(w.t.pool, 20, 'moderator');
    const results = await Promise.all(mods.map((m) => claimNextLot(w.deps, m)));
    const got = results.filter((r) => r !== null);
    expect(got).toHaveLength(1);
    expect(got[0]?.lotId).toBe(ids[0]);
  });

  it('N lots and N moderators at once: everybody gets their own, none shared', async () => {
    // A fresh world: the queue must contain exactly these 15 lots.
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const lots = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          makeLot(f.t.pool, {
            sellerId: seller,
            status: 'in_review',
            now: new Date(f.clock.now().getTime() + i),
          }),
        ),
      );
      const mods = await makeUsers(f.t.pool, 15, 'moderator');
      const results = await Promise.all(mods.map((m) => claimNextLot(f.deps, m)));
      const ids = results.map((r) => r?.lotId);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(15);
      expect([...new Set(ids)].sort()).toEqual([...lots].sort());
    } finally {
      await f.close();
    }
  });

  it('oldest first; a moderator asking again gets the same lot back, not a second one', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const old = await makeLot(f.t.pool, {
        sellerId: seller,
        status: 'in_review',
        now: new Date(f.clock.now().getTime() - 5000),
      });
      await makeLot(f.t.pool, { sellerId: seller, status: 'in_review', now: f.clock.now() });
      const m = await makeUser(f.t.pool, 'moderator');
      const first = await claimNextLot(f.deps, m);
      const again = await claimNextLot(f.deps, m);
      expect(first?.lotId).toBe(old);
      expect(again?.lotId).toBe(old);
      expect(
        await count(f.t.pool, `SELECT count(*) AS n FROM lots WHERE claimed_by = $1`, [m]),
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('empty queue → null; non-moderators cannot claim', async () => {
    const f = await newWorld();
    try {
      const m = await makeUser(f.t.pool, 'moderator');
      expect(await claimNextLot(f.deps, m)).toBeNull();
      const user = await makeUser(f.t.pool);
      const finance = await makeUser(f.t.pool, 'finance');
      for (const who of [user, finance])
        await expect(claimNextLot(f.deps, who)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await f.close();
    }
  });
});

describe('abandoned lots return to the queue after 15 minutes', () => {
  it('claimed and ignored → free again at +15 min, not a second before; the slow moderator loses the right to decide', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const lot = await makeLot(f.t.pool, {
        sellerId: seller,
        status: 'in_review',
        now: f.clock.now(),
      });
      const [slow, quick] = await makeUsers(f.t.pool, 2, 'moderator');
      expect((await claimNextLot(f.deps, slow!))?.lotId).toBe(lot);

      f.clock.advance(15 * 60_000 - 1);
      expect(await claimNextLot(f.deps, quick!)).toBeNull(); // still the slow one's
      f.clock.advance(1);
      expect((await claimNextLot(f.deps, quick!))?.lotId).toBe(lot); // returned to the queue and re-claimed

      await expect(approveLot(f.deps, { lotId: lot, moderatorId: slow! })).rejects.toMatchObject({
        code: 'REVIEW_CLAIM_LOST',
      });
      await expect(
        rejectLot(f.deps, { lotId: lot, moderatorId: slow!, reason: 'too late' }),
      ).rejects.toMatchObject({ code: 'REVIEW_CLAIM_LOST' });
      expect((await approveLot(f.deps, { lotId: lot, moderatorId: quick! })).endsAt).toBeTruthy();
    } finally {
      await f.close();
    }
  });

  it('even an unclaimed-looking decision after expiry fails: approving on an expired claim is refused', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const lot = await makeLot(f.t.pool, {
        sellerId: seller,
        status: 'in_review',
        now: f.clock.now(),
      });
      const m = await makeUser(f.t.pool, 'moderator');
      await claimNextLot(f.deps, m);
      f.clock.advance(15 * 60_000);
      await expect(approveLot(f.deps, { lotId: lot, moderatorId: m })).rejects.toMatchObject({
        code: 'REVIEW_CLAIM_LOST',
      });
      expect(await sweepExpiredClaims(f.deps)).toBe(1);
      expect(await sweepExpiredClaims(f.deps)).toBe(0);
      expect((await lotRow<{ claimed_by: string | null }>(f.t.pool, lot)).claimed_by).toBeNull();
    } finally {
      await f.close();
    }
  });
});

describe('deciding', () => {
  it('approve starts the clock: ends_at = now + duration; the lot becomes active; the seller is told', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const lot = await makeLot(f.t.pool, {
        sellerId: seller,
        status: 'in_review',
        durationDays: 5,
        now: f.clock.now(),
      });
      const m = await makeUser(f.t.pool, 'moderator');
      await claimNextLot(f.deps, m);
      f.clock.advance(60_000);
      const r = await approveLot(f.deps, { lotId: lot, moderatorId: m });
      expect(new Date(r.endsAt).getTime()).toBe(f.clock.now().getTime() + 5 * 24 * HOUR);
      expect(await lotRow(f.t.pool, lot)).toMatchObject({ status: 'active', claimed_by: null });
      expect(
        await count(
          f.t.pool,
          `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND kind = 'lot_approved'`,
          [seller],
        ),
      ).toBe(1);
      expect(
        await count(
          f.t.pool,
          `SELECT count(*) AS n FROM lot_audit WHERE lot_id = $1 AND action IN ('review_claimed', 'approved')`,
          [lot],
        ),
      ).toBe(2);
    } finally {
      await f.close();
    }
  });

  it('reject needs a reason; the seller can then fix the lot and resubmit', async () => {
    const f = await newWorld();
    try {
      await f.t.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'c','к','c','k') ON CONFLICT DO NOTHING`,
      );
      await f.t.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'k','м','k','m') ON CONFLICT DO NOTHING`,
      );
      const seller = await makeUser(f.t.pool);
      const created = await createLot(f.deps, seller, {
        title: 'Old camera',
        description: 'works',
        categoryId: 1,
        cityId: 1,
        condition: 'good',
        startPrice: UAH(100),
        reservePrice: null,
        buyNowPrice: null,
        durationDays: 3,
      });
      await submitLot(f.deps, { lotId: created.lotId, sellerId: seller });
      const m = await makeUser(f.t.pool, 'moderator');
      await claimNextLot(f.deps, m);
      await expect(
        rejectLot(f.deps, { lotId: created.lotId, moderatorId: m, reason: 'x' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await rejectLot(f.deps, {
        lotId: created.lotId,
        moderatorId: m,
        reason: 'Photos are blurry',
      });
      expect(await lotRow(f.t.pool, created.lotId)).toMatchObject({
        status: 'rejected',
        reject_reason: 'Photos are blurry',
      });

      await updateLot(f.deps, {
        lotId: created.lotId,
        sellerId: seller,
        patch: {
          title: 'Old camera, sharp photos',
          description: 'works',
          categoryId: 1,
          cityId: 1,
          condition: 'good',
          startPrice: UAH(100),
          reservePrice: null,
          buyNowPrice: null,
          durationDays: 3,
        },
      });
      expect(await lotRow(f.t.pool, created.lotId)).toMatchObject({
        status: 'draft',
        reject_reason: null,
      });
      await submitLot(f.deps, { lotId: created.lotId, sellerId: seller });
      expect((await claimNextLot(f.deps, m))?.lotId).toBe(created.lotId);
    } finally {
      await f.close();
    }
  });

  it('a seller cannot approve their own lot; a finished decision cannot be repeated', async () => {
    const f = await newWorld();
    try {
      const seller = await makeUser(f.t.pool);
      const lot = await makeLot(f.t.pool, {
        sellerId: seller,
        status: 'in_review',
        now: f.clock.now(),
      });
      await expect(approveLot(f.deps, { lotId: lot, moderatorId: seller })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const m = await makeUser(f.t.pool, 'moderator');
      await claimNextLot(f.deps, m);
      await approveLot(f.deps, { lotId: lot, moderatorId: m });
      await expect(approveLot(f.deps, { lotId: lot, moderatorId: m })).rejects.toMatchObject({
        code: 'LOT_STATUS_CONFLICT',
      });
    } finally {
      await f.close();
    }
  });
});

describe('seller editing rules (assignment: seller scenario 2)', () => {
  const lotInput = (over: Record<string, unknown> = {}) => ({
    title: 'Vintage camera',
    description: 'Works fine',
    categoryId: 1,
    cityId: 1,
    condition: 'good',
    startPrice: UAH(100),
    reservePrice: UAH(500),
    buyNowPrice: UAH(900),
    durationDays: 3,
    ...over,
  });
  const seedRef = async (pool: World['t']['pool']) => {
    await pool.query(
      `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'c','к','c','k') ON CONFLICT DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'k','м','k','m') ON CONFLICT DO NOTHING`,
    );
  };

  it('before the first bid anything can change; after it, only appending to the description', async () => {
    const f = await newWorld();
    try {
      await seedRef(f.t.pool);
      const seller = await makeUser(f.t.pool);
      const bidder = await makeUser(f.t.pool);
      const { lotId } = await createLot(f.deps, seller, lotInput());
      const mod = await makeUser(f.t.pool, 'moderator');
      await submitLot(f.deps, { lotId, sellerId: seller });
      await claimNextLot(f.deps, mod);
      await approveLot(f.deps, { lotId, moderatorId: mod });

      // live, no bids: full edit works, including prices
      await updateLot(f.deps, {
        lotId,
        sellerId: seller,
        patch: lotInput({ title: 'Better title', startPrice: UAH(80), reservePrice: null }),
      });
      expect(await lotRow(f.t.pool, lotId)).toMatchObject({
        title: 'Better title',
        start_price: UAH(80),
        current_price: UAH(80),
      });

      // first bid
      const { fund } = await import('@auction/test-kit');
      await fund(f.t.pool, bidder, UAH(1000));
      const { placeBid } = await import('../src/index.js');
      await placeBid(f.deps, {
        lotId,
        userId: bidder,
        kind: 'manual',
        amount: UAH(80),
        idempotencyKey: 'key-00000001',
      });

      await expect(
        updateLot(f.deps, { lotId, sellerId: seller, patch: lotInput({ title: 'Sneaky change' }) }),
      ).rejects.toMatchObject({ code: 'LOT_NOT_EDITABLE' });
      const r = await appendDescription(f.deps, {
        lotId,
        sellerId: seller,
        text: 'Box is included.',
      });
      expect(r.result.description).toBe('Works fine\nBox is included.');
      // The append is visible live, and the event numbering stays gapless.
      expect(
        await count(
          f.t.pool,
          `SELECT count(*) AS n FROM lot_events WHERE lot_id = $1 AND type = 'description'`,
          [lotId],
        ),
      ).toBe(1);
      // Someone else's lot is invisible to you.
      const stranger = await makeUser(f.t.pool);
      await expect(
        appendDescription(f.deps, { lotId, sellerId: stranger, text: 'hijack' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        updateLot(f.deps, { lotId, sellerId: stranger, patch: lotInput() }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await f.close();
    }
  });

  it('invalid input is refused at the domain boundary with field-level details', async () => {
    const f = await newWorld();
    try {
      await seedRef(f.t.pool);
      const seller = await makeUser(f.t.pool);
      const moderator = await makeUser(f.t.pool, 'moderator');
      const err = await createLot(
        f.deps,
        seller,
        lotInput({ startPrice: 10.5, reservePrice: UAH(50), durationDays: 99, status: 'active' }),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'VALIDATION_FAILED' });
      const paths = ((err as { details?: { path: string }[] }).details ?? []).map((d) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['startPrice', 'durationDays']));
      await expect(createLot(f.deps, moderator, lotInput())).rejects.toMatchObject({
        code: 'STAFF_CANNOT_TRADE',
      });
    } finally {
      await f.close();
    }
  });
});
