import { createPool } from '@auction/db';
import {
  createMeili,
  createS3,
  ensureBuckets,
  ensureIndex,
  headObject,
  reindexAll,
  uploadSeedPlaceholders,
} from '@auction/platform';
import type { WorkerConfig } from './config.js';
import type { Logger } from './log.js';

/**
 * One-off preparation of the services around the database (run by the `infra-init` container and
 * safe to run again): buckets, the search index and its settings, the seed's placeholder pictures,
 * and a first full index build if the index is empty while lots exist.
 */
export const initInfrastructure = async (config: WorkerConfig, log: Logger): Promise<void> => {
  const s3 = createS3(config.s3);
  await ensureBuckets(s3, config.s3);
  log.info('buckets ready', { private: config.s3.privateBucket, public: config.s3.publicBucket });

  if ((await headObject(s3, config.s3.privateBucket, 'seed/p0/full.jpg')) === null) {
    const n = await uploadSeedPlaceholders(s3, config.s3);
    log.info('seed placeholder photos uploaded', { count: n });
  }

  const meili = createMeili(config.meili.url, config.meili.key);
  await ensureIndex(meili, config.indexUid);
  const stats = await meili.index(config.indexUid ?? 'lots').getStats();
  const pool = createPool(config.databaseUrl, { max: 2, applicationName: 'infra-init' });
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM lots WHERE status = 'active'`,
    );
    if (stats.numberOfDocuments === 0 && (rows[0]?.n ?? 0) > 0) {
      log.info('search index is empty: building it from Postgres', { activeLots: rows[0]?.n });
      const r = await reindexAll(pool, meili, { indexUid: config.indexUid });
      log.info('search index built', { ...r });
    }
  } finally {
    await pool.end();
  }
};

export const reindexCommand = async (config: WorkerConfig, log: Logger): Promise<void> => {
  const meili = createMeili(config.meili.url, config.meili.key);
  const pool = createPool(config.databaseUrl, { max: 2, applicationName: 'reindex' });
  try {
    const r = await reindexAll(pool, meili, { indexUid: config.indexUid });
    log.info('reindex finished', { ...r });
  } finally {
    await pool.end();
  }
};
