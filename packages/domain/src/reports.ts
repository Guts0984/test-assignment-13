import type { Pool } from '@auction/db';

export type FinanceReport = {
  readonly from: string;
  readonly to: string;
  /** Σ price of lots paid in the period. */
  readonly turnover: number;
  /** Commission on those lots (5% of the price, min 10 ₴, rounded in the seller's favour). */
  readonly commission: number;
  readonly paidLots: number;
  /** Wins offered in the period (first winners + second-chance offers) and how many were not paid. */
  readonly winsOffered: number;
  readonly unpaidWins: number;
  /** unpaidWins / winsOffered, 0 when nothing was offered. */
  readonly unpaidShare: number;
  readonly byCategory: readonly {
    readonly categoryId: number;
    readonly lots: number;
    readonly turnover: number;
    readonly commission: number;
  }[];
};

/**
 * Finance report for the inclusive UTC dates [from, to]. Commission is computed from the price with
 * the same formula the payout uses, so it covers lots that are paid but not yet paid out.
 * Everything is answered from `lots (paid_at) INCLUDE (...)` and two small index scans.
 */
export const financeReport = async (
  pool: Pool,
  from: string,
  to: string,
): Promise<FinanceReport> => {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);

  // Same arithmetic as commissionFor(): floor(5%), at least 10 UAH, never more than the price.
  const commissionSql = `LEAST(GREATEST((final_price * 5) / 100, 1000), final_price)`;
  const byCategory = await pool.query<{
    category_id: number;
    lots: number;
    turnover: number;
    commission: number;
  }>(
    `SELECT category_id, count(*)::int AS lots, SUM(final_price)::bigint AS turnover,
            SUM(${commissionSql})::bigint AS commission
       FROM lots WHERE paid_at >= $1 AND paid_at < $2
      GROUP BY category_id ORDER BY category_id`,
    [start, end],
  );
  const wins = await pool.query<{ offered: number; unpaid: number }>(
    `SELECT ((SELECT count(*) FROM lots WHERE sold_at >= $1 AND sold_at < $2)
           + (SELECT count(*) FROM second_chance_offers WHERE created_at >= $1 AND created_at < $2))::int AS offered,
            (SELECT count(*) FROM payment_defaults WHERE created_at >= $1 AND created_at < $2)::int AS unpaid`,
    [start, end],
  );
  const rows = byCategory.rows.map((r) => ({
    categoryId: r.category_id,
    lots: r.lots,
    turnover: r.turnover,
    commission: r.commission,
  }));
  const offered = wins.rows[0]?.offered ?? 0;
  const unpaid = wins.rows[0]?.unpaid ?? 0;
  return {
    from,
    to,
    turnover: rows.reduce((a, r) => a + r.turnover, 0),
    commission: rows.reduce((a, r) => a + r.commission, 0),
    paidLots: rows.reduce((a, r) => a + r.lots, 0),
    winsOffered: offered,
    unpaidWins: unpaid,
    unpaidShare: offered === 0 ? 0 : unpaid / offered,
    byCategory: rows,
  };
};
