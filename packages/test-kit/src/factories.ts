import { randomUUID } from 'node:crypto';
import type { Pool } from '@auction/db';

/**
 * Raw-SQL fixtures. They deliberately do not use the domain code that the tests exercise, so a
 * bug in a use case cannot hide itself by also being in the way the test set things up.
 */

export type Role = 'user' | 'moderator' | 'finance';

export const makeUser = async (
  pool: Pool,
  role: Role = 'user',
  displayName?: string,
): Promise<string> => {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, display_name, role) VALUES ($1, $2, 'x', $3, $4)`,
    [id, `${id}@t.test`, displayName ?? `user_${id.slice(0, 4)}`, role],
  );
  return id;
};

export const makeUsers = (pool: Pool, n: number, role: Role = 'user'): Promise<string[]> =>
  Promise.all(Array.from({ length: n }, () => makeUser(pool, role)));

export const ensureRefData = async (pool: Pool): Promise<void> => {
  await pool.query(
    `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1, 'c1', 'к', 'c', 'k') ON CONFLICT DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1, 'k1', 'м', 'k', 'm') ON CONFLICT DO NOTHING`,
  );
};

/** Gives a user spendable money the way a successful top-up would (balanced, with a ref). */
export const fund = async (pool: Pool, userId: string, amount: number): Promise<void> => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO accounts (key, kind, owner_id) VALUES
         ('user:' || ($1::uuid)::text || ':available', 'user_available', $1::uuid),
         ('user:' || ($1::uuid)::text || ':held', 'user_held', $1::uuid) ON CONFLICT (key) DO NOTHING`,
      [userId],
    );
    await c.query(
      `INSERT INTO accounts (key, kind) VALUES ('external:payment_provider', 'external'), ('platform:commission', 'platform_commission')
       ON CONFLICT (key) DO NOTHING`,
    );
    const ref = `fixture-topup:${randomUUID()}`;
    const tx = await c.query<{ id: string }>(
      `INSERT INTO ledger_transactions (kind, ref, user_id) VALUES ('topup', $1, $2::uuid) RETURNING id`,
      [ref, userId],
    );
    await c.query(
      `INSERT INTO ledger_entries (tx_id, account_id, amount)
       SELECT $1::uuid, id, CASE WHEN kind = 'external' THEN -$3::bigint ELSE $3::bigint END
         FROM accounts WHERE key IN ('external:payment_provider', 'user:' || ($2::uuid)::text || ':available') ORDER BY id`,
      [tx.rows[0]?.id, userId, amount],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
};

export type LotFixture = {
  sellerId: string;
  startPrice?: number;
  reservePrice?: number | null;
  buyNowPrice?: number | null;
  durationDays?: number;
  /** Absolute end time; defaults to one day after `now`. */
  endsAt?: Date;
  now?: Date;
  status?: 'draft' | 'in_review' | 'active';
  title?: string;
};

/** Inserts a lot directly (no review flow). Active by default. */
export const makeLot = async (pool: Pool, f: LotFixture): Promise<string> => {
  await ensureRefData(pool);
  const now = f.now ?? new Date();
  const status = f.status ?? 'active';
  const start = f.startPrice ?? 10_000;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO lots (id, seller_id, title, category_id, city_id, condition, start_price, current_price,
                       reserve_price, buy_now_price, duration_days, status, starts_at, ends_at, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 1, 'good', $4, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
    [
      id,
      f.sellerId,
      f.title ?? 'Fixture lot',
      start,
      f.reservePrice ?? null,
      f.buyNowPrice ?? null,
      f.durationDays ?? 3,
      status,
      status === 'active' ? now : null,
      status === 'active' ? (f.endsAt ?? new Date(now.getTime() + 86_400_000)) : null,
      now,
    ],
  );
  return id;
};

export const count = async (pool: Pool, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await pool.query<{ n: string | number }>(sql, params)).rows[0]?.n ?? 0);

export const balanceOf = async (
  pool: Pool,
  userId: string,
  kind: 'available' | 'held',
): Promise<number> =>
  (
    await pool.query<{ balance: number }>(`SELECT balance FROM accounts WHERE key = $1`, [
      `user:${userId}:${kind}`,
    ])
  ).rows[0]?.balance ?? 0;

export const lotRow = async <T = Record<string, unknown>>(pool: Pool, lotId: string): Promise<T> =>
  (await pool.query(`SELECT * FROM lots WHERE id = $1`, [lotId])).rows[0] as T;
