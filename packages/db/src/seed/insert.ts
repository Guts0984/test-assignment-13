import type pg from 'pg';

type Row = Record<string, unknown>;

const IDENT = /^[a-z_][a-z0-9_]*$/;
const quoteTable = (table: string): string => {
  const parts = table.split('.');
  if (parts.length > 2 || parts.some((p) => !IDENT.test(p)))
    throw new Error(`unsafe table ${table}`);
  return parts.map((p) => `"${p}"`).join('.');
};

/**
 * Bulk insert through json_populate_recordset: one statement per batch, column types come from
 * the table itself, so there is no per-column casting code. Columns that no row mentions keep
 * their DEFAULT; a column some rows leave out becomes NULL for those rows.
 */
export const bulkInsert = async (
  client: pg.PoolClient,
  table: string,
  rows: readonly Row[],
  batchSize = 4000,
): Promise<void> => {
  if (rows.length === 0) return;
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (columns.some((c) => !IDENT.test(c))) throw new Error(`unsafe column in ${table}`);
  const list = columns.map((c) => `"${c}"`).join(', ');
  const sql = `INSERT INTO ${quoteTable(table)} (${list})
               SELECT ${list} FROM json_populate_recordset(null::${quoteTable(table)}, $1::json)`;
  for (let i = 0; i < rows.length; i += batchSize) {
    await client.query(sql, [JSON.stringify(rows.slice(i, i + batchSize))]);
  }
};
