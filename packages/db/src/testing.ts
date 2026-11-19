import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from './migrate.js';

/**
 * Test helpers (exported as `@auction/db/testing`). Strategy: one migrated *template* database
 * per test run; every test file clones it with `CREATE DATABASE … TEMPLATE`, which takes a few
 * tens of milliseconds. Files get isolated state and can run in parallel.
 */

export const DEFAULT_ADMIN_URL = 'postgres://auction:auction@localhost:55432/postgres';

export const adminUrl = (): string => process.env['TEST_DATABASE_URL'] ?? DEFAULT_ADMIN_URL;

const withDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const randomName = (prefix: string): string => `${prefix}_${randomBytes(5).toString('hex')}`;

const admin = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

export type TestDatabase = {
  readonly name: string;
  readonly url: string;
  readonly drop: () => Promise<void>;
};

const dropDatabase = (name: string) =>
  admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined);

/** Creates an empty database and applies every migration. */
export const createMigratedDatabase = async (prefix = 'tpl'): Promise<TestDatabase> => {
  const name = randomName(prefix);
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = withDatabase(adminUrl(), name);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  return { name, url, drop: () => dropDatabase(name) };
};

/** Clones an existing database (the template must have no open connections). */
export const cloneDatabase = async (
  template: TestDatabase,
  prefix = 't',
): Promise<TestDatabase> => {
  const name = randomName(prefix);
  await admin((c) => c.query(`CREATE DATABASE "${name}" TEMPLATE "${template.name}"`));
  return { name, url: withDatabase(adminUrl(), name), drop: () => dropDatabase(name) };
};

/** An empty, unmigrated database, for tests of the migrator itself. */
export const createEmptyDatabase = async (prefix = 'empty'): Promise<TestDatabase> => {
  const name = randomName(prefix);
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  return { name, url: withDatabase(adminUrl(), name), drop: () => dropDatabase(name) };
};
