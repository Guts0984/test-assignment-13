import {
  envBoolean,
  envPositiveInt,
  parseEnv,
  secretSchema,
  timingsEnvShape,
  timingsFromEnv,
  type Timings,
} from '@auction/shared';
import type { S3Config } from '@auction/platform';
import { z } from 'zod';

export type ApiConfig = {
  readonly port: number;
  readonly nodeId: string;
  readonly publicUrl: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly meili: { url: string; key: string };
  readonly s3: S3Config;
  /** Browser-facing base URL for presigned uploads and for public photos. */
  readonly publicUploadUrl: string;
  readonly publicPhotoUrl: string;
  readonly webhookSecret: string;
  readonly providerApiKey: string;
  readonly chaos: boolean;
  readonly timings: Timings;
  readonly trustProxy: string;
  readonly cookieSecure: boolean;
  readonly testClock: boolean;
  readonly rate: {
    global: number;
    login: number;
    loginAccount: number;
    register: number;
    bid: number;
    topup: number;
    presign: number;
    search: number;
  };
};

const schema = z.object({
  PORT: envPositiveInt(3000),
  NODE_ID: z.string().default('api'),
  PUBLIC_URL: z.url().default('http://localhost:8080'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),
  MEILI_URL: z.url(),
  MEILI_MASTER_KEY: secretSchema,
  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(3),
  S3_SECRET_KEY: secretSchema,
  S3_PRIVATE_BUCKET: z.string().default('photos-private'),
  S3_PUBLIC_BUCKET: z.string().default('photos-public'),
  PUBLIC_UPLOAD_URL: z.url().optional(),
  PUBLIC_PHOTO_URL: z.url().optional(),
  PAYMENT_WEBHOOK_SECRET: secretSchema,
  PAYMENT_PROVIDER_API_KEY: secretSchema,
  PAYMENT_STUB_CHAOS: envBoolean,
  TRUSTED_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  COOKIE_SECURE: envBoolean,
  TEST_CLOCK: envBoolean,
  RATE_GLOBAL_PER_MIN: envPositiveInt(600),
  RATE_LOGIN_PER_MIN: envPositiveInt(20),
  RATE_LOGIN_ACCOUNT_PER_15MIN: envPositiveInt(8),
  RATE_REGISTER_PER_HOUR: envPositiveInt(20),
  RATE_BID_PER_10S: envPositiveInt(40),
  RATE_TOPUP_PER_MIN: envPositiveInt(10),
  RATE_PRESIGN_PER_MIN: envPositiveInt(40),
  RATE_SEARCH_PER_MIN: envPositiveInt(240),
  ...timingsEnvShape,
});

export const loadApiConfig = (
  source: Record<string, string | undefined> = process.env,
): ApiConfig => {
  const e = parseEnv(schema, source);
  return {
    port: e.PORT,
    nodeId: e.NODE_ID,
    publicUrl: e.PUBLIC_URL,
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
    publicUploadUrl: e.PUBLIC_UPLOAD_URL ?? `${e.PUBLIC_URL}/upload/${e.S3_PRIVATE_BUCKET}`,
    publicPhotoUrl: e.PUBLIC_PHOTO_URL ?? `${e.PUBLIC_URL}/photos`,
    webhookSecret: e.PAYMENT_WEBHOOK_SECRET,
    providerApiKey: e.PAYMENT_PROVIDER_API_KEY,
    chaos: e.PAYMENT_STUB_CHAOS,
    timings: timingsFromEnv(e),
    trustProxy: e.TRUSTED_PROXY,
    cookieSecure: e.COOKIE_SECURE,
    testClock: e.TEST_CLOCK,
    rate: {
      global: e.RATE_GLOBAL_PER_MIN,
      login: e.RATE_LOGIN_PER_MIN,
      loginAccount: e.RATE_LOGIN_ACCOUNT_PER_15MIN,
      register: e.RATE_REGISTER_PER_HOUR,
      bid: e.RATE_BID_PER_10S,
      topup: e.RATE_TOPUP_PER_MIN,
      presign: e.RATE_PRESIGN_PER_MIN,
      search: e.RATE_SEARCH_PER_MIN,
    },
  };
};
