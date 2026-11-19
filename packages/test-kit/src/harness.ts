import { createDb, createPool, type Db, type Pool } from '@auction/db';
import { cloneDatabase } from '@auction/db/testing';
import { inject } from 'vitest';

export type TestDb = {
  readonly pool: Pool;
  readonly db: Db;
  readonly url: string;
  readonly close: () => Promise<void>;
};

/** A private copy of the migrated schema for one test file. Call `close()` in afterAll. */
export const newTestDb = async (poolSize = 20): Promise<TestDb> => {
  const clone = await cloneDatabase({
    name: inject('templateName'),
    url: '',
    drop: () => Promise.resolve(),
  });
  const pool = createPool(clone.url, { max: poolSize, applicationName: 'test' });
  // Dropping the database at teardown kills idle connections; that is expected, not an error.
  pool.on('error', () => undefined);
  return {
    pool,
    db: createDb(pool),
    url: clone.url,
    close: async () => {
      await pool.end();
      await clone.drop();
    },
  };
};
