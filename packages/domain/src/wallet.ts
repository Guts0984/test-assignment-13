import { appError } from '@auction/shared';
import type { Pool } from '@auction/db';
import { idempotent } from './idempotency.js';
import { book, ensureSystemAccounts, ensureWallet } from './ledger.js';
import { notify } from './support.js';
import { withTx } from './tx.js';
import { NO_EFFECTS, type Deps, type Notification, type Outcome } from './types.js';

export type TopupStatus = 'pending' | 'succeeded' | 'failed';

export type CreateTopupResult = {
  readonly topupId: string;
  readonly amount: number;
  readonly status: TopupStatus;
};

/** Records the intention to top up. The provider payment is created by the caller (HTTP) and attached after. */
export const createTopup = (
  deps: Deps,
  input: { userId: string; amount: number; idempotencyKey: string },
) =>
  idempotent<CreateTopupResult>(
    deps,
    {
      userId: input.userId,
      scope: 'topup',
      key: input.idempotencyKey,
      body: { amount: input.amount },
    },
    async (tx): Promise<Outcome<CreateTopupResult>> => {
      const now = deps.clock.now();
      const user = (
        await tx.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [input.userId])
      ).rows[0];
      if (user?.role !== 'user')
        throw appError('STAFF_CANNOT_TRADE', 'only ordinary users have a wallet');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO topups (user_id, amount, created_at) VALUES ($1, $2, $3) RETURNING id`,
        [input.userId, input.amount, now],
      );
      const topupId = rows[0]?.id;
      if (!topupId) throw appError('INTERNAL', 'top-up was not created');
      return { result: { topupId, amount: input.amount, status: 'pending' }, effects: NO_EFFECTS };
    },
  );

export const attachProviderPayment = async (
  pool: Pool,
  topupId: string,
  providerPaymentId: string,
): Promise<void> => {
  await pool.query(
    `UPDATE topups SET provider_payment_id = $2 WHERE id = $1 AND provider_payment_id IS NULL`,
    [topupId, providerPaymentId],
  );
};

export type SettleResult = {
  readonly status: TopupStatus;
  /** True only for the one call that actually moved the money. */
  readonly credited: boolean;
};

/**
 * Applies the provider's FINAL verdict to a top-up. Called by the webhook handler (after it
 * re-fetched the authoritative status) and by the reconciler. Any number of calls, in any order:
 *   - pending → succeeded: credit the wallet, exactly once (the UPDATE wins once; the ledger ref
 *     `topup:<id>` is a second, database-level lock);
 *   - pending → failed: nothing moves;
 *   - already settled: no-op, and a late contradicting verdict cannot change it.
 */
export const settleTopup = (
  deps: Deps,
  input: { topupId: string; outcome: 'succeeded' | 'failed' },
): Promise<Outcome<SettleResult>> =>
  withTx(deps.pool, async (tx): Promise<Outcome<SettleResult>> => {
    const now = deps.clock.now();
    const won = await tx.query<{ user_id: string; amount: number }>(
      `UPDATE topups SET status = $2, settled_at = $3 WHERE id = $1 AND status = 'pending' RETURNING user_id, amount`,
      [input.topupId, input.outcome, now],
    );
    const row = won.rows[0];
    if (!row) {
      const current = await tx.query<{ status: TopupStatus }>(
        'SELECT status FROM topups WHERE id = $1',
        [input.topupId],
      );
      const status = current.rows[0]?.status;
      if (!status) throw appError('NOT_FOUND', 'top-up not found');
      return { result: { status, credited: false }, effects: NO_EFFECTS };
    }
    if (input.outcome === 'failed') {
      return { result: { status: 'failed', credited: false }, effects: NO_EFFECTS };
    }
    const w = await ensureWallet(tx, row.user_id);
    const sys = await ensureSystemAccounts(tx);
    await book(tx, {
      kind: 'topup',
      ref: `topup:${input.topupId}`,
      userId: row.user_id,
      at: now,
      entries: [
        { account: sys.external, amount: -row.amount },
        { account: w.available, amount: row.amount },
      ],
    });
    const notifications: Notification[] = [
      await notify(
        tx,
        {
          userId: row.user_id,
          kind: 'topup_succeeded',
          payload: { topupId: input.topupId, amount: row.amount },
        },
        now,
      ),
    ];
    return {
      result: { status: 'succeeded', credited: true },
      effects: { events: [], notifications },
    };
  });

export type ProviderStatus = 'pending' | 'succeeded' | 'failed' | 'not_found';

/**
 * The reconciler for top-ups whose webhook never arrived: asks the provider for each pending
 * top-up older than `olderThanMs` and settles it. Run every minute by the worker.
 */
export const reconcilePendingTopups = async (
  deps: Deps,
  fetchStatus: (providerPaymentId: string) => Promise<ProviderStatus>,
  olderThanMs: number,
): Promise<{ checked: number; credited: number; failed: number }> => {
  const cutoff = new Date(deps.clock.now().getTime() - olderThanMs);
  const { rows } = await deps.pool.query<{ id: string; provider_payment_id: string | null }>(
    `SELECT id, provider_payment_id FROM topups WHERE status = 'pending' AND created_at <= $1 ORDER BY created_at LIMIT 200`,
    [cutoff],
  );
  let credited = 0;
  let failed = 0;
  for (const t of rows) {
    // A top-up with no provider payment never reached the provider: it can never succeed.
    const status: ProviderStatus = t.provider_payment_id
      ? await fetchStatus(t.provider_payment_id)
      : 'not_found';
    if (status === 'pending') continue;
    const outcome = status === 'succeeded' ? 'succeeded' : 'failed';
    const r = await settleTopup(deps, { topupId: t.id, outcome });
    if (r.result.credited) credited++;
    else if (outcome === 'failed' && r.result.status === 'failed') failed++;
  }
  return { checked: rows.length, credited, failed };
};

export type WalletSummary = {
  readonly balance: number;
  readonly held: number;
  readonly available: number;
  readonly history: readonly {
    readonly at: string;
    readonly kind: string;
    readonly lotId: string | null;
    readonly availableDelta: number;
    readonly heldDelta: number;
  }[];
};

/** Own wallet only: the caller passes their own user id. History is one row per ledger transaction. */
export const walletSummary = async (
  pool: Pool,
  userId: string,
  historyLimit = 50,
): Promise<WalletSummary> => {
  const bal = await pool.query<{ kind: string; balance: number }>(
    `SELECT kind, balance FROM accounts WHERE owner_id = $1 AND kind IN ('user_available', 'user_held')`,
    [userId],
  );
  const available = bal.rows.find((r) => r.kind === 'user_available')?.balance ?? 0;
  const held = bal.rows.find((r) => r.kind === 'user_held')?.balance ?? 0;
  const hist = await pool.query<{
    created_at: Date;
    kind: string;
    lot_id: string | null;
    available_delta: number;
    held_delta: number;
  }>(
    `SELECT x.created_at, x.kind, x.lot_id,
            COALESCE(SUM(e.amount) FILTER (WHERE a.kind = 'user_available'), 0)::bigint AS available_delta,
            COALESCE(SUM(e.amount) FILTER (WHERE a.kind = 'user_held'), 0)::bigint AS held_delta
       FROM ledger_entries e
       JOIN accounts a ON a.id = e.account_id
       JOIN ledger_transactions x ON x.id = e.tx_id
      WHERE a.owner_id = $1 AND a.kind IN ('user_available', 'user_held')
      GROUP BY x.id, x.created_at, x.kind, x.lot_id
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT $2`,
    [userId, historyLimit],
  );
  return {
    balance: available + held,
    held,
    available,
    history: hist.rows.map((r) => ({
      at: r.created_at.toISOString(),
      kind: r.kind,
      lotId: r.lot_id,
      availableDelta: r.available_delta,
      heldDelta: r.held_delta,
    })),
  };
};
