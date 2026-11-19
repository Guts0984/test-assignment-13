import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAppGrants, ensureAppRole } from '../src/roles.js';
import {
  errorOf,
  insertActiveLot,
  insertUser,
  newTestDb,
  post,
  sqlState,
  systemAccounts,
  walletAccounts,
  type TestDb,
} from './helpers.js';

let t: TestDb;
let app: pg.Pool;
const APP_USER = 'auction_app_test';
const APP_PASSWORD = 'p@ss\'w"ord;--';

beforeAll(async () => {
  t = await newTestDb();
  await ensureAppRole(t.pool, { user: APP_USER, password: APP_PASSWORD });
  await applyAppGrants(t.pool, APP_USER);
  const u = new URL(t.url);
  u.username = APP_USER;
  u.password = APP_PASSWORD;
  app = new pg.Pool({ connectionString: u.toString(), max: 4 });
});
afterAll(async () => {
  await app.end();
  await t.close();
  // Roles are cluster-wide; leave nothing behind for the next run.
  const admin = new pg.Client({
    connectionString:
      process.env['TEST_DATABASE_URL'] ?? 'postgres://auction:auction@localhost:55432/postgres',
  });
  await admin.connect();
  await admin.query(`DROP OWNED BY ${APP_USER}`).catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${APP_USER}`).catch(() => undefined);
  await admin.end();
});

const FORBIDDEN = '42501'; // insufficient_privilege

describe('the application role cannot defeat the database guarantees', () => {
  it('is not a superuser, cannot create roles or databases, cannot bypass RLS', async () => {
    const { rows } = await app.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
      rolbypassrls: false,
    });
  });

  it('cannot switch triggers off with session_replication_role', async () => {
    const err = await errorOf(() => app.query(`SET session_replication_role = replica`));
    expect(sqlState(err)).toBe(FORBIDDEN);
  });

  it.each([
    ['DISABLE TRIGGER ALL', `ALTER TABLE ledger_entries DISABLE TRIGGER ALL`],
    ['DROP a guard trigger', `DROP TRIGGER ledger_entries_balanced ON ledger_entries`],
    ['DROP a CHECK', `ALTER TABLE accounts DROP CONSTRAINT accounts_no_overdraft`],
    ['DROP a table', `DROP TABLE ledger_entries`],
    [
      'replace a guard function',
      `CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
    ],
    ['TRUNCATE the ledger', `TRUNCATE ledger_entries`],
    ['TRUNCATE users', `TRUNCATE users CASCADE`],
    ['CREATE a table', `CREATE TABLE evil (id int)`],
    ['edit migration history', `DELETE FROM schema_migrations`],
    ['read migration history', `SELECT * FROM schema_migrations`],
    ['CREATE ROLE', `CREATE ROLE evil SUPERUSER`],
  ])('is denied: %s', async (_name, statement) => {
    const err = await errorOf(() => app.query(statement));
    expect(sqlState(err), `statement: ${statement}`).toBe(FORBIDDEN);
  });

  it('cannot DELETE from tables that must stay intact', async () => {
    const user = await insertUser(t.pool);
    const seller = await insertUser(t.pool);
    const lot = await insertActiveLot(t.pool, seller);
    for (const table of [
      'users',
      'lots',
      'bids',
      'ledger_entries',
      'ledger_transactions',
      'accounts',
      'lot_events',
      'lot_audit',
      'deposits',
      'topups',
    ]) {
      const err = await errorOf(() => app.query(`DELETE FROM ${table}`));
      expect(sqlState(err), table).toBe(FORBIDDEN);
    }
    expect(user && lot).toBeTruthy();
  });

  it('can do its normal work: read, insert, update, and delete sessions', async () => {
    const user = await insertUser(t.pool);
    await app.query(
      `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
      [user, randomUUID()],
    );
    const upd = await app.query(`UPDATE users SET failed_logins = 1 WHERE id = $1`, [user]);
    expect(upd.rowCount).toBe(1);
    const del = await app.query(`DELETE FROM sessions WHERE user_id = $1`, [user]);
    expect(del.rowCount).toBe(1);
  });

  it('triggers still bind the app role: it cannot unbalance the ledger or overdraw', async () => {
    const user = await insertUser(t.pool);
    const w = await walletAccounts(t.pool, user);
    const sys = await systemAccounts(t.pool);
    // Unbalanced booking attempted through the app connection.
    const err1 = await errorOf(() =>
      post(app, `app-evil:${randomUUID()}`, [{ account: w.available, amount: 10_000_000 }]),
    );
    expect(sqlState(err1)).toBe('23514');
    // Direct balance edit.
    const err2 = await errorOf(() =>
      app.query('UPDATE accounts SET balance = 1000000 WHERE id = $1', [w.available]),
    );
    expect(sqlState(err2)).toBe('23000');
    // Overdraft.
    const err3 = await errorOf(() =>
      post(app, `app-over:${randomUUID()}`, [
        { account: w.available, amount: -1 },
        { account: sys.external, amount: 1 },
      ]),
    );
    expect(sqlState(err3)).toBe('23514');
  });

  it('trying to grant itself more privileges only warns and gains nothing', async () => {
    await app.query(`GRANT ALL ON ledger_entries TO ${APP_USER}`).catch(() => undefined);
    const err = await errorOf(() => app.query('DELETE FROM ledger_entries'));
    expect(sqlState(err)).toBe(FORBIDDEN);
    const err2 = await errorOf(() => app.query('TRUNCATE ledger_entries'));
    expect(sqlState(err2)).toBe(FORBIDDEN);
  });

  it('grants are idempotent and survive a second run', async () => {
    await applyAppGrants(t.pool, APP_USER);
    await applyAppGrants(t.pool, APP_USER);
    await expect(app.query('SELECT count(*) FROM lots')).resolves.toBeTruthy();
  });

  it('refuses unsafe role names (no SQL injection through the role identifier)', async () => {
    await expect(
      ensureAppRole(t.pool, { user: 'x; DROP TABLE users', password: 'whatever12' }),
    ).rejects.toThrow();
    await expect(applyAppGrants(t.pool, 'a b')).rejects.toThrow();
    await expect(applyAppGrants(t.pool, 'Robert"; --')).rejects.toThrow();
  });

  it('a hostile password is stored literally and works for login', async () => {
    // beforeAll already created the role with quotes, semicolons and dashes in the password.
    const c = await app.connect();
    c.release();
    const wrong = new pg.Pool({
      connectionString: (() => {
        const u = new URL(t.url);
        u.username = APP_USER;
        u.password = 'wrong-password';
        return u.toString();
      })(),
    });
    const err = await errorOf(() => wrong.query('SELECT 1'));
    expect(sqlState(err)).toBe('28P01');
    await wrong.end();
  });
});
