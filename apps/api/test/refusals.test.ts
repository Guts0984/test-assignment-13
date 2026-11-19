/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- test code inspects arbitrary JSON bodies dynamically */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTestDb, type TestDb } from '@auction/test-kit';
import { startApp, type RunningApp } from '../src/app.js';
import { loadApiConfig } from '../src/config.js';
import { refuse } from '../src/common/helpers.js';
import { UAH, makeLot, register, testApiConfig } from './support.js';

let t: TestDb;
let app: RunningApp;
beforeAll(async () => {
  t = await newTestDb(20);
  app = await startApp(testApiConfig(t), 0);
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const thrown = (fn: () => never): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('did not throw');
};

describe('refusal mapping', () => {
  it('INSUFFICIENT_FUNDS never carries a misleading minNextBid; BID_TOO_LOW still does', () => {
    const funds = thrown(() => refuse('INSUFFICIENT_FUNDS', 10_000));
    expect(JSON.stringify(funds.getResponse?.() ?? funds)).not.toContain('minNextBid');
    expect(funds.meta?.minNextBid).toBeUndefined();
    const low = thrown(() => refuse('BID_TOO_LOW', 16_000));
    expect(low.meta?.minNextBid ?? JSON.stringify(low.getResponse?.() ?? low)).toBeTruthy();
    expect(JSON.stringify(low)).toContain('16000');
  });

  it('over HTTP: a bidder without money gets INSUFFICIENT_FUNDS and no minNextBid', async () => {
    const seller = await register(app);
    const poor = await register(app, 'poorR');
    const lot = await makeLot(t.pool, { sellerId: seller.id });
    const r = await poor.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(100) },
      idem: randomUUID(),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(r.body.error.meta?.minNextBid).toBeUndefined();
  });
});

describe('provider base URL lives in ApiConfig', () => {
  const env = {
    DATABASE_URL: 'postgres://u:p@h/db',
    REDIS_URL: 'redis://h:6379',
    MEILI_URL: 'http://m:7700',
    MEILI_MASTER_KEY: 'meili-master-key-0123456789',
    S3_ENDPOINT: 'http://s3:9000',
    S3_ACCESS_KEY: 'access',
    S3_SECRET_KEY: 'secret-key-0123456789abcdef',
    PAYMENT_WEBHOOK_SECRET: 'webhook-secret-0123456789',
    PAYMENT_PROVIDER_API_KEY: 'provider-key-0123456789',
    PAYMENT_STUB_CHAOS: 'false',
    COOKIE_SECURE: 'false',
    TEST_CLOCK: 'false',
  };
  it('defaults to http://nginx:8080, honours PROVIDER_BASE_URL, strips trailing slashes, rejects junk', () => {
    expect(loadApiConfig(env).providerBaseUrl).toBe('http://nginx:8080');
    expect(loadApiConfig({ ...env, PROVIDER_BASE_URL: 'http://edge:9/' }).providerBaseUrl).toBe(
      'http://edge:9',
    );
    expect(() => loadApiConfig({ ...env, PROVIDER_BASE_URL: 'not a url' })).toThrow();
  });
});
