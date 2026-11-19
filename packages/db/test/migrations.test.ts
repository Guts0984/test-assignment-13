import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it } from 'vitest';
import { LOT_TRANSITIONS, LOT_STATUSES } from '@auction/shared';
import * as schema from '../src/schema/index.js';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../src/migrate.js';
import { createEmptyDatabase, type TestDatabase } from '../src/testing.js';
import { newTestDb, type TestDb } from './helpers.js';

const toClose: TestDatabase[] = [];
afterAll(async () => {
  await Promise.all(toClose.map((d) => d.drop()));
});

const emptyDb = async () => {
  const d = await createEmptyDatabase();
  toClose.push(d);
  return d;
};

describe('migrator', () => {
  it('applies everything once, and a second run changes nothing', async () => {
    const d = await emptyDb();
    const pool = new pg.Pool({ connectionString: d.url });
    try {
      const first = await migrate(pool);
      expect(first.applied.length).toBeGreaterThan(0);
      expect(first.skipped).toEqual([]);
      const second = await migrate(pool);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(first.applied);
    } finally {
      await pool.end();
    }
  });

  it('six processes migrating the same empty database at once: no error, each file applied once', async () => {
    const d = await emptyDb();
    const pools = Array.from({ length: 6 }, () => new pg.Pool({ connectionString: d.url, max: 2 }));
    try {
      const results = await Promise.all(pools.map((p) => migrate(p)));
      const applied = results.flatMap((r) => r.applied);
      const files = (await loadMigrations()).map((m) => m.name);
      expect(applied.sort()).toEqual(files.sort());
      const { rows } = await pools[0]!.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM schema_migrations',
      );
      expect(rows[0]?.n).toBe(files.length);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('refuses to run when an already-applied migration was edited', async () => {
    const d = await emptyDb();
    const pool = new pg.Pool({ connectionString: d.url });
    try {
      const files = await loadMigrations();
      await migrate(pool, files);
      const tampered = files.map((f, i) =>
        i === 0 ? { ...f, sql: `${f.sql}\n-- sneaky`, checksum: 'different' } : f,
      );
      await expect(migrate(pool, tampered)).rejects.toThrow(/changed after it was applied/);
    } finally {
      await pool.end();
    }
  });

  it('a failing migration rolls back completely and leaves no half-applied state', async () => {
    const d = await emptyDb();
    const pool = new pg.Pool({ connectionString: d.url });
    try {
      const bad = [
        { name: '0001_ok.sql', sql: 'CREATE TABLE a (id int);', checksum: 'a' },
        { name: '0002_bad.sql', sql: 'CREATE TABLE b (id int); SELECT 1/0;', checksum: 'b' },
      ];
      await expect(migrate(pool, bad)).rejects.toThrow(/0002_bad.sql failed/);
      const { rows } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
      );
      expect(rows.map((r) => r.table_name)).toEqual(['a', 'schema_migrations']);
      const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
      expect(applied.rows.map((r) => r.name)).toEqual(['0001_ok.sql']);
      // The advisory lock was released: a new run is not blocked.
      await expect(migrate(pool, bad.slice(0, 1))).resolves.toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  it('migration files are numbered without gaps or duplicates', async () => {
    const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();
    names.forEach((n, i) => {
      expect(n.startsWith(String(i + 1).padStart(4, '0'))).toBe(true);
    });
  });
});

describe('schema ↔ code agreement', () => {
  let t: TestDb;
  const ready = newTestDb(2).then((x) => (t = x));
  afterAll(async () => {
    await (await ready).close();
  });

  it('every Drizzle table and column exists in the database with matching nullability', async () => {
    await ready;
    for (const [exportName, table] of Object.entries(schema)) {
      if (typeof table !== 'object' || !('_' in table)) continue;
      let config;
      try {
        config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
      } catch {
        continue; // not a table (e.g. the pgSchema object)
      }
      const { rows } = await t.pool.query<{
        column_name: string;
        is_nullable: string;
        data_type: string;
      }>(
        `SELECT column_name, is_nullable, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2`,
        [config.schema ?? 'public', config.name],
      );
      const live = new Map(rows.map((r) => [r.column_name, r]));
      expect(
        live.size,
        `table ${config.name} (${exportName}) is missing in the database`,
      ).toBeGreaterThan(0);
      // Same columns in both directions.
      expect(config.columns.map((c) => c.name).sort(), `columns of ${config.name}`).toEqual(
        [...live.keys()].sort(),
      );
      for (const col of config.columns) {
        expect(
          live.get(col.name)?.is_nullable === 'NO',
          `${config.name}.${col.name} NOT NULL`,
        ).toBe(col.notNull);
      }
    }
  });

  it('SQL lot_transition_allowed() agrees exactly with LOT_TRANSITIONS in @auction/shared', async () => {
    await ready;
    const allowed = new Set([
      ...LOT_TRANSITIONS.map((tr) => `${tr.from}>${tr.to}`),
      ...LOT_STATUSES.map((s) => `${s}>${s}`),
    ]);
    for (const from of LOT_STATUSES) {
      for (const to of LOT_STATUSES) {
        const { rows } = await t.pool.query<{ ok: boolean }>(
          'SELECT lot_transition_allowed($1, $2) AS ok',
          [from, to],
        );
        expect(rows[0]!.ok, `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });

  it('the status CHECK lists exactly the statuses in @auction/shared', async () => {
    await ready;
    const sql = await readFile(path.join(MIGRATIONS_DIR, '0001_tables.sql'), 'utf8');
    const block = /lots_status_valid CHECK \(status IN \(([^)]*)\)/s.exec(sql)?.[1] ?? '';
    const found = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(found.sort()).toEqual([...LOT_STATUSES].sort());
  });
});
