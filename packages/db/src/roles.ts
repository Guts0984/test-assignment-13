import type pg from 'pg';

/**
 * The API and worker connect as a plain, non-superuser role. A superuser can switch every
 * trigger off (`SET session_replication_role = replica`) and a table owner can drop them, so
 * the guarantees in the migrations only mean something if the application is neither.
 *
 *   - owner/admin (POSTGRES_USER)  → runs migrations and seed (the `db-init` container)
 *   - APP_DB_USER                  → SELECT/INSERT/UPDATE (+ DELETE on a few tables); no TRUNCATE,
 *                                    no DDL, cannot touch triggers
 */

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Tables the application is allowed to DELETE from. Everything else is append-only or immutable. */
export const APP_DELETABLE_TABLES = [
  'sessions',
  'idempotency_keys',
  'favorites',
  'lot_photos',
  'notifications',
  'outbox',
] as const;

const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const ensureAppRole = async (
  pool: pg.Pool,
  role: { user: string; password: string },
): Promise<void> => {
  if (!IDENT.test(role.user)) throw new Error('APP_DB_USER must match [a-z_][a-z0-9_]*');
  const client = await pool.connect();
  try {
    // Serialise concurrent init containers.
    await client.query('SELECT pg_advisory_lock(7261300014)');
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role.user]);
    const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
    // CREATE/ALTER ROLE cannot take bind parameters, so the password is escaped as a literal.
    const sql = exists.rowCount
      ? `ALTER ROLE ${role.user} ${attrs} PASSWORD ${quoteLiteral(role.password)}`
      : `CREATE ROLE ${role.user} ${attrs} PASSWORD ${quoteLiteral(role.password)}`;
    await client.query(sql);
    const db = (await client.query<{ current_database: string }>('SELECT current_database()'))
      .rows[0]?.current_database;
    if (!db) throw new Error('cannot determine current database');
    await client.query(`GRANT CONNECT ON DATABASE "${db}" TO ${role.user}`);
    await client.query('SELECT pg_advisory_unlock(7261300014)');
  } finally {
    client.release();
  }
};

/** Idempotent. Run after every migration, because new tables start with no privileges. */
export const applyAppGrants = async (pool: pg.Pool, user: string): Promise<void> => {
  if (!IDENT.test(user)) throw new Error('APP_DB_USER must match [a-z_][a-z0-9_]*');
  const deletable = APP_DELETABLE_TABLES.map((t) => `public.${t}`).join(', ');
  const statements = [
    `GRANT USAGE ON SCHEMA public TO ${user}`,
    `GRANT USAGE ON SCHEMA provider TO ${user}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${user}`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA provider FROM ${user}`,
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${user}`,
    `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA provider TO ${user}`,
    `GRANT DELETE ON ${deletable} TO ${user}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${user}`,
    // The migration bookkeeping table is not the application's business.
    `REVOKE ALL ON public.schema_migrations FROM ${user}`,
  ];
  const client = await pool.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    client.release();
  }
};
