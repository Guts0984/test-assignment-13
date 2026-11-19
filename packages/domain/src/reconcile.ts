import type { Pool } from '@auction/db';
import type { ProviderStatus } from './wallet.js';

export type ReconciliationReport = {
  /** Σ of every ledger entry. Must be 0. */
  readonly entriesSum: number;
  /** Transactions whose entries do not sum to 0 (must be none). */
  readonly unbalancedTransactions: readonly string[];
  /** Accounts whose stored balance differs from the sum of their entries (must be none). */
  readonly balanceMismatches: readonly { account: string; balance: number; entriesSum: number }[];
  readonly negativeBalances: readonly string[];
  /** Users whose held balance differs from their held deposits (must be none). */
  readonly heldMismatches: readonly { userId: string; held: number; deposits: number }[];
  /** Escrow vs paid/shipped lots, commission vs completed lots. */
  readonly escrowDiff: number;
  readonly commissionDiff: number;
  /** Our top-ups against the payment provider's records. */
  readonly providerMismatches: readonly {
    topupId: string;
    ours: string;
    provider: ProviderStatus | 'amount_differs';
  }[];
  readonly ok: boolean;
};

/**
 * Finance's reconciliation. It never changes anything; it only reports. With a provider status
 * fetcher it also lists every top-up that disagrees with the provider (the check that finds
 * a webhook that never arrived).
 */
export const reconcile = async (
  pool: Pool,
  fetchProvider?: (paymentId: string) => Promise<{ status: ProviderStatus; amount?: number }>,
): Promise<ReconciliationReport> => {
  const q = <T extends Record<string, unknown>>(sql: string) =>
    pool.query<T>(sql).then((r) => r.rows);

  const sum =
    (await q<{ s: number }>(`SELECT COALESCE(SUM(amount), 0)::bigint AS s FROM ledger_entries`))[0]
      ?.s ?? 0;
  const unbalanced = await q<{ tx_id: string }>(
    `SELECT tx_id FROM ledger_entries GROUP BY tx_id HAVING SUM(amount) <> 0`,
  );
  const mismatches = await q<{ key: string; balance: number; s: number }>(
    `SELECT a.key, a.balance, COALESCE(e.s, 0)::bigint AS s FROM accounts a
       LEFT JOIN (SELECT account_id, SUM(amount) AS s FROM ledger_entries GROUP BY account_id) e ON e.account_id = a.id
      WHERE a.balance <> COALESCE(e.s, 0)`,
  );
  const negatives = await q<{ key: string }>(
    `SELECT key FROM accounts WHERE balance < 0 AND kind <> 'external'`,
  );
  const held = await q<{ owner_id: string; balance: number; d: number }>(
    `SELECT a.owner_id, a.balance, COALESCE(d.s, 0)::bigint AS d FROM accounts a
       LEFT JOIN (SELECT user_id, SUM(amount) AS s FROM deposits WHERE status = 'held' GROUP BY user_id) d ON d.user_id = a.owner_id
      WHERE a.kind = 'user_held' AND a.balance <> COALESCE(d.s, 0)`,
  );
  const escrow =
    (
      await q<{ diff: number }>(
        `SELECT ((SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE kind = 'escrow')
             - (SELECT COALESCE(SUM(final_price), 0) FROM lots WHERE status IN ('paid', 'shipped')))::bigint AS diff`,
      )
    )[0]?.diff ?? 0;
  const commission =
    (
      await q<{ diff: number }>(
        `SELECT ((SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE kind = 'platform_commission')
             - (SELECT COALESCE(SUM(commission), 0) FROM lots WHERE status = 'completed'))::bigint AS diff`,
      )
    )[0]?.diff ?? 0;

  const providerMismatches: ReconciliationReport['providerMismatches'][number][] = [];
  if (fetchProvider) {
    const topups = await q<{
      id: string;
      status: string;
      amount: number;
      provider_payment_id: string | null;
    }>(`SELECT id, status, amount, provider_payment_id FROM topups`);
    for (const t of topups) {
      if (!t.provider_payment_id) {
        if (t.status === 'succeeded')
          providerMismatches.push({ topupId: t.id, ours: t.status, provider: 'not_found' });
        continue;
      }
      const theirs = await fetchProvider(t.provider_payment_id);
      if (theirs.status !== t.status) {
        providerMismatches.push({ topupId: t.id, ours: t.status, provider: theirs.status });
      } else if (theirs.amount !== undefined && theirs.amount !== t.amount) {
        providerMismatches.push({ topupId: t.id, ours: t.status, provider: 'amount_differs' });
      }
    }
  }

  const report: Omit<ReconciliationReport, 'ok'> = {
    entriesSum: sum,
    unbalancedTransactions: unbalanced.map((r) => r.tx_id),
    balanceMismatches: mismatches.map((r) => ({
      account: r.key,
      balance: r.balance,
      entriesSum: r.s,
    })),
    negativeBalances: negatives.map((r) => r.key),
    heldMismatches: held.map((r) => ({ userId: r.owner_id, held: r.balance, deposits: r.d })),
    escrowDiff: escrow,
    commissionDiff: commission,
    providerMismatches,
  };
  const ok =
    report.entriesSum === 0 &&
    report.unbalancedTransactions.length === 0 &&
    report.balanceMismatches.length === 0 &&
    report.negativeBalances.length === 0 &&
    report.heldMismatches.length === 0 &&
    report.escrowDiff === 0 &&
    report.commissionDiff === 0 &&
    report.providerMismatches.length === 0;
  return { ...report, ok };
};
