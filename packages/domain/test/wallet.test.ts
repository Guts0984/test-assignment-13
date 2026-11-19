import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceOf, count, makeUser } from '@auction/test-kit';
import {
  attachProviderPayment,
  createTopup,
  reconcile,
  reconcilePendingTopups,
  settleTopup,
  walletSummary,
  type ProviderStatus,
} from '../src/index.js';
import { newWorld, UAH, type World } from './world.js';

let w: World;
beforeAll(async () => {
  w = await newWorld();
});
afterAll(async () => {
  await w.close();
});

const newTopup = async (user: string, amount = UAH(500)) => {
  const { result } = await createTopup(w.deps, {
    userId: user,
    amount,
    idempotencyKey: randomUUID(),
  });
  const paymentId = randomUUID();
  await attachProviderPayment(w.t.pool, result.topupId, paymentId);
  return { topupId: result.topupId, paymentId };
};
const ledgerOk = async (fetch?: Parameters<typeof reconcile>[1]) => {
  const r = await reconcile(w.t.pool, fetch);
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
};

describe('a top-up is credited exactly once (invariant 6)', () => {
  it('success credits the wallet and tells the user', async () => {
    const user = await makeUser(w.t.pool);
    const { topupId } = await newTopup(user, UAH(500));
    const r = await settleTopup(w.deps, { topupId, outcome: 'succeeded' });
    expect(r.result).toEqual({ status: 'succeeded', credited: true });
    expect(await balanceOf(w.t.pool, user, 'available')).toBe(UAH(500));
    expect(r.effects.notifications.map((n) => n.kind)).toEqual(['topup_succeeded']);
    await ledgerOk();
  });

  it('a duplicate webhook (same verdict delivered twice, or 50 times in parallel) credits once', async () => {
    const user = await makeUser(w.t.pool);
    const { topupId } = await newTopup(user, UAH(500));
    const results = await Promise.all(
      Array.from({ length: 50 }, () => settleTopup(w.deps, { topupId, outcome: 'succeeded' })),
    );
    expect(results.filter((r) => r.result.credited)).toHaveLength(1);
    expect(results.every((r) => r.result.status === 'succeeded')).toBe(true);
    expect(await balanceOf(w.t.pool, user, 'available')).toBe(UAH(500));
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM ledger_transactions WHERE ref = $1`, [
        `topup:${topupId}`,
      ]),
    ).toBe(1);
    await ledgerOk();
  });

  it('out of order: "failed" arriving after "succeeded" changes nothing; the reverse credits nothing', async () => {
    const user = await makeUser(w.t.pool);
    const a = await newTopup(user, UAH(100));
    await settleTopup(w.deps, { topupId: a.topupId, outcome: 'succeeded' });
    expect((await settleTopup(w.deps, { topupId: a.topupId, outcome: 'failed' })).result).toEqual({
      status: 'succeeded',
      credited: false,
    });
    const b = await newTopup(user, UAH(200));
    await settleTopup(w.deps, { topupId: b.topupId, outcome: 'failed' });
    expect(
      (await settleTopup(w.deps, { topupId: b.topupId, outcome: 'succeeded' })).result,
    ).toEqual({ status: 'failed', credited: false });
    expect(await balanceOf(w.t.pool, user, 'available')).toBe(UAH(100));
    await ledgerOk();
  });

  it('racing contradictory verdicts: one wins, the balance reflects exactly that winner', async () => {
    for (let round = 0; round < 15; round++) {
      const user = await makeUser(w.t.pool);
      const { topupId } = await newTopup(user, UAH(300));
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          settleTopup(w.deps, { topupId, outcome: i % 2 ? 'succeeded' : 'failed' }),
        ),
      );
      const final = results[0]?.result.status;
      expect(new Set(results.map((r) => r.result.status)).size).toBe(1);
      expect(await balanceOf(w.t.pool, user, 'available')).toBe(
        final === 'succeeded' ? UAH(300) : 0,
      );
    }
    await ledgerOk();
  });

  it('an unknown top-up is NOT_FOUND', async () => {
    await expect(
      settleTopup(w.deps, { topupId: randomUUID(), outcome: 'succeeded' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only ordinary users have a wallet', async () => {
    for (const role of ['moderator', 'finance'] as const) {
      const staff = await makeUser(w.t.pool, role);
      await expect(
        createTopup(w.deps, { userId: staff, amount: UAH(100), idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'STAFF_CANNOT_TRADE' });
    }
  });
});

describe('top-up requests are idempotent (invariant 7)', () => {
  it('same key and amount → one top-up; same key, other amount → refused', async () => {
    const user = await makeUser(w.t.pool);
    const key = randomUUID();
    const a = await createTopup(w.deps, { userId: user, amount: UAH(500), idempotencyKey: key });
    const b = await createTopup(w.deps, { userId: user, amount: UAH(500), idempotencyKey: key });
    expect(b.replayed).toBe(true);
    expect(b.result).toEqual(a.result);
    await expect(
      createTopup(w.deps, { userId: user, amount: UAH(600), idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM topups WHERE user_id = $1`, [user]),
    ).toBe(1);
  });

  it('20 simultaneous identical requests create one top-up', async () => {
    const user = await makeUser(w.t.pool);
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 20 }, () =>
        createTopup(w.deps, { userId: user, amount: UAH(500), idempotencyKey: key }),
      ),
    );
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    expect(
      await count(w.t.pool, `SELECT count(*) AS n FROM topups WHERE user_id = $1`, [user]),
    ).toBe(1);
  });
});

describe('a webhook that never arrives is found by the reconciler', () => {
  const provider =
    (statuses: Record<string, ProviderStatus>) =>
    (id: string): Promise<ProviderStatus> =>
      Promise.resolve(statuses[id] ?? 'not_found');

  it('credits what the provider says succeeded, fails what it says failed, leaves pending ones alone, only once', async () => {
    const f = await newWorld();
    try {
      const user = await makeUser(f.t.pool);
      const mk = async (amount: number) => {
        const { result } = await createTopup(f.deps, {
          userId: user,
          amount,
          idempotencyKey: randomUUID(),
        });
        const paymentId = randomUUID();
        await attachProviderPayment(f.t.pool, result.topupId, paymentId);
        return { ...result, paymentId };
      };
      const paid = await mk(UAH(100));
      const failed = await mk(UAH(200));
      const waiting = await mk(UAH(300));
      await createTopup(f.deps, {
        userId: user,
        amount: UAH(400),
        idempotencyKey: randomUUID(),
      }); // no provider payment at all
      const fetchStatus = provider({
        [paid.paymentId]: 'succeeded',
        [failed.paymentId]: 'failed',
        [waiting.paymentId]: 'pending',
      });

      // Too fresh: not looked at yet (the webhook may still be on its way).
      expect(await reconcilePendingTopups(f.deps, fetchStatus, 60_000)).toEqual({
        checked: 0,
        credited: 0,
        failed: 0,
      });
      f.clock.advance(2 * 60_000);
      const r = await reconcilePendingTopups(f.deps, fetchStatus, 60_000);
      expect(r).toEqual({ checked: 4, credited: 1, failed: 2 });
      expect(await balanceOf(f.t.pool, user, 'available')).toBe(UAH(100));
      // Running it again (or from another worker) changes nothing.
      const again = await reconcilePendingTopups(f.deps, fetchStatus, 60_000);
      expect(again.credited).toBe(0);
      expect(await balanceOf(f.t.pool, user, 'available')).toBe(UAH(100));
      expect(
        await count(f.t.pool, `SELECT count(*) AS n FROM topups WHERE status = 'pending'`),
      ).toBe(1); // only "waiting"
    } finally {
      await f.close();
    }
  });

  it('finance reconciliation lists every top-up that disagrees with the provider', async () => {
    const f = await newWorld();
    try {
      const user = await makeUser(f.t.pool);
      const ours = await (async () => {
        const { result } = await createTopup(f.deps, {
          userId: user,
          amount: UAH(100),
          idempotencyKey: randomUUID(),
        });
        const paymentId = randomUUID();
        await attachProviderPayment(f.t.pool, result.topupId, paymentId);
        await settleTopup(f.deps, { topupId: result.topupId, outcome: 'succeeded' });
        return { ...result, paymentId };
      })();
      const lostWebhook = await (async () => {
        const { result } = await createTopup(f.deps, {
          userId: user,
          amount: UAH(250),
          idempotencyKey: randomUUID(),
        });
        const paymentId = randomUUID();
        await attachProviderPayment(f.t.pool, result.topupId, paymentId);
        return { ...result, paymentId }; // we are still pending, the provider has charged
      })();
      const agree = await reconcile(f.t.pool, (id) =>
        Promise.resolve({ status: id === ours.paymentId ? 'succeeded' : 'pending' }),
      );
      expect(agree.ok).toBe(true);
      const report = await reconcile(f.t.pool, (id) =>
        Promise.resolve({
          status: 'succeeded',
          amount: id === ours.paymentId ? UAH(999) : UAH(250),
        }),
      );
      expect(report.ok).toBe(false);
      expect(report.providerMismatches).toEqual(
        expect.arrayContaining([
          { topupId: lostWebhook.topupId, ours: 'pending', provider: 'succeeded' },
          { topupId: ours.topupId, ours: 'succeeded', provider: 'amount_differs' },
        ]),
      );
      expect(report.entriesSum).toBe(0); // the ledger itself is fine; only the provider disagrees
    } finally {
      await f.close();
    }
  });
});

describe('wallet summary', () => {
  it('balance = available + held, history shows each movement, only for the asked user', async () => {
    const user = await makeUser(w.t.pool);
    const other = await makeUser(w.t.pool);
    const { topupId } = await newTopup(user, UAH(500));
    await settleTopup(w.deps, { topupId, outcome: 'succeeded' });
    const { topupId: otherTopup } = await newTopup(other, UAH(999));
    await settleTopup(w.deps, { topupId: otherTopup, outcome: 'succeeded' });
    const s = await walletSummary(w.t.pool, user);
    expect(s).toMatchObject({ balance: UAH(500), held: 0, available: UAH(500) });
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({ kind: 'topup', availableDelta: UAH(500), heldDelta: 0 });
    expect(JSON.stringify(s)).not.toContain(String(UAH(999)));
    expect(await walletSummary(w.t.pool, randomUUID())).toEqual({
      balance: 0,
      held: 0,
      available: 0,
      history: [],
    });
  });
});
