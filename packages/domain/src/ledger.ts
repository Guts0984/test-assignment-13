import { appError } from '@auction/shared';
import type { Tx } from './types.js';

/**
 * Posting helpers. The database enforces the invariants (entries sum to zero, no overdraft,
 * unique ref); these helpers make correct posting the easy path:
 *   - accounts are created on demand,
 *   - entries are always inserted in ascending account-id order, so concurrent transactions
 *     lock accounts in the same order and cannot deadlock each other.
 */

export type Entry = { readonly account: string; readonly amount: number };

export type Wallet = { readonly available: string; readonly held: string };

export const ensureWallet = async (tx: Tx, userId: string): Promise<Wallet> => {
  await tx.query(
    `INSERT INTO accounts (key, kind, owner_id) VALUES
       ('user:' || ($1::uuid)::text || ':available', 'user_available', $1::uuid),
       ('user:' || ($1::uuid)::text || ':held', 'user_held', $1::uuid)
     ON CONFLICT (key) DO NOTHING`,
    [userId],
  );
  const { rows } = await tx.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM accounts WHERE owner_id = $1 AND kind IN ('user_available', 'user_held')`,
    [userId],
  );
  const available = rows.find((r) => r.kind === 'user_available')?.id;
  const held = rows.find((r) => r.kind === 'user_held')?.id;
  if (!available || !held) throw appError('INTERNAL', 'wallet accounts could not be created');
  return { available, held };
};

export const ensureEscrow = async (tx: Tx, lotId: string): Promise<string> => {
  await tx.query(
    `INSERT INTO accounts (key, kind, lot_id) VALUES ('escrow:' || ($1::uuid)::text, 'escrow', $1::uuid)
     ON CONFLICT (key) DO NOTHING`,
    [lotId],
  );
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM accounts WHERE key = 'escrow:' || ($1::uuid)::text`,
    [lotId],
  );
  const id = rows[0]?.id;
  if (!id) throw appError('INTERNAL', 'escrow account could not be created');
  return id;
};

export const ensureSystemAccounts = async (
  tx: Tx,
): Promise<{ external: string; commission: string }> => {
  await tx.query(
    `INSERT INTO accounts (key, kind) VALUES
       ('external:payment_provider', 'external'),
       ('platform:commission', 'platform_commission')
     ON CONFLICT (key) DO NOTHING`,
  );
  const { rows } = await tx.query<{ id: string; kind: string }>(
    `SELECT id, kind FROM accounts WHERE kind IN ('external', 'platform_commission')`,
  );
  const external = rows.find((r) => r.kind === 'external')?.id;
  const commission = rows.find((r) => r.kind === 'platform_commission')?.id;
  if (!external || !commission) throw appError('INTERNAL', 'system accounts missing');
  return { external, commission };
};

/**
 * Locks the given accounts (in id order) and returns their current balances. After this, the
 * balances cannot change until the transaction ends, so a "balance >= amount" check is exact.
 */
export const lockBalances = async (
  tx: Tx,
  accountIds: readonly string[],
): Promise<Map<string, number>> => {
  const { rows } = await tx.query<{ id: string; balance: number }>(
    `SELECT id, balance FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...new Set(accountIds)]],
  );
  return new Map(rows.map((r) => [r.id, r.balance]));
};

export type Booking = {
  readonly kind: string;
  /** Business idempotency key, unique across the ledger. */
  readonly ref: string;
  readonly lotId?: string;
  readonly userId?: string;
  readonly entries: readonly Entry[];
  readonly at: Date;
};

/** Books one balanced transaction. Zero entries are dropped, duplicate accounts are merged. */
export const book = async (tx: Tx, booking: Booking): Promise<string> => {
  const merged = new Map<string, number>();
  for (const e of booking.entries) merged.set(e.account, (merged.get(e.account) ?? 0) + e.amount);
  const entries = [...merged.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length < 2)
    throw appError('INTERNAL', `booking ${booking.ref} has fewer than 2 entries`);

  const header = await tx.query<{ id: string }>(
    `INSERT INTO ledger_transactions (kind, ref, lot_id, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [booking.kind, booking.ref, booking.lotId ?? null, booking.userId ?? null, booking.at],
  );
  const txId = header.rows[0]?.id;
  if (!txId) throw appError('INTERNAL', 'ledger header was not created');
  await tx.query(
    `INSERT INTO ledger_entries (tx_id, account_id, amount)
     SELECT $1, a, m FROM unnest($2::uuid[], $3::bigint[]) WITH ORDINALITY AS t(a, m, ord) ORDER BY ord`,
    [txId, entries.map(([a]) => a), entries.map(([, m]) => m)],
  );
  return txId;
};
