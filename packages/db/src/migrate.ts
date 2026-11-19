import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type pg from 'pg';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/** Arbitrary constant: all migrators queue on the same advisory lock. */
const MIGRATION_LOCK_ID = 7_261_300_013;

export type MigrationFile = { name: string; sql: string; checksum: string };

export const loadMigrations = async (dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> => {
  const names = (await readdir(dir)).filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(path.join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
};

export type MigrateResult = { applied: string[]; skipped: string[] };

/**
 * Applies pending migrations, each in its own transaction. Safe to run from many processes at
 * once (advisory lock) and safe to run again (applied files are skipped). Editing a migration
 * that was already applied is an error: add a new file instead.
 */
export const migrate = async (
  pool: pg.Pool,
  migrations?: readonly MigrationFile[],
): Promise<MigrateResult> => {
  const files = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    const result: MigrateResult = { applied: [], skipped: [] };

    for (const file of files) {
      const existing = done.get(file.name);
      if (existing !== undefined) {
        if (existing !== file.checksum) {
          throw new Error(
            `migration ${file.name} was changed after it was applied; write a new migration instead`,
          );
        }
        result.skipped.push(file.name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file.name} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      result.applied.push(file.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
};
