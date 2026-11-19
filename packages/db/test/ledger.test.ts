import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balanceOf,
  errorOf,
  escrowAccount,
  inTx,
  insertActiveLot,
  insertUser,
  newTestDb,
  post,
  sqlState,
  systemAccounts,
  walletAccounts,
  type TestDb,
} from './helpers.js';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb();
});
afterAll(async () => {
  await t.close();
});

const CHECK_VIOLATION = '23514';
const INTEGRITY = '23000';
const UNIQUE = '23505';

/** A funded user: top-up booked through the real double-entry path. */
const fundedUser = async (amount: number) => {
  const user = await insertUser(t.pool);
  const w = await walletAccounts(t.pool, user);
  const sys = await systemAccounts(t.pool);
  await post(t.pool, `topup:${randomUUID()}`, [
    { account: sys.external, amount: -amount },
    { account: w.available, amount },
  ]);
  return { user, ...w, ...sys };
};

describe('double entry: every transaction sums to zero', () => {
  it('accepts a balanced transaction and updates both balances', async () => {
    const u = await fundedUser(100_000);
    expect(await balanceOf(t.pool, u.available)).toBe(100_000);
    expect(await balanceOf(t.pool, u.external)).toBeLessThan(0);
  });

  it('rejects an unbalanced transaction at commit (money from nowhere)', async () => {
    const u = await fundedUser(0 + 1000);
    const err = await errorOf(() =>
      post(t.pool, `evil:${randomUUID()}`, [{ account: u.available, amount: 5_000_000 }]),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
    expect(await balanceOf(t.pool, u.available)).toBe(1000);
  });

  it('rejects entries that do not cancel out, however many there are', async () => {
    const u = await fundedUser(10_000);
    const v = await fundedUser(0 + 100);
    const err = await errorOf(() =>
      inTx(t.pool, (c) =>
        post(c, `skew:${randomUUID()}`, [
          { account: u.available, amount: -3000 },
          { account: v.available, amount: 1000 },
          { account: v.held, amount: 1999 }, // one kopeck short
        ]),
      ),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
    expect(await balanceOf(t.pool, u.available)).toBe(10_000);
    expect(await balanceOf(t.pool, v.available)).toBe(100);
  });

  it('rejects a one-sided transaction even if the single entry is "zero-sum" by itself', async () => {
    const u = await fundedUser(10_000);
    // A lone entry can never be zero (amount <> 0 CHECK), so the minimum is two entries.
    const err = await errorOf(() =>
      post(t.pool, `solo:${randomUUID()}`, [{ account: u.available, amount: 1 }]),
    );
    expect(err).toBeDefined();
  });

  it('rejects a transaction header with no entries', async () => {
    const err = await errorOf(() =>
      t.pool.query(`INSERT INTO ledger_transactions (kind, ref) VALUES ('x', $1)`, [
        `empty:${randomUUID()}`,
      ]),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
  });

  it('rejects a zero-amount entry and an out-of-range amount', async () => {
    const u = await fundedUser(10_000);
    const tx = await t.pool
      .query<{ id: string }>(
        `INSERT INTO ledger_transactions (kind, ref) VALUES ('x', $1) RETURNING id`,
        [`z:${randomUUID()}`],
      )
      .catch(() => undefined);
    expect(tx).toBeUndefined(); // header alone fails at commit (autocommit): see above
    const err1 = await errorOf(() =>
      inTx(t.pool, async (c) => {
        const h = await c.query<{ id: string }>(
          `INSERT INTO ledger_transactions (kind, ref) VALUES ('x', $1) RETURNING id`,
          [`z2:${randomUUID()}`],
        );
        await c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, 0)', [
          h.rows[0]!.id,
          u.available,
        ]);
      }),
    );
    expect(sqlState(err1)).toBe(CHECK_VIOLATION);
    const err2 = await errorOf(() =>
      post(t.pool, `big:${randomUUID()}`, [
        { account: u.external, amount: -10_000_000_001 },
        { account: u.available, amount: 10_000_000_001 },
      ]),
    );
    expect(sqlState(err2)).toBe(CHECK_VIOLATION);
  });

  it('a failed transaction leaves no trace: no header, no entries, no balance change', async () => {
    const u = await fundedUser(5_000);
    const ref = `ghost:${randomUUID()}`;
    await errorOf(() => inTx(t.pool, (c) => post(c, ref, [{ account: u.available, amount: 123 }])));
    const { rows } = await t.pool.query('SELECT 1 FROM ledger_transactions WHERE ref = $1', [ref]);
    expect(rows).toHaveLength(0);
    expect(await balanceOf(t.pool, u.available)).toBe(5_000);
  });
});

describe('append-only', () => {
  it.each([
    ['UPDATE entry amount', `UPDATE ledger_entries SET amount = amount + 1`],
    ['UPDATE entry account', `UPDATE ledger_entries SET account_id = account_id`],
    ['DELETE entry', `DELETE FROM ledger_entries`],
    ['UPDATE transaction ref', `UPDATE ledger_transactions SET ref = ref || 'x'`],
    ['DELETE transaction', `DELETE FROM ledger_transactions`],
    ['TRUNCATE entries', `TRUNCATE ledger_entries CASCADE`],
    ['TRUNCATE transactions', `TRUNCATE ledger_transactions CASCADE`],
  ])('forbids %s', async (_name, statement) => {
    await fundedUser(1_000);
    const err = await errorOf(() => t.pool.query(statement));
    expect(sqlState(err)).toBe(INTEGRITY);
  });
});

describe('balance is derived and never negative', () => {
  it('cannot be edited directly', async () => {
    const u = await fundedUser(1_000);
    const err = await errorOf(() =>
      t.pool.query('UPDATE accounts SET balance = 999999999 WHERE id = $1', [u.available]),
    );
    expect(sqlState(err)).toBe(INTEGRITY);
    expect(await balanceOf(t.pool, u.available)).toBe(1_000);
  });

  it('account identity cannot be edited or deleted', async () => {
    const u = await fundedUser(1_000);
    const other = await insertUser(t.pool);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query('UPDATE accounts SET owner_id = $1 WHERE id = $2', [other, u.available]),
        ),
      ),
    ).toBeDefined();
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE accounts SET kind = 'external' WHERE id = $1`, [u.available]),
        ),
      ),
    ).toBeDefined();
    expect(
      sqlState(
        await errorOf(() => t.pool.query('DELETE FROM accounts WHERE id = $1', [u.available])),
      ),
    ).toBe(INTEGRITY);
  });

  it('a user wallet cannot be overdrawn by one kopeck', async () => {
    const u = await fundedUser(10_000);
    const err = await errorOf(() =>
      post(t.pool, `over:${randomUUID()}`, [
        { account: u.available, amount: -10_001 },
        { account: u.held, amount: 10_001 },
      ]),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
    expect(await balanceOf(t.pool, u.available)).toBe(10_000);
    expect(await balanceOf(t.pool, u.held)).toBe(0);
  });

  it('spending exactly the whole balance is fine', async () => {
    const u = await fundedUser(10_000);
    await post(t.pool, `all:${randomUUID()}`, [
      { account: u.available, amount: -10_000 },
      { account: u.held, amount: 10_000 },
    ]);
    expect(await balanceOf(t.pool, u.available)).toBe(0);
  });

  it('held money cannot go negative either (releasing more than was held)', async () => {
    const u = await fundedUser(10_000);
    await post(t.pool, `h:${randomUUID()}`, [
      { account: u.available, amount: -2_000 },
      { account: u.held, amount: 2_000 },
    ]);
    const err = await errorOf(() =>
      post(t.pool, `rel:${randomUUID()}`, [
        { account: u.held, amount: -2_001 },
        { account: u.available, amount: 2_001 },
      ]),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
  });

  it('only the external account may be negative; the platform sink only grows', async () => {
    const u = await fundedUser(10_000);
    const err = await errorOf(() =>
      post(t.pool, `drain:${randomUUID()}`, [
        { account: u.commission, amount: -1 },
        { account: u.available, amount: 1 },
      ]),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
  });

  it('staff cannot own a wallet; account keys must match their shape', async () => {
    const moderator = await insertUser(t.pool, 'moderator');
    const finance = await insertUser(t.pool, 'finance');
    for (const staff of [moderator, finance]) {
      const err = await errorOf(() => walletAccounts(t.pool, staff));
      expect(sqlState(err)).toBe(INTEGRITY);
    }
    const user = await insertUser(t.pool);
    const wrongKey = await errorOf(() =>
      t.pool.query(
        `INSERT INTO accounts (key, kind, owner_id) VALUES ('user:someone-else:available', 'user_available', $1)`,
        [user],
      ),
    );
    expect(sqlState(wrongKey)).toBe(CHECK_VIOLATION);
    const noOwner = await errorOf(() =>
      t.pool.query(`INSERT INTO accounts (key, kind) VALUES ('x', 'user_available')`),
    );
    expect(sqlState(noOwner)).toBe(CHECK_VIOLATION);
  });

  it('balance always equals the sum of its entries, for every account, after all of the above', async () => {
    const { rows } = await t.pool.query(`
      SELECT a.key, a.balance, COALESCE(SUM(e.amount), 0)::bigint AS entries_sum
        FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
       GROUP BY a.id HAVING a.balance <> COALESCE(SUM(e.amount), 0)`);
    expect(rows).toEqual([]);
    const total = await t.pool.query<{ s: number }>(
      `SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM ledger_entries`,
    );
    expect(total.rows[0]?.s).toBe(0);
  });
});

describe('the same business event cannot be booked twice', () => {
  it('rejects a duplicate ref (a replayed top-up webhook can never credit twice)', async () => {
    const u = await fundedUser(0 + 100);
    const ref = `topup:${randomUUID()}`;
    await post(t.pool, ref, [
      { account: u.external, amount: -5_000 },
      { account: u.available, amount: 5_000 },
    ]);
    const err = await errorOf(() =>
      post(t.pool, ref, [
        { account: u.external, amount: -5_000 },
        { account: u.available, amount: 5_000 },
      ]),
    );
    expect(sqlState(err)).toBe(UNIQUE);
    expect(await balanceOf(t.pool, u.available)).toBe(5_100);
  });

  it('20 concurrent attempts with one ref: exactly one wins and the balance moves once', async () => {
    const u = await fundedUser(0 + 100);
    const ref = `topup:${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        inTx(t.pool, (c) =>
          post(c, ref, [
            { account: u.external, amount: -7_000 },
            { account: u.available, amount: 7_000 },
          ]),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) {
      if (r.status === 'rejected') expect(sqlState(r.reason as Error)).toBe(UNIQUE);
    }
    expect(await balanceOf(t.pool, u.available)).toBe(7_100);
  });
});

describe('concurrent spending of one balance (invariant 4)', () => {
  const hold = (u: { available: string; held: string }, amount: number) =>
    inTx(t.pool, (c) =>
      post(c, `hold:${randomUUID()}`, [
        { account: u.available, amount: -amount },
        { account: u.held, amount },
      ]),
    );

  it('money for 3 deposits, 10 concurrent attempts: exactly 3 succeed, balance never below zero', async () => {
    const u = await fundedUser(3_000);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => hold(u, 1_000)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    for (const r of results) {
      if (r.status === 'rejected') expect(sqlState(r.reason as Error)).toBe(CHECK_VIOLATION);
    }
    expect(await balanceOf(t.pool, u.available)).toBe(0);
    expect(await balanceOf(t.pool, u.held)).toBe(3_000);
  });

  it('200 concurrent holds of random size: successes add up exactly and nothing overdraws', async () => {
    const u = await fundedUser(50_000);
    const sizes = Array.from({ length: 200 }, (_, i) => 100 + ((i * 37) % 900));
    const results = await Promise.allSettled(sizes.map((s) => hold(u, s)));
    const won = results.flatMap((r, i) => (r.status === 'fulfilled' ? [sizes[i]!] : []));
    const spent = won.reduce((a, b) => a + b, 0);
    expect(spent).toBeLessThanOrEqual(50_000);
    expect(await balanceOf(t.pool, u.held)).toBe(spent);
    expect(await balanceOf(t.pool, u.available)).toBe(50_000 - spent);
  });

  it('transfers that lock accounts in a fixed (sorted) order never deadlock', async () => {
    const a = await fundedUser(100_000);
    const b = await fundedUser(100_000);
    const sorted = (xs: { account: string; amount: number }[]) =>
      [...xs].sort((x, y) => (x.account < y.account ? -1 : 1));
    const transfer = (from: typeof a, to: typeof a) =>
      inTx(t.pool, (c) =>
        post(
          c,
          `x:${randomUUID()}`,
          sorted([
            { account: from.available, amount: -10 },
            { account: to.available, amount: 10 },
          ]),
        ),
      );
    // 200 concurrent transfers in both directions: must all succeed with zero deadlocks.
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => (i % 2 ? transfer(a, b) : transfer(b, a))),
    );
    expect(await balanceOf(t.pool, a.available)).toBe(100_000);
    expect(await balanceOf(t.pool, b.available)).toBe(100_000);
  });

  it('inverted lock order DOES deadlock: Postgres aborts one victim (40P01), nothing hangs or corrupts', async () => {
    const a = await fundedUser(100_000);
    const b = await fundedUser(100_000);
    const c1 = await t.pool.connect();
    const c2 = await t.pool.connect();
    const header = async (c: typeof c1) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO ledger_transactions (kind, ref) VALUES ('x', $1) RETURNING id`,
          [`inv:${randomUUID()}`],
        )
      ).rows[0]!.id;
    const entry = (c: typeof c1, tx: string, account: string, amount: number) =>
      c.query('INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, $3)', [
        tx,
        account,
        amount,
      ]);
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const tx1 = await header(c1);
      const tx2 = await header(c2);
      await entry(c1, tx1, a.available, -1); // c1 holds a
      await entry(c2, tx2, b.available, -1); // c2 holds b
      // Now each wants the other's account.
      const outcome = await Promise.allSettled([
        entry(c1, tx1, b.available, 1),
        entry(c2, tx2, a.available, 1),
      ]);
      const failures = outcome.filter((o) => o.status === 'rejected');
      expect(failures).toHaveLength(1);
      expect(sqlState((failures[0] as PromiseRejectedResult).reason as Error)).toBe('40P01');
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
    expect(await balanceOf(t.pool, a.available)).toBe(100_000);
    expect(await balanceOf(t.pool, b.available)).toBe(100_000);
  });
});

describe('escrow and lots', () => {
  it('escrow account belongs to a lot, key must match, and it cannot go negative', async () => {
    const seller = await insertUser(t.pool);
    const lot = await insertActiveLot(t.pool, seller);
    const escrow = await escrowAccount(t.pool, lot);
    const u = await fundedUser(10_000);
    const err = await errorOf(() =>
      post(t.pool, `esc:${randomUUID()}`, [
        { account: escrow, amount: -1 },
        { account: u.available, amount: 1 },
      ]),
    );
    expect(sqlState(err)).toBe(CHECK_VIOLATION);
  });
});
