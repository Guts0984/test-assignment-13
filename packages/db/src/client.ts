import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;
export type Pool = pg.Pool;

// BIGINT (OID 20) arrives as a string by default. Every bigint column here is kopecks, a counter
// or a sequence number below 2^53, so parse them as numbers once, in one place.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${value} does not fit in a JS number`);
  return n;
});

export type PoolOptions = { max?: number; applicationName?: string };

export const createPool = (url: string, options: PoolOptions = {}): Pool => {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'auction',
    // A runaway query must not hold a lot lock forever.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
  });
  // An idle connection can be killed (database restart, failover). That must not crash the process:
  // the pool discards it and opens a new one on the next query.
  pool.on('error', () => undefined);
  return pool;
};

export const createDb = (pool: Pool): Db => drizzle(pool, { schema });
