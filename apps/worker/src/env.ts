import {
  envPositiveInt,
  parseEnv,
  secretSchema,
  timingsEnvShape,
  timingsFromEnv,
} from '@auction/shared';
import { z } from 'zod';
import type { WorkerConfig } from './config.js';

const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, { error: 'must be a postgres:// URL' }),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, { error: 'must be a redis:// URL' }),
  MEILI_URL: z.url(),
  MEILI_MASTER_KEY: secretSchema,
  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: secretSchema,
  S3_PRIVATE_BUCKET: z.string().min(3).default('photos-private'),
  S3_PUBLIC_BUCKET: z.string().min(3).default('photos-public'),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: envPositiveInt(1025),
  MAIL_FROM: z.string().min(3).default('no-reply@auction.local'),
  PAYMENT_WEBHOOK_SECRET: secretSchema,
  PAYMENT_PROVIDER_API_KEY: secretSchema,
  /** Base URL of the API copy that serves /provider/* (status API) from inside the compose network. */
  PROVIDER_BASE_URL: z.url().default('http://nginx:8080'),
  SWEEPER_INTERVAL_MS: envPositiveInt(1000),
  SEARCH_SYNC_INTERVAL_MS: envPositiveInt(500),
  WEBHOOK_INTERVAL_MS: envPositiveInt(1000),
  TOPUP_RECONCILE_INTERVAL_MS: envPositiveInt(60_000),
  TOPUP_RECONCILE_MIN_AGE_MS: envPositiveInt(60_000),
  WORKER_CONCURRENCY: envPositiveInt(5),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ...timingsEnvShape,
});

export const loadWorkerConfig = (
  source: Record<string, string | undefined> = process.env,
): WorkerConfig => {
  const e = parseEnv(schema, source);
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    meili: { url: e.MEILI_URL, key: e.MEILI_MASTER_KEY },
    s3: {
      endpoint: e.S3_ENDPOINT,
      accessKey: e.S3_ACCESS_KEY,
      secretKey: e.S3_SECRET_KEY,
      privateBucket: e.S3_PRIVATE_BUCKET,
      publicBucket: e.S3_PUBLIC_BUCKET,
    },
    smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, from: e.MAIL_FROM },
    webhookSecret: e.PAYMENT_WEBHOOK_SECRET,
    provider: { baseUrl: e.PROVIDER_BASE_URL, apiKey: e.PAYMENT_PROVIDER_API_KEY },
    timings: timingsFromEnv(e),
    intervals: {
      sweeperMs: e.SWEEPER_INTERVAL_MS,
      searchSyncMs: e.SEARCH_SYNC_INTERVAL_MS,
      webhookMs: e.WEBHOOK_INTERVAL_MS,
      topupReconcileMs: e.TOPUP_RECONCILE_INTERVAL_MS,
      topupReconcileMinAgeMs: e.TOPUP_RECONCILE_MIN_AGE_MS,
    },
    concurrency: e.WORKER_CONCURRENCY,
    logLevel: e.LOG_LEVEL,
  };
};
