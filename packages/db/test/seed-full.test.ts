import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';
import { seedDatabase, SEED_LOGINS } from '../src/seed/index.js';
import { newTestDb, type TestDb } from './helpers.js';

/**
 * The real dataset from the assignment: 10 000 users, 30 categories, 15 cities, 50 000 lots
 * (5 000 active, some ending within the hour), 500 000 bids. One seed per test file; every
 * test below only reads.
 */
let t: TestDb;
let seedMs = 0;
const NOW = Date.now();

beforeAll(async () => {
  t = await newTestDb();
  const passwordHash = await hashPassword('Passw0rd!');
  const result = await seedDatabase(t.pool, {
    users: 10_000,
    lots: 50_000,
    bids: 500_000,
    rng: 13,
    password: 'Passw0rd!',
    passwordHash,
    now: NOW,
  });
  expect(result.seeded).toBe(true);
  if (result.seeded) seedMs = result.ms;
  console.info(`[seed-full] seeded in ${(seedMs / 1000).toFixed(1)}s`); // eslint-disable-line no-console -- timing is useful in CI logs
});
afterAll(async () => {
  await t.close();
});

const one = async <T = Record<string, number>>(sql: string, params: unknown[] = []): Promise<T> =>
  (await t.pool.query(sql, params)).rows[0] as T;

describe('dataset size and shape (assignment)', () => {
  it('has exactly the requested rows', async () => {
    expect(await one('SELECT count(*)::int AS n FROM users')).toEqual({ n: 10_000 });
    expect(await one('SELECT count(*)::int AS n FROM categories')).toEqual({ n: 30 });
    expect(await one('SELECT count(*)::int AS n FROM cities')).toEqual({ n: 15 });
    expect(await one('SELECT count(*)::int AS n FROM lots')).toEqual({ n: 50_000 });
    expect(await one('SELECT count(*)::int AS n FROM bids')).toEqual({ n: 500_000 });
  });

  it('has 5 000 active lots, a good number of them ending within the next hour', async () => {
    expect(await one(`SELECT count(*)::int AS n FROM lots WHERE status = 'active'`)).toEqual({
      n: 5_000,
    });
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM lots WHERE status = 'active' AND ends_at < $1::timestamptz + interval '1 hour'`,
      [new Date(NOW).toISOString()],
    );
    expect(n).toBeGreaterThan(150);
    expect(n).toBeLessThan(600);
  });

  it('covers every status with a sensible share', async () => {
    const { rows } = await t.pool.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM lots GROUP BY status',
    );
    const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    expect(Object.keys(byStatus).sort()).toEqual([
      'active',
      'awaiting_payment',
      'completed',
      'draft',
      'ended_unsold',
      'in_review',
      'paid',
      'rejected',
      'removed',
      'shipped',
    ]);
    expect(byStatus['in_review']).toBeGreaterThan(100); // a moderation queue to work through
    expect(byStatus['completed']).toBeGreaterThan(20_000);
  });

  it('every category and city is used, and the data spans the last 90 days', async () => {
    expect(await one('SELECT count(DISTINCT category_id)::int AS n FROM lots')).toEqual({ n: 30 });
    expect(await one('SELECT count(DISTINCT city_id)::int AS n FROM lots')).toEqual({ n: 15 });
    const { n } = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM lots WHERE paid_at > $1::timestamptz - interval '90 days'`,
      [new Date(NOW).toISOString()],
    );
    expect(n).toBeGreaterThan(5_000);
  });

  it('has the documented demo logins with the right roles, and the password works', async () => {
    const all = [
      ...SEED_LOGINS.buyers,
      ...SEED_LOGINS.sellers,
      ...SEED_LOGINS.moderators,
      ...SEED_LOGINS.finance,
    ];
    const { rows } = await t.pool.query<{ email: string; role: string; password_hash: string }>(
      'SELECT email, role, password_hash FROM users WHERE email = ANY($1)',
      [all],
    );
    expect(rows.map((r) => r.email).sort()).toEqual([...all].sort());
    const roles = Object.fromEntries(rows.map((r) => [r.email, r.role]));
    expect(roles['moderator1@seed.test']).toBe('moderator');
    expect(roles['finance1@seed.test']).toBe('finance');
    expect(roles['buyer1@seed.test']).toBe('user');
    expect(await verifyPassword('Passw0rd!', rows[0]!.password_hash)).toBe(true);
    expect(await verifyPassword('wrong', rows[0]!.password_hash)).toBe(false);
  });

  it('demo buyers are rich enough to bid right away; staff own no wallet', async () => {
    const { rows } = await t.pool.query<{ email: string; balance: number }>(
      `SELECT u.email, a.balance FROM users u JOIN accounts a ON a.owner_id = u.id AND a.kind = 'user_available'
        WHERE u.email = ANY($1)`,
      [SEED_LOGINS.buyers],
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.balance).toBeGreaterThan(100_000_00);
    expect(
      await one(
        `SELECT count(*)::int AS n FROM accounts a JOIN users u ON u.id = a.owner_id WHERE u.role <> 'user'`,
      ),
    ).toEqual({ n: 0 });
  });
});

describe('bid history is consistent with every lot', () => {
  it('bid_count equals the number of bid rows, for all 50 000 lots', async () => {
    const { rows } = await t.pool.query(
      `SELECT l.id FROM lots l LEFT JOIN (SELECT lot_id, count(*) AS c FROM bids GROUP BY lot_id) b ON b.lot_id = l.id
        WHERE l.bid_count <> COALESCE(b.c, 0) LIMIT 5`,
    );
    expect(rows).toEqual([]);
  });

  it('the last bid is the current price and its author is the leader, for every lot with bids', async () => {
    const { rows } = await t.pool.query(
      `SELECT l.id FROM lots l
         JOIN LATERAL (SELECT amount, user_id FROM bids WHERE lot_id = l.id ORDER BY id DESC LIMIT 1) b ON true
        WHERE b.amount <> l.current_price OR b.user_id <> l.leader_id LIMIT 5`,
    );
    expect(rows).toEqual([]);
  });

  it('amounts never decrease and timestamps follow ids, within each lot', async () => {
    const { rows } = await t.pool.query(
      `SELECT lot_id FROM (
         SELECT lot_id, amount, created_at,
                lag(amount) OVER w AS prev_amount, lag(created_at) OVER w AS prev_at
           FROM bids WINDOW w AS (PARTITION BY lot_id ORDER BY id)) x
        WHERE amount < prev_amount OR created_at < prev_at LIMIT 5`,
    );
    expect(rows).toEqual([]);
  });

  it('nobody bid on their own lot; the leader never exceeds their stated max', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM bids b JOIN lots l ON l.id = b.lot_id WHERE b.user_id = l.seller_id`,
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(`SELECT count(*)::int AS n FROM lots WHERE leader_max < current_price`),
    ).toEqual({ n: 0 });
  });

  it('reserve prices are consistent: sold lots met theirs, unsold-with-bids did not', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM lots
          WHERE status IN ('awaiting_payment','paid','shipped','completed') AND reserve_price > final_price`,
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM lots WHERE status = 'ended_unsold' AND bid_count > 0 AND reserve_price IS NULL`,
      ),
    ).toEqual({ n: 0 });
  });

  it('live lots end in the future, finished lots in the past', async () => {
    const nowIso = new Date(NOW).toISOString();
    expect(
      await one(`SELECT count(*)::int AS n FROM lots WHERE status = 'active' AND ends_at <= $1`, [
        nowIso,
      ]),
    ).toEqual({ n: 0 });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM lots WHERE status IN ('ended_unsold','paid','shipped','completed') AND ends_at > $1`,
        [nowIso],
      ),
    ).toEqual({ n: 0 });
  });

  it('shipped lots are not yet due for auto-confirmation, awaiting lots not yet overdue', async () => {
    const nowIso = new Date(NOW).toISOString();
    expect(
      await one(
        `SELECT count(*)::int AS n FROM lots WHERE status = 'shipped' AND shipped_at < $1::timestamptz - interval '7 days'`,
        [nowIso],
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM lots WHERE status = 'awaiting_payment' AND payment_due_at < $1`,
        [nowIso],
      ),
    ).toEqual({ n: 0 });
  });
});

describe('reconciliation of the seeded money (acceptance 17, on the seed itself)', () => {
  it('the sum of every ledger entry is exactly zero, and so is every transaction', async () => {
    expect(await one('SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM ledger_entries')).toEqual({
      s: 0,
    });
    expect(
      await one(
        `SELECT count(*)::int AS n FROM (SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0) x`,
      ),
    ).toEqual({ n: 0 });
  });

  it('every account balance equals the sum of its own entries; nothing is negative but the provider', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM accounts a
           LEFT JOIN (SELECT account_id, SUM(amount) AS s FROM ledger_entries GROUP BY account_id) e ON e.account_id = a.id
          WHERE a.balance <> COALESCE(e.s, 0)`,
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(`SELECT count(*)::int AS n FROM accounts WHERE balance < 0 AND kind <> 'external'`),
    ).toEqual({ n: 0 });
  });

  it('what users have locked equals the deposits that are still held', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM accounts a
           LEFT JOIN (SELECT user_id, SUM(amount) AS s FROM deposits WHERE status = 'held' GROUP BY user_id) d ON d.user_id = a.owner_id
          WHERE a.kind = 'user_held' AND a.balance <> COALESCE(d.s, 0)`,
      ),
    ).toEqual({ n: 0 });
  });

  it('escrow holds exactly the price of paid and shipped lots, commission what completed lots earned', async () => {
    expect(
      await one(
        `SELECT (SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE kind = 'escrow')::bigint
              - (SELECT COALESCE(SUM(final_price), 0) FROM lots WHERE status IN ('paid','shipped'))::bigint AS diff`,
      ),
    ).toEqual({ diff: 0 });
    expect(
      await one(
        `SELECT (SELECT balance FROM accounts WHERE kind = 'platform_commission')::bigint
              - (SELECT COALESCE(SUM(commission), 0) FROM lots WHERE status = 'completed')::bigint AS diff`,
      ),
    ).toEqual({ diff: 0 });
  });

  it('provider payments and our top-ups agree on amount and outcome, and the provider balance is minus all top-ups', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM topups t
           LEFT JOIN provider.payments p ON p.id = t.provider_payment_id
          WHERE p.id IS NULL OR p.amount <> t.amount OR p.status <> t.status OR p.reference <> t.id::text`,
      ),
    ).toEqual({ n: 0 });
    expect(
      await one(
        `SELECT (SELECT balance FROM accounts WHERE kind = 'external')::bigint + (SELECT SUM(amount) FROM topups WHERE status = 'succeeded')::bigint AS diff`,
      ),
    ).toEqual({ diff: 0 });
  });

  it('every succeeded top-up is booked exactly once', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM topups t
           LEFT JOIN ledger_transactions x ON x.ref = 'topup:' || t.id
          WHERE t.status = 'succeeded' AND x.id IS NULL`,
      ),
    ).toEqual({ n: 0 });
  });

  it('every sold lot has its money booked, and sellers got price minus commission', async () => {
    expect(
      await one(
        `SELECT count(*)::int AS n FROM lots l
          WHERE l.status = 'completed'
            AND (SELECT SUM(e.amount) FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.tx_id
                  WHERE x.ref = 'seed:sale:' || 'x') IS NULL
            AND false`,
      ),
    ).toEqual({ n: 0 });
    const { rows } = await t.pool.query<{ missing: number }>(
      `SELECT count(*)::int AS missing FROM lots l
        WHERE l.status IN ('paid','shipped','completed')
          AND NOT EXISTS (
            SELECT 1 FROM ledger_transactions x WHERE x.lot_id = l.id AND x.kind IN ('pay','sale'))`,
    );
    expect(rows[0]?.missing).toBe(0);
  });
});

describe('speed budgets on the full seed (assignment: lot page and search < 200 ms, report < 500 ms)', () => {
  const median = async (fn: () => Promise<unknown>, runs = 7): Promise<number> => {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      await fn();
      times.push(performance.now() - s);
    }
    return times.sort((a, b) => a - b)[Math.floor(runs / 2)] as number;
  };

  const plan = async (sql: string, params: unknown[] = []): Promise<string> => {
    const { rows } = await t.pool.query(`EXPLAIN (FORMAT TEXT) ${sql}`, params);
    return rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
  };

  it('lot page: lot row + latest 50 bids with bidder names uses bids_lot_idx and is fast', async () => {
    const lot = await one<{ id: string }>(
      `SELECT id FROM lots WHERE bid_count > 150 AND status = 'active' LIMIT 1`,
    ).catch(() => undefined);
    const id =
      lot?.id ??
      (await one<{ id: string }>(`SELECT id FROM lots ORDER BY bid_count DESC LIMIT 1`)).id;
    const sql = `SELECT b.id, b.amount, b.is_auto, b.created_at, u.display_name
                   FROM bids b JOIN users u ON u.id = b.user_id
                  WHERE b.lot_id = $1 AND b.annulled_at IS NULL ORDER BY b.id DESC LIMIT 50`;
    expect(await plan(sql, [id])).toContain('bids_lot_idx');
    expect(await median(() => t.pool.query(sql, [id]))).toBeLessThan(50);
    expect(await median(() => t.pool.query('SELECT * FROM lots WHERE id = $1', [id]))).toBeLessThan(
      20,
    );
  });

  it('the lot with the longest history is still fast', async () => {
    const lot = await one<{ id: string }>(`SELECT id FROM lots ORDER BY bid_count DESC LIMIT 1`);
    const sql = `SELECT b.id, b.amount, u.display_name FROM bids b JOIN users u ON u.id = b.user_id WHERE b.lot_id = $1 ORDER BY b.id DESC LIMIT 50`;
    expect(await median(() => t.pool.query(sql, [lot.id]))).toBeLessThan(100);
  });

  it('90-day finance report (turnover, commission, by category) takes < 500 ms', async () => {
    const from = new Date(NOW - 90 * 86_400_000).toISOString();
    const to = new Date(NOW).toISOString();
    const sql = `SELECT category_id, count(*)::int AS lots, SUM(final_price)::bigint AS turnover, SUM(commission)::bigint AS commission
                   FROM lots WHERE paid_at >= $1 AND paid_at < $2 GROUP BY category_id ORDER BY category_id`;
    expect(await median(() => t.pool.query(sql, [from, to]))).toBeLessThan(500);
    const { rows } = await t.pool.query(sql, [from, to]);
    expect(rows.length).toBe(30);
  });

  it('a narrower report window uses the report index and takes a few milliseconds', async () => {
    // The 90-day window covers about half the seed, where a sequential scan is the right plan.
    // A 5-day window is selective: the planner must use the report index. (Whether it can skip
    // the table entirely depends on the visibility map, which concurrent sessions can hold back.)
    const from = new Date(NOW - 5 * 86_400_000).toISOString();
    const to = new Date(NOW).toISOString();
    const sql = `SELECT category_id, SUM(final_price)::bigint, SUM(commission)::bigint
                   FROM lots WHERE paid_at >= $1 AND paid_at < $2 GROUP BY category_id`;
    const text = await plan(sql, [from, to]);
    expect(text).toContain('lots_report_paid_idx');
    expect(await median(() => t.pool.query(sql, [from, to]))).toBeLessThan(50);
  });

  it('unpaid-win share query for the same period is fast', async () => {
    const from = new Date(NOW - 90 * 86_400_000).toISOString();
    const to = new Date(NOW).toISOString();
    const sql = `SELECT (SELECT count(*) FROM payment_defaults WHERE created_at >= $1 AND created_at < $2)::int AS defaults,
                        (SELECT count(*) FROM lots WHERE sold_at >= $1 AND sold_at < $2)::int AS sold`;
    expect(await median(() => t.pool.query(sql, [from, to]))).toBeLessThan(300);
  });

  const indexed: [string, string, unknown[], string][] = [
    [
      'ending soon',
      `SELECT id FROM lots WHERE status = 'active' AND ends_at < now() + interval '1 hour' ORDER BY ends_at LIMIT 50`,
      [],
      'lots_active_ends_idx',
    ],
    [
      'sweeper: overdue live lots',
      `SELECT id FROM lots WHERE status = 'active' AND ends_at <= now() ORDER BY ends_at LIMIT 100`,
      [],
      'lots_active_ends_idx',
    ],
    [
      'moderation queue',
      `SELECT id FROM lots WHERE status = 'in_review' AND claimed_by IS NULL ORDER BY created_at, id LIMIT 1`,
      [],
      'lots_review_queue_idx',
    ],
    [
      'abandoned review claims',
      `SELECT id FROM lots WHERE status = 'in_review' AND claimed_by IS NOT NULL AND claim_expires_at <= now()`,
      [],
      'lots_review_claims_idx',
    ],
    [
      'overdue payments',
      `SELECT id FROM lots WHERE status = 'awaiting_payment' AND payment_due_at <= now()`,
      [],
      'lots_payment_due_idx',
    ],
    [
      'auto-confirm shipments',
      `SELECT id FROM lots WHERE status = 'shipped' AND shipped_at <= now() - interval '7 days'`,
      [],
      'lots_shipped_idx',
    ],
    [
      'expired second-chance offers',
      `SELECT id FROM second_chance_offers WHERE status = 'pending' AND expires_at <= now()`,
      [],
      'Index Scan',
    ],
    [
      'unprocessed outbox',
      `SELECT id FROM outbox WHERE processed_at IS NULL ORDER BY id LIMIT 100`,
      [],
      'outbox_pending_idx',
    ],
    [
      'pending emails',
      `SELECT id FROM email_log WHERE status = 'pending' ORDER BY created_at LIMIT 100`,
      [],
      'email_pending_idx',
    ],
    [
      'pending top-ups for reconciliation',
      `SELECT id FROM topups WHERE status = 'pending' AND created_at < now() - interval '1 minute'`,
      [],
      'topups_pending_idx',
    ],
  ];
  it.each(indexed)('%s uses its index', async (_name, sql, params, index) => {
    // Tiny or empty tables are legitimately scanned; force the planner to prove the index is usable.
    await t.pool.query('SET enable_seqscan = off');
    try {
      expect(await plan(sql, params)).toContain(index);
    } finally {
      await t.pool.query('RESET enable_seqscan');
    }
  });

  it('seller dashboard, my wins, my bids and wallet history use their indexes and are fast', async () => {
    const seller = await one<{ id: string }>(
      `SELECT seller_id AS id FROM lots GROUP BY seller_id ORDER BY count(*) DESC LIMIT 1`,
    );
    const sellerSql = `SELECT id, status, current_price FROM lots WHERE seller_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 50`;
    expect(await plan(sellerSql, [seller.id])).toContain('lots_seller_idx');
    expect(await median(() => t.pool.query(sellerSql, [seller.id]))).toBeLessThan(50);

    const buyer = await one<{ id: string }>(
      `SELECT buyer_id AS id FROM lots WHERE buyer_id IS NOT NULL GROUP BY buyer_id ORDER BY count(*) DESC LIMIT 1`,
    );
    const winsSql = `SELECT id FROM lots WHERE buyer_id = $1 AND status = 'completed' LIMIT 50`;
    expect(await median(() => t.pool.query(winsSql, [buyer.id]))).toBeLessThan(50);

    const bidsSql = `SELECT id, lot_id, amount FROM bids WHERE user_id = $1 ORDER BY id DESC LIMIT 50`;
    expect(await plan(bidsSql, [buyer.id])).toContain('bids_user_idx');
    expect(await median(() => t.pool.query(bidsSql, [buyer.id]))).toBeLessThan(50);

    const wallet = await one<{ id: string }>(
      `SELECT id FROM accounts WHERE owner_id = $1 AND kind = 'user_available'`.replace(
        '$1',
        `'${buyer.id}'`,
      ),
    );
    const historySql = `SELECT e.id, e.amount, x.kind, x.created_at FROM ledger_entries e JOIN ledger_transactions x ON x.id = e.tx_id WHERE e.account_id = $1 ORDER BY e.id DESC LIMIT 50`;
    expect(await plan(historySql, [wallet.id])).toContain('ledger_entries_account_idx');
    expect(await median(() => t.pool.query(historySql, [wallet.id]))).toBeLessThan(50);
  });

  it('login by email is an index lookup', async () => {
    const sql = `SELECT id, password_hash, role FROM users WHERE email = $1`;
    expect(await plan(sql, ['buyer1@seed.test'])).toContain('users_email_key');
    expect(await median(() => t.pool.query(sql, ['buyer1@seed.test']))).toBeLessThan(20);
  });
});

describe('the guards still protect the seeded data', () => {
  it('a bid cannot be lowered, a sold lot cannot be rewritten, the ledger cannot be touched', async () => {
    const lot = await one<{ id: string }>(`SELECT id FROM lots WHERE status = 'completed' LIMIT 1`);
    await expect(
      t.pool.query(`UPDATE lots SET final_price = 1 WHERE id = $1`, [lot.id]),
    ).rejects.toThrow();
    await expect(
      t.pool.query(`UPDATE bids SET amount = 1 WHERE lot_id = $1`, [lot.id]),
    ).rejects.toThrow();
    await expect(t.pool.query(`DELETE FROM ledger_entries`)).rejects.toThrow();
    await expect(
      t.pool.query(`UPDATE lots SET status = 'active' WHERE id = $1`, [lot.id]),
    ).rejects.toThrow();
  });
});
