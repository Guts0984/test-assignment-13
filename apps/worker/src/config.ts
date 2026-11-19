import type { Timings } from '@auction/shared';
import type { S3Config } from '@auction/platform';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type WorkerConfig = {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly meili: { url: string; key: string };
  readonly s3: S3Config;
  readonly smtp: { host: string; port: number; from: string };
  readonly webhookSecret: string;
  readonly provider: { baseUrl: string; apiKey: string };
  readonly timings: Timings;
  readonly intervals: {
    sweeperMs: number;
    searchSyncMs: number;
    webhookMs: number;
    topupReconcileMs: number;
    topupReconcileMinAgeMs: number;
  };
  readonly concurrency: number;
  readonly logLevel: LogLevel;
  /** Meilisearch index to use; defaults to the production one. Tests give each file its own. */
  readonly indexUid?: string;
};
