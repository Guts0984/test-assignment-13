import type pg from 'pg';
import { hashPassword } from '../password.js';
import { generateSeed, type SeedConfig, type SeedSummary } from './generate.js';
import { bulkInsert } from './insert.js';

export {
  generateSeed,
  SEED_LOGINS,
  type SeedConfig,
  type SeedData,
  type SeedSummary,
} from './generate.js';

const SEED_LOCK_ID = 7_261_300_015;
const SEED_MARKER = 'seed.v1';

export type SeedResult =
  { seeded: true; summary: SeedSummary; ms: number } | { seeded: false; reason: 'already_seeded' };

export type SeedOptions = {
  users: number;
  lots: number;
  bids: number;
  rng: number;
  password: string;
  /** Epoch ms; defaults to the current time. Tests pass a fixed value. */
  now?: number;
  /** Pre-computed hash to skip scrypt in tests. */
  passwordHash?: string;
};

/**
 * Loads the demo dataset in ONE transaction: it is all-or-nothing, and a second call (or a second
 * container racing the first) finds the marker row and does nothing.
 */
export const seedDatabase = async (pool: pg.Pool, options: SeedOptions): Promise<SeedResult> => {
  const started = Date.now();
  const passwordHash = options.passwordHash ?? (await hashPassword(options.password));
  const config: SeedConfig = {
    users: options.users,
    lots: options.lots,
    bids: options.bids,
    rng: options.rng,
    now: options.now ?? Date.now(),
    passwordHash,
  };

  // Cheap pre-check outside the transaction, so a second start does not even generate the data.
  const pre = await pool.query('SELECT 1 FROM settings WHERE key = $1', [SEED_MARKER]);
  if (pre.rowCount) return { seeded: false, reason: 'already_seeded' };

  const data = generateSeed(config);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Generating can take long; do not let the pool's safety timeouts kill a legitimate bulk load.
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query('SET LOCAL idle_in_transaction_session_timeout = 0');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SEED_LOCK_ID]);
    const marker = await client.query('SELECT 1 FROM settings WHERE key = $1', [SEED_MARKER]);
    if (marker.rowCount) {
      await client.query('ROLLBACK');
      return { seeded: false, reason: 'already_seeded' };
    }

    await bulkInsert(client, 'categories', data.categories);
    await bulkInsert(client, 'cities', data.cities);
    await bulkInsert(client, 'users', data.users);
    await bulkInsert(client, 'accounts', data.accounts);
    await bulkInsert(client, 'provider.payments', data.providerPayments);
    await bulkInsert(client, 'topups', data.topups);
    await bulkInsert(client, 'ledger_transactions', data.topupLedger.transactions);
    await bulkInsert(client, 'ledger_entries', data.topupLedger.entries);
    await bulkInsert(client, 'lots', data.lots);
    await bulkInsert(client, 'accounts', data.escrowAccounts);
    await bulkInsert(client, 'bids', data.bids, 8000);
    await bulkInsert(client, 'deposits', data.deposits);
    await bulkInsert(client, 'second_chance_offers', data.offers);
    await bulkInsert(client, 'payment_defaults', data.defaults);
    await bulkInsert(client, 'lot_photos', data.photos);
    await bulkInsert(client, 'favorites', data.favorites);
    await bulkInsert(client, 'lot_audit', data.audit);
    await bulkInsert(client, 'ledger_transactions', data.saleLedger.transactions);
    await bulkInsert(client, 'ledger_entries', data.saleLedger.entries);
    await client.query(`INSERT INTO settings (key, value) VALUES ($1, $2)`, [
      SEED_MARKER,
      JSON.stringify({ at: new Date(config.now).toISOString(), summary: data.summary }),
    ]);
    await client.query('COMMIT');
    // Fresh statistics and a filled visibility map (index-only scans need it).
    await client.query('VACUUM (ANALYZE)');
    return { seeded: true, summary: data.summary, ms: Date.now() - started };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
