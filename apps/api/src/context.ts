import { createDb, createPool, type Pool } from '@auction/db';
import { systemClock, type Clock, type Deps } from '@auction/domain';
import {
  createMeili,
  createRealtimeEmitter,
  createRedis,
  createS3,
  type RealtimeEmitter,
  type Redis,
} from '@auction/platform';
import type { S3Client } from '@aws-sdk/client-s3';
import type { Meilisearch } from 'meilisearch';
import type { ApiConfig } from './config.js';
import { createRateLimiter, type RateLimiter } from './ratelimit.js';

export const CTX = Symbol('CTX');

export type Ctx = {
  readonly config: ApiConfig;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly s3: S3Client;
  readonly meili: Meilisearch;
  readonly emitter: RealtimeEmitter;
  readonly limiter: RateLimiter;
  readonly clock: Clock & { offsetMs: () => number; setOffset: (ms: number) => void };
  readonly deps: Deps;
  readonly close: () => Promise<void>;
};

/** Builds every shared dependency once. Functions over data; Nest only hands this object to controllers. */
export const createCtx = (config: ApiConfig): Ctx => {
  const pool = createPool(config.databaseUrl, { max: 20, applicationName: config.nodeId });
  createDb(pool); // registers the bigint parser before any query
  const redis = createRedis(config.redisUrl, config.nodeId);
  let offset = 0;
  const clock = {
    now: () => new Date(config.testClock ? Date.now() + offset : systemClock.now().getTime()),
    offsetMs: () => offset,
    setOffset: (ms: number) => {
      offset = ms;
    },
  };
  return {
    config,
    pool,
    redis,
    s3: createS3(config.s3),
    meili: createMeili(config.meili.url, config.meili.key),
    emitter: createRealtimeEmitter(redis),
    limiter: createRateLimiter(redis),
    clock,
    deps: { pool, clock, timings: config.timings },
    close: async () => {
      redis.disconnect();
      await pool.end();
    },
  };
};
