import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeLot, makeUser, newTestDb, waitFor, type TestDb } from '@auction/test-kit';
import { createS3, ensureBuckets, headObject, photoKeys, putObject } from '@auction/platform';
import { startWorker, type WorkerHandle } from '../src/runtime.js';
import { cleanupStaleUploads, UPLOAD_MAX_AGE_MS } from '../src/upload-cleanup.js';
import { testConfig } from './support.js';

let t: TestDb;
beforeAll(async () => {
  t = await newTestDb(60);
  await t.pool.query(
    `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
  );
});
afterAll(async () => {
  await t.close();
});

const setup = async () => {
  const config = testConfig(t);
  const s3 = createS3(config.s3);
  await ensureBuckets(s3, config.s3);
  const seller = await makeUser(t.pool);
  const lotId = await makeLot(t.pool, { sellerId: seller, startPrice: 100, now: new Date() });
  const bucket = config.s3.privateBucket;
  let pos = 0;
  const photo = async (status: 'pending' | 'ready' | 'rejected' | 'none') => {
    const id = randomUUID();
    const key = photoKeys(lotId, id).upload;
    if (status !== 'none') {
      await t.pool.query(
        `INSERT INTO lot_photos (id, lot_id, position, key, preview_key, content_type, size_bytes, status)
         VALUES ($1, $2, $6, $3, $4, 'image/jpeg', 3, $5)`,
        [id, lotId, key, status === 'ready' ? 'p' : null, status, pos++],
      );
    }
    await putObject(s3, bucket, key, Buffer.from('raw'), 'image/jpeg');
    return key;
  };
  const exists = async (key: string) => (await headObject(s3, bucket, key)) !== null;
  return { config, s3, bucket, photo, exists };
};

const later = () => new Date(Date.now() + UPLOAD_MAX_AGE_MS + 60_000);

describe('stale raw upload cleanup', () => {
  it('removes old non-pending or unknown uploads; keeps pending and recent ones', async () => {
    const e = await setup();
    const ready = await e.photo('ready');
    const rejected = await e.photo('rejected');
    const none = await e.photo('none');
    const pending = await e.photo('pending');
    const junk = `uploads/${randomUUID()}/not-a-uuid`;
    await putObject(e.s3, e.bucket, junk, Buffer.from('x'), 'image/jpeg');

    // Recent: nothing at all is removed.
    expect(await cleanupStaleUploads(e.s3, t.pool, e.bucket, new Date())).toBe(0);
    for (const k of [ready, rejected, none, pending, junk]) expect(await e.exists(k)).toBe(true);

    expect(await cleanupStaleUploads(e.s3, t.pool, e.bucket, later())).toBe(4);
    for (const k of [ready, rejected, none, junk]) expect(await e.exists(k)).toBe(false);
    expect(await e.exists(pending)).toBe(true);

    // Idempotent.
    expect(await cleanupStaleUploads(e.s3, t.pool, e.bucket, later())).toBe(0);
    expect(await e.exists(pending)).toBe(true);
  });

  it('does not touch anything outside uploads/', async () => {
    const e = await setup();
    await putObject(e.s3, e.bucket, 'lots/a/b/full.jpg', Buffer.from('x'), 'image/jpeg');
    await cleanupStaleUploads(e.s3, t.pool, e.bucket, later());
    expect(await e.exists('lots/a/b/full.jpg')).toBe(true);
  });

  it('is safe with three concurrent workers ticking on a clock past the age limit', async () => {
    const e = await setup();
    const stale = await Promise.all([1, 2, 3, 4, 5].map(() => e.photo('ready')));
    const pending = await e.photo('pending');
    const clock = { now: later };
    const workers: WorkerHandle[] = [];
    try {
      for (let i = 0; i < 3; i++)
        workers.push(
          await startWorker({
            config: e.config,
            name: `cleanup-${i}`,
            clock,
            disable: {
              scheduler: true,
              searchSync: true,
              webhooks: true,
              reconcile: true,
              consumers: true,
            },
          }),
        );
      await Promise.all(workers.map((w) => w.tick()));
      await waitFor(async () => !(await e.exists(stale[0]!)), { timeoutMs: 5000, what: 'cleanup' });
      for (const k of stale) expect(await e.exists(k)).toBe(false);
      expect(await e.exists(pending)).toBe(true);
    } finally {
      await Promise.all(workers.map((w) => w.stop()));
    }
  });
});
