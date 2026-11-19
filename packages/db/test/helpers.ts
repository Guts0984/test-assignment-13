import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, createPool, type Db, type Pool } from '../src/client.js';
import { cloneDatabase, adminUrl, type TestDatabase } from '../src/testing.js';

export type TestDb = {
  readonly pool: Pool;
  readonly db: Db;
  readonly url: string;
  readonly close: () => Promise<void>;
};

/** A private copy of the migrated schema. Call `close()` in afterAll. */
export const newTestDb = async (poolSize = 10): Promise<TestDb> => {
  const template: TestDatabase = {
    name: inject('templateName'),
    url: '',
    drop: () => Promise.resolve(),
  };
  const clone = await cloneDatabase(template);
  const pool = createPool(clone.url, { max: poolSize });
  return {
    pool,
    db: createDb(pool),
    url: clone.url,
    close: async () => {
      await pool.end();
      await clone.drop();
    },
  };
};

export { adminUrl };

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export const insertUser = async (
  q: Queryable,
  role: 'user' | 'moderator' | 'finance' = 'user',
  name = 'tester',
): Promise<string> => {
  const id = randomUUID();
  await q.query(
    `INSERT INTO users (id, email, password_hash, display_name, role) VALUES ($1, $2, 'x', $3, $4)`,
    [id, `${id}@t.test`, name, role],
  );
  return id;
};

export const ensureRefData = async (q: Queryable): Promise<void> => {
  await q.query(
    `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1, 'c1', 'к', 'c', 'k') ON CONFLICT DO NOTHING`,
  );
  await q.query(
    `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1, 'k1', 'м', 'k', 'm') ON CONFLICT DO NOTHING`,
  );
};

export type LotOverrides = Record<string, unknown>;

/** Inserts a lot with sensible defaults; overrides use snake_case column names. */
export const insertLot = async (
  q: Queryable,
  sellerId: string,
  overrides: LotOverrides = {},
): Promise<string> => {
  await ensureRefData(q);
  const row: Record<string, unknown> = {
    id: randomUUID(),
    seller_id: sellerId,
    title: 'Test lot',
    description: 'desc',
    category_id: 1,
    city_id: 1,
    condition: 'good',
    start_price: 10_000,
    current_price: 10_000,
    duration_days: 3,
    status: 'draft',
    ...overrides,
  };
  const cols = Object.keys(row);
  await q.query(
    `INSERT INTO lots (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  );
  return row['id'] as string;
};

export const insertActiveLot = (q: Queryable, sellerId: string, overrides: LotOverrides = {}) =>
  insertLot(q, sellerId, {
    status: 'active',
    starts_at: new Date(Date.now() - 3600_000),
    ends_at: new Date(Date.now() + 86_400_000),
    ...overrides,
  });

/** Gets (or creates) a user's two wallet accounts. */
export const walletAccounts = async (q: Queryable, userId: string) => {
  const get = async (kind: 'available' | 'held') => {
    const key = `user:${userId}:${kind}`;
    const r = await q.query<{ id: string }>(
      `INSERT INTO accounts (key, kind, owner_id) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
      [key, `user_${kind}`, userId],
    );
    return r.rows[0]!.id;
  };
  return { available: await get('available'), held: await get('held') };
};

export const systemAccounts = async (q: Queryable) => {
  const get = async (key: string, kind: string) => {
    const r = await q.query<{ id: string }>(
      `INSERT INTO accounts (key, kind) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
      [key, kind],
    );
    return r.rows[0]!.id;
  };
  return {
    external: await get('external:payment_provider', 'external'),
    commission: await get('platform:commission', 'platform_commission'),
  };
};

export const escrowAccount = async (q: Queryable, lotId: string) => {
  const r = await q.query<{ id: string }>(
    `INSERT INTO accounts (key, kind, lot_id) VALUES ($1, 'escrow', $2)
     ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`,
    [`escrow:${lotId}`, lotId],
  );
  return r.rows[0]!.id;
};

export type Entry = { account: string; amount: number };

// A PoolClient also has connect(), so tell them apart by class.
const isPool = (q: Queryable): q is pg.Pool => q instanceof pg.Pool;

/**
 * Books one ledger transaction (header + entries). Given a pool it runs atomically in its own
 * database transaction; given a client the caller owns the transaction.
 */
export const post = async (
  q: Queryable,
  ref: string,
  entries: readonly Entry[],
  kind = 'test',
): Promise<string> => {
  if (isPool(q)) {
    const c = await q.connect();
    try {
      await c.query('BEGIN');
      const id = await post(c, ref, entries, kind);
      await c.query('COMMIT');
      return id;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  const tx = await q.query<{ id: string }>(
    `INSERT INTO ledger_transactions (kind, ref) VALUES ($1, $2) RETURNING id`,
    [kind, ref],
  );
  const txId = tx.rows[0]!.id;
  for (const e of entries) {
    await q.query(`INSERT INTO ledger_entries (tx_id, account_id, amount) VALUES ($1, $2, $3)`, [
      txId,
      e.account,
      e.amount,
    ]);
  }
  return txId;
};

/** Runs fn inside BEGIN/COMMIT on its own connection; rolls back and rethrows on error. */
export const inTx = async <T>(pool: Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};

export const balanceOf = async (q: Queryable, accountId: string): Promise<number> =>
  (await q.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = $1', [accountId]))
    .rows[0]!.balance;

/** Resolves with the error (or undefined if it did not throw) so tests can assert on it. */
export const errorOf = async (fn: () => Promise<unknown>): Promise<Error | undefined> => {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e as Error;
  }
};

/** Postgres error code (SQLSTATE) of a failed query. */
export const sqlState = (e: Error | undefined): string | undefined =>
  (e as { code?: string } | undefined)?.code;
