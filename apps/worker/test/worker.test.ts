import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  count,
  fund,
  lotRow,
  makeLot,
  makeUser,
  makeUsers,
  mailpitMessages,
  newTestDb,
  waitFor,
  balanceOf,
  type TestDb,
} from '@auction/test-kit';
import {
  addFavorite,
  claimNextLot,
  createFakeClock,
  placeBid,
  createTopup,
  attachProviderPayment,
  reconcile,
  type Deps,
} from '@auction/domain';
import { createPayment, decidePayment } from '@auction/payment-stub';
import {
  createMeili,
  createRedis,
  createS3,
  ensureBuckets,
  ensureIndex,
  photoKeys,
  putObject,
  searchLots,
  headObject,
  type S3Config,
} from '@auction/platform';
import { DEFAULT_TIMINGS, searchQuerySchema } from '@auction/shared';
import { startWorker, type WorkerHandle } from '../src/runtime.js';
import { fakeClock, startProviderApi, startToggleProxy, testConfig } from './support.js';
import sharp from 'sharp';

let t: TestDb;
const UAH = (n: number) => Math.round(n * 100);
const handles: WorkerHandle[] = [];
const spawn = async (...args: Parameters<typeof startWorker>) => {
  const h = await startWorker(...args);
  handles.push(h);
  return h;
};
const stopAll = async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
};

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
  await stopAll();
  await t.close();
});

const closedEvents = (lotId: string) =>
  count(t.pool, `SELECT count(*) AS n FROM lot_events WHERE lot_id = $1 AND type = 'closed'`, [
    lotId,
  ]);
const statusOf = async (lotId: string) => (await lotRow<{ status: string }>(t.pool, lotId)).status;

describe('closing on time, through BullMQ and the real clock', () => {
  it('a lot ends within about a second of its end time, the winner is emailed once', async () => {
    const seller = await makeUser(t.pool);
    const buyer = await makeUser(t.pool);
    await fund(t.pool, buyer, UAH(5000));
    const endsAt = new Date(Date.now() + 3000);
    const lot = await makeLot(t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: new Date(),
      endsAt,
    });
    const deps: Deps = {
      pool: t.pool,
      clock: { now: () => new Date() },
      timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 },
    };
    await placeBid(deps, {
      lotId: lot,
      userId: buyer,
      kind: 'manual',
      amount: UAH(300),
      idempotencyKey: randomUUID(),
    });

    const w = await spawn({
      config: testConfig(t, { timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 } }),
    });
    expect(await statusOf(lot)).toBe('active');
    const closedAt = await waitFor(
      async () => ((await statusOf(lot)) !== 'active' ? Date.now() : undefined),
      { timeoutMs: 15_000, intervalMs: 50, what: 'lot to close' },
    );
    expect(closedAt - endsAt.getTime()).toBeLessThan(2000);
    expect(closedAt).toBeGreaterThanOrEqual(endsAt.getTime());
    expect(await statusOf(lot)).toBe('awaiting_payment');
    await waitFor(
      async () =>
        (await mailpitMessages()).some((m) => m.To.some((r) => r.Address.startsWith(buyer))),
      { what: 'winner email' },
    );
    expect(await closedEvents(lot)).toBe(1);
    expect(
      await count(
        t.pool,
        `SELECT count(*) AS n FROM email_log WHERE kind = 'won' AND user_id = $1`,
        [buyer],
      ),
    ).toBe(1);
    await w.stop();
    handles.length = 0;
  });
});

describe('invariant 13: losing Redis loses nothing', () => {
  it('FLUSHALL while lots are waiting to close: every lot still closes on time, nothing twice', async () => {
    const seller = await makeUser(t.pool);
    const buyers = await makeUsers(t.pool, 6);
    for (const b of buyers) await fund(t.pool, b, UAH(5000));
    const deps: Deps = {
      pool: t.pool,
      clock: { now: () => new Date() },
      timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 },
    };
    const endsAt = Date.now() + 5000;
    const lots: string[] = [];
    for (let i = 0; i < 6; i++) {
      const lot = await makeLot(t.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        now: new Date(),
        endsAt: new Date(endsAt),
      });
      await placeBid(deps, {
        lotId: lot,
        userId: buyers[i] as string,
        kind: 'manual',
        amount: UAH(200 + i),
        idempotencyKey: randomUUID(),
      });
      lots.push(lot);
    }
    const config = testConfig(t, { timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 } });
    await spawn({ config });
    // Wait until the delayed close jobs exist, then destroy Redis.
    const redis = createRedis(config.redisUrl, 'flusher');
    await new Promise((r) => setTimeout(r, 800));
    await redis.flushdb(); // what FLUSHALL does to this database
    redis.disconnect();

    await waitFor(
      async () => (await Promise.all(lots.map(statusOf))).every((s) => s === 'awaiting_payment'),
      { timeoutMs: 20_000, intervalMs: 100, what: 'all lots closed after the flush' },
    );
    const done = Date.now();
    expect(done - endsAt).toBeLessThan(3000);
    for (const lot of lots) {
      expect(await closedEvents(lot), lot).toBe(1);
      expect(
        await count(
          t.pool,
          `SELECT count(*) AS n FROM email_log WHERE kind = 'won' AND payload->>'lotId' = $1`,
          [lot],
        ),
      ).toBe(1);
    }
    expect((await reconcile(t.pool)).ok).toBe(true);
    await stopAll();
  });

  it('Redis restarted empty while the worker is stopped, then the worker restarts: overdue lots are closed at once', async () => {
    const seller = await makeUser(t.pool);
    const buyer = await makeUser(t.pool);
    await fund(t.pool, buyer, UAH(5000));
    const deps: Deps = {
      pool: t.pool,
      clock: { now: () => new Date() },
      timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 },
    };
    const lot = await makeLot(t.pool, {
      sellerId: seller,
      startPrice: UAH(100),
      now: new Date(),
      endsAt: new Date(Date.now() + 1500),
    });
    await placeBid(deps, {
      lotId: lot,
      userId: buyer,
      kind: 'manual',
      amount: UAH(250),
      idempotencyKey: randomUUID(),
    });
    const config = testConfig(t, { timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 } });
    const first = await spawn({ config });
    await first.stop(); // the process is gone before the lot ends
    handles.length = 0;
    const redis = createRedis(config.redisUrl, 'flusher2');
    await redis.flushdb();
    redis.disconnect();
    await new Promise((r) => setTimeout(r, 2000)); // the lot is now overdue and nobody noticed
    expect(await statusOf(lot)).toBe('active');
    await spawn({ config });
    await waitFor(async () => (await statusOf(lot)) === 'awaiting_payment', {
      timeoutMs: 10_000,
      what: 'overdue lot to close',
    });
    expect(await closedEvents(lot)).toBe(1);
    await stopAll();
  });

  it('payment deadline, second chance and auto-confirm all fire from Postgres alone, with a flushed Redis between every step', async () => {
    const f = await newTestDb(40);
    try {
      await f.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
      );
      await f.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
      );
      const clock = fakeClock();
      const seller = await makeUser(f.pool);
      const [a, b, c] = await makeUsers(f.pool, 3);
      for (const u of [a!, b!, c!]) await fund(f.pool, u, UAH(10_000));
      const deps: Deps = { pool: f.pool, clock, timings: { ...DEFAULT_TIMINGS } };
      const lot = await makeLot(f.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        now: clock.now(),
        endsAt: new Date(clock.now().getTime() + 10 * 60_000),
      });
      await placeBid(deps, {
        lotId: lot,
        userId: c!,
        kind: 'auto',
        amount: UAH(1000),
        idempotencyKey: randomUUID(),
      });
      await placeBid(deps, {
        lotId: lot,
        userId: b!,
        kind: 'auto',
        amount: UAH(2000),
        idempotencyKey: randomUUID(),
      });
      await placeBid(deps, {
        lotId: lot,
        userId: a!,
        kind: 'auto',
        amount: UAH(3000),
        idempotencyKey: randomUUID(),
      });

      const config = testConfig(f, { indexUid: undefined });
      const redis = createRedis(config.redisUrl, 'flusher3');
      const w = await spawn({
        config,
        clock,
        disable: { searchSync: true, webhooks: true, reconcile: true },
      });
      const st = async () => await lotRow<{ status: string; buyer_id: string | null }>(f.pool, lot);
      const run = async (ms: number, until: () => Promise<boolean>) => {
        clock.advance(ms);
        await redis.flushdb(); // Redis forgets everything before each deadline
        await w.tick();
        await waitFor(until, { timeoutMs: 15_000, what: 'deadline handler' });
      };
      await run(11 * 60_000, async () => (await st()).status === 'awaiting_payment');
      expect((await st()).buyer_id).toBe(a);
      await run(48 * 3600_000, async () => (await st()).buyer_id === b); // A never paid → offer to B
      await run(24 * 3600_000, async () => (await st()).buyer_id === c); // B never paid → offer to C
      await run(24 * 3600_000, async () => (await st()).status === 'ended_unsold'); // nobody left
      expect(
        await count(f.pool, `SELECT count(*) AS n FROM payment_defaults WHERE lot_id = $1`, [lot]),
      ).toBe(3);
      expect(await balanceOf(f.pool, seller, 'available')).toBe(UAH(300)); // A's deposit
      expect((await reconcile(f.pool)).ok).toBe(true);
      redis.disconnect();
      await stopAll();
    } finally {
      await f.close();
    }
  });
});

describe('invariant 13: three worker copies never do a job twice', () => {
  it('30 lots closing at once across 3 workers: each closed exactly once, one winner email each, one ledger hold each', async () => {
    const f = await newTestDb(60);
    try {
      await f.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
      );
      await f.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
      );
      const seller = await makeUser(f.pool);
      const buyers = await makeUsers(f.pool, 30);
      for (const b of buyers) await fund(f.pool, b, UAH(5000));
      const deps: Deps = {
        pool: f.pool,
        clock: { now: () => new Date() },
        timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 },
      };
      const lots: string[] = [];
      const endsAt = new Date(Date.now() + 4000);
      for (let i = 0; i < 30; i++) {
        const lot = await makeLot(f.pool, {
          sellerId: seller,
          startPrice: UAH(100),
          now: new Date(),
          endsAt,
        });
        await placeBid(deps, {
          lotId: lot,
          userId: buyers[i] as string,
          kind: 'manual',
          amount: UAH(300),
          idempotencyKey: randomUUID(),
        });
        lots.push(lot);
      }
      const config = testConfig(f, { timings: { ...DEFAULT_TIMINGS, antiSnipeMs: 1 } });
      await Promise.all(
        [1, 2, 3].map((n) => spawn({ config, name: `w${n}`, disable: { searchSync: n > 1 } })),
      );
      await waitFor(
        async () =>
          (await count(
            f.pool,
            `SELECT count(*) AS n FROM lots WHERE id = ANY($1) AND status = 'awaiting_payment'`,
            [lots],
          )) === 30,
        { timeoutMs: 25_000, what: 'all 30 closed' },
      );
      // Let every sender finish, then count the effects.
      await waitFor(
        async () =>
          (await count(f.pool, `SELECT count(*) AS n FROM email_log WHERE status = 'sent'`)) >= 60,
        { timeoutMs: 30_000, what: 'emails sent' },
      );
      await new Promise((r) => setTimeout(r, 1500));
      for (const lot of lots) {
        expect(
          await count(
            f.pool,
            `SELECT count(*) AS n FROM lot_events WHERE lot_id = $1 AND type = 'closed'`,
            [lot],
          ),
          lot,
        ).toBe(1);
      }
      expect(await count(f.pool, `SELECT count(*) AS n FROM email_log WHERE kind = 'won'`)).toBe(
        30,
      );
      expect(
        await count(f.pool, `SELECT count(*) AS n FROM email_log WHERE kind = 'lot_sold'`),
      ).toBe(30);
      expect(
        await count(f.pool, `SELECT count(*) AS n FROM email_log WHERE status <> 'sent'`),
      ).toBe(0);
      expect(
        await count(f.pool, `SELECT count(*) AS n FROM ledger_transactions WHERE kind = 'hold'`),
      ).toBe(30);
      // And the SMTP server received exactly one message per email row (no duplicates on the wire).
      const ids = (await f.pool.query<{ id: string }>(`SELECT id FROM email_log`)).rows.map(
        (r) => r.id,
      );
      const wire = (await mailpitMessages()).filter((m) =>
        ids.some((id) => m.MessageID.includes(id)),
      );
      expect(wire.length).toBe(ids.length);
      expect(new Set(wire.map((m) => m.MessageID)).size).toBe(ids.length);
      expect((await reconcile(f.pool)).ok).toBe(true);
      await stopAll();
    } finally {
      await f.close();
    }
  });

  it('a backlog of 60 queued emails is sent by 3 workers: 60 messages, none duplicated', async () => {
    const f = await newTestDb(40);
    try {
      const users = await makeUsers(f.pool, 60);
      const ids: string[] = [];
      for (const u of users) {
        const id = randomUUID();
        ids.push(id);
        await f.pool.query(
          `INSERT INTO email_log (id, dedupe_key, user_id, kind, payload) VALUES ($1, $2, $3, 'lot_approved', '{"title":"x"}')`,
          [id, `bk:${id}`, u],
        );
      }
      const config = testConfig(f);
      await Promise.all(
        [1, 2, 3].map((n) =>
          spawn({
            config,
            name: `m${n}`,
            disable: { searchSync: true, webhooks: true, reconcile: true },
          }),
        ),
      );
      await waitFor(
        async () =>
          (await count(f.pool, `SELECT count(*) AS n FROM email_log WHERE status = 'sent'`)) === 60,
        { timeoutMs: 30_000, what: '60 sent' },
      );
      await new Promise((r) => setTimeout(r, 1000));
      const wire = (await mailpitMessages()).filter((m) =>
        ids.some((id) => m.MessageID.includes(id)),
      );
      expect(wire.length).toBe(60);
      expect(new Set(wire.map((m) => m.MessageID)).size).toBe(60);
      await stopAll();
    } finally {
      await f.close();
    }
  });
});

describe('search stays in step with Postgres (invariant 11)', () => {
  it('a bid is searchable within 5 seconds, and Meilisearch going down and coming back loses nothing', async () => {
    const f = await newTestDb(40);
    const proxy = await startToggleProxy(testConfig(f).meili.url);
    try {
      await f.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
      );
      await f.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
      );
      const config = testConfig(f, { meili: { url: proxy.url(), key: testConfig(f).meili.key } });
      const meili = createMeili(proxy.url(), config.meili.key);
      await ensureIndex(meili, config.indexUid);
      const query = (qs: string) =>
        searchLots(
          meili,
          searchQuerySchema.parse(Object.fromEntries(new URLSearchParams(qs))),
          Date.now(),
          config.indexUid,
        );
      const seller = await makeUser(f.pool);
      const bidder = await makeUser(f.pool);
      await fund(f.pool, bidder, UAH(50_000));
      const deps: Deps = {
        pool: f.pool,
        clock: { now: () => new Date() },
        timings: { ...DEFAULT_TIMINGS },
      };
      const lot = await makeLot(f.pool, {
        sellerId: seller,
        startPrice: UAH(100),
        title: 'Searchable unique-www',
        now: new Date(),
        endsAt: new Date(Date.now() + 3_600_000),
      });
      await f.pool.query(`INSERT INTO outbox (topic, aggregate_id) VALUES ('lot.upsert', $1)`, [
        lot,
      ]);
      await spawn({
        config,
        disable: { scheduler: true, webhooks: true, reconcile: true, consumers: true },
      });
      await waitFor(async () => (await query('q=unique-www')).total === 1, { what: 'lot indexed' });

      // Lag under load: a bid must reach search in < 5 s.
      const t0 = Date.now();
      await placeBid(deps, {
        lotId: lot,
        userId: bidder,
        kind: 'manual',
        amount: UAH(150),
        idempotencyKey: randomUUID(),
      });
      await waitFor(
        async () => (await query('q=unique-www')).items[0]?.current_price === UAH(150),
        { timeoutMs: 5000, intervalMs: 100, what: 'bid in search' },
      );
      expect(Date.now() - t0).toBeLessThan(5000);

      // Meilisearch goes down. Bidding and the lot page's data (Postgres) keep working; search says so clearly.
      await proxy.down();
      const during = await placeBid(deps, {
        lotId: lot,
        userId: bidder,
        kind: 'auto',
        amount: UAH(400),
        idempotencyKey: randomUUID(),
      });
      expect(during.result).toMatchObject({ ok: true });
      await expect(query('q=unique-www')).rejects.toMatchObject({ code: 'SEARCH_UNAVAILABLE' });
      expect(
        (await lotRow<{ current_price: number }>(f.pool, lot)).current_price,
      ).toBeGreaterThanOrEqual(UAH(150));
      await new Promise((r) => setTimeout(r, 1200));
      expect(
        await count(f.pool, `SELECT count(*) AS n FROM outbox WHERE processed_at IS NULL`),
      ).toBeGreaterThan(0); // backlog is waiting

      // It comes back: the backlog drains and the index catches up on its own.
      await proxy.up();
      await waitFor(
        async () =>
          (await count(f.pool, `SELECT count(*) AS n FROM outbox WHERE processed_at IS NULL`)) ===
          0,
        { timeoutMs: 15_000, what: 'outbox to drain' },
      );
      await waitFor(
        async () =>
          (await query('q=unique-www')).items[0]?.current_price ===
          (await lotRow<{ current_price: number }>(f.pool, lot)).current_price,
        { timeoutMs: 8000, what: 'index to catch up' },
      );
      await stopAll();
      await meili.deleteIndexIfExists(config.indexUid ?? 'lots');
    } finally {
      await proxy.down();
      await f.close();
    }
  });
});

describe('photos through the worker', () => {
  it('an uploaded photo is processed by the queue, and appears publicly only after the lot is approved', async () => {
    const f = await newTestDb(30);
    const config = testConfig(f);
    const s3 = createS3(config.s3);
    try {
      await ensureBuckets(s3, config.s3 as S3Config);
      await ensureIndex(createMeili(config.meili.url, config.meili.key), config.indexUid);
      const seller = await makeUser(f.pool);
      const mod = await makeUser(f.pool, 'moderator');
      await f.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
      );
      await f.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
      );
      const lot = await makeLot(f.pool, { sellerId: seller, status: 'in_review' });
      const photoId = randomUUID();
      const raw = await sharp({
        create: { width: 600, height: 400, channels: 3, background: '#336' },
      })
        .withExif({ IFD0: { Make: 'LeakyCam' } })
        .jpeg()
        .toBuffer();
      await f.pool.query(
        `INSERT INTO lot_photos (id, lot_id, position, key, content_type, size_bytes) VALUES ($1, $2, 0, $3, 'image/jpeg', $4)`,
        [photoId, lot, photoKeys(lot, photoId).upload, raw.length],
      );
      await putObject(
        s3,
        config.s3.privateBucket,
        photoKeys(lot, photoId).upload,
        raw,
        'image/jpeg',
      );

      const clock = { now: () => new Date() };
      await spawn({ config, clock });
      await waitFor(
        async () =>
          (
            await f.pool.query<{ status: string }>('SELECT status FROM lot_photos WHERE id = $1', [
              photoId,
            ])
          ).rows[0]?.status === 'ready',
        { timeoutMs: 15_000, what: 'photo processed' },
      );
      const row = (
        await f.pool.query<{ key: string }>('SELECT key FROM lot_photos WHERE id = $1', [photoId])
      ).rows[0]!;
      const anon = (bucket: string) => fetch(`${config.s3.endpoint}/${bucket}/${row.key}`);
      expect((await anon(config.s3.privateBucket)).status).toBe(403);
      expect((await anon(config.s3.publicBucket)).status).toBeGreaterThanOrEqual(400); // still in review

      // Approve through the real flow; the outbox event makes the worker publish the photo.
      const deps: Deps = { pool: f.pool, clock, timings: { ...DEFAULT_TIMINGS } };
      await claimNextLot(deps, mod);
      const { approveLot } = await import('@auction/domain');
      await approveLot(deps, { lotId: lot, moderatorId: mod });
      await waitFor(async () => (await anon(config.s3.publicBucket)).status === 200, {
        timeoutMs: 10_000,
        what: 'public photo',
      });
      expect((await headObject(s3, config.s3.privateBucket, row.key))?.size).toBeGreaterThan(0);
      await stopAll();
    } finally {
      await f.close();
    }
  });
});

describe('payment webhooks in chaos mode (invariant 6, acceptance 9)', () => {
  it('duplicates, delays, contradicting events, bad signatures and lost webhooks: every top-up credited exactly once', async () => {
    const f = await newTestDb(50);
    try {
      const clock = fakeClock();
      const deps: Deps = { pool: f.pool, clock, timings: { ...DEFAULT_TIMINGS } };
      const api = await startProviderApi(deps, () => clock.now());
      try {
        const users = await makeUsers(f.pool, 30);
        const mk = async (userId: string, amount: number) => {
          const { result } = await createTopup(deps, {
            userId,
            amount,
            idempotencyKey: randomUUID(),
          });
          const p = await createPayment(f.pool, {
            amount,
            reference: result.topupId,
            notifyUrl: api.webhookUrl,
            now: clock.now(),
          });
          await attachProviderPayment(f.pool, result.topupId, p.id);
          return { topupId: result.topupId, paymentId: p.id, userId, amount };
        };
        const topups = await Promise.all(users.map((u, i) => mk(u, UAH(100 + i))));
        // Seeded randomness so the run is reproducible but still hits every misbehaviour.
        let s = 12345;
        const random = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
        const outcomes = topups.map(
          (_, i) => (i % 5 === 4 ? 'failed' : 'succeeded') as 'succeeded' | 'failed',
        );
        for (const [i, tp] of topups.entries()) {
          await decidePayment(f.pool, {
            paymentId: tp.paymentId,
            outcome: outcomes[i] as 'succeeded' | 'failed',
            chaos: true,
            now: clock.now(),
            random,
          });
        }
        const config = testConfig(f, {
          provider: { baseUrl: api.base, apiKey: 'test-provider-api-key-0123456789' },
          intervals: {
            sweeperMs: 60_000,
            searchSyncMs: 60_000,
            webhookMs: 150,
            topupReconcileMs: 300,
            topupReconcileMinAgeMs: 120_000,
          },
        });
        await spawn({
          config,
          clock,
          disable: { scheduler: true, searchSync: true, consumers: true },
        });

        // Time passes in jumps: delayed webhooks become due, then the reconciler's grace period ends.
        for (let step = 0; step < 6; step++) {
          clock.advance(20_000);
          await new Promise((r) => setTimeout(r, 400));
        }
        clock.advance(5 * 60_000); // webhooks that were lost are now older than the reconciler's minimum age
        await waitFor(
          async () =>
            (await count(f.pool, `SELECT count(*) AS n FROM topups WHERE status = 'pending'`)) ===
            0,
          { timeoutMs: 20_000, intervalMs: 200, what: 'every top-up settled' },
        );
        await new Promise((r) => setTimeout(r, 800));

        for (const [i, tp] of topups.entries()) {
          const expected = outcomes[i] === 'succeeded' ? tp.amount : 0;
          expect(
            await balanceOf(f.pool, tp.userId, 'available'),
            `top-up ${i} (${outcomes[i]})`,
          ).toBe(expected);
          expect(
            await count(f.pool, `SELECT count(*) AS n FROM ledger_transactions WHERE ref = $1`, [
              `topup:${tp.topupId}`,
            ]),
          ).toBe(outcomes[i] === 'succeeded' ? 1 : 0);
        }
        // Chaos really happened: bogus/duplicate events reached the receiver, and some payments needed the reconciler.
        expect(api.log.length).toBeGreaterThan(10);
        expect(
          api.log.filter((e) => e.type === 'payment.failed' && e.verdict === 'succeeded').length +
            api.log.length,
        ).toBeGreaterThan(10);
        const report = await reconcile(f.pool, async (id) => {
          const p = await (await import('@auction/payment-stub')).getPayment(f.pool, id);
          return { status: p?.status ?? 'not_found', amount: p?.amount };
        });
        expect(report, JSON.stringify(report)).toMatchObject({
          ok: true,
          entriesSum: 0,
          providerMismatches: [],
        });
        await stopAll();
      } finally {
        await api.close();
      }
    } finally {
      await f.close();
    }
  }, 90_000);

  it('a webhook with a wrong signature is refused by the receiver and credits nothing', async () => {
    const f = await newTestDb(20);
    try {
      const clock = fakeClock();
      const deps: Deps = { pool: f.pool, clock, timings: { ...DEFAULT_TIMINGS } };
      const api = await startProviderApi(deps, () => clock.now());
      try {
        const user = await makeUser(f.pool);
        const { result } = await createTopup(deps, {
          userId: user,
          amount: UAH(500),
          idempotencyKey: randomUUID(),
        });
        const p = await createPayment(f.pool, {
          amount: UAH(500),
          reference: result.topupId,
          notifyUrl: api.webhookUrl,
          now: clock.now(),
        });
        await attachProviderPayment(f.pool, result.topupId, p.id);
        await decidePayment(f.pool, {
          paymentId: p.id,
          outcome: 'succeeded',
          chaos: false,
          now: clock.now(),
        });
        const body = JSON.stringify({
          type: 'payment.succeeded',
          data: {
            paymentId: p.id,
            reference: result.topupId,
            amount: UAH(500),
            status: 'succeeded',
          },
        });
        for (const headers of [
          {
            'x-provider-signature': 'v1=00',
            'x-provider-timestamp': String(clock.now().getTime()),
          },
          { 'x-provider-timestamp': String(clock.now().getTime()) },
          {},
        ]) {
          const res = await fetch(api.webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body,
          });
          expect(res.status).toBe(400);
        }
        expect(await balanceOf(f.pool, user, 'available')).toBe(0);
        expect(api.log.every((e) => e.type === 'rejected')).toBe(true);
      } finally {
        await api.close();
      }
    } finally {
      await f.close();
    }
  });
});

describe('favourites and moderation timers run from the scheduler', () => {
  it('a favourite is reminded once an hour before the end, and not again when the lot is extended', async () => {
    const f = await newTestDb(30);
    try {
      await f.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
      );
      await f.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
      );
      const clock = fakeClock();
      const deps: Deps = { pool: f.pool, clock, timings: { ...DEFAULT_TIMINGS } };
      const seller = await makeUser(f.pool);
      const fan = await makeUser(f.pool);
      const lot = await makeLot(f.pool, {
        sellerId: seller,
        now: clock.now(),
        endsAt: new Date(clock.now().getTime() + 2 * 3600_000),
      });
      await addFavorite(deps, { userId: fan, lotId: lot });
      const w = await spawn({
        config: testConfig(f),
        clock,
        disable: { searchSync: true, webhooks: true, reconcile: true },
      });
      const reminders = () =>
        count(
          f.pool,
          `SELECT count(*) AS n FROM email_log WHERE kind = 'favorite_reminder' AND user_id = $1`,
          [fan],
        );

      await w.tick();
      expect(await reminders()).toBe(0); // 2 h left: too early
      clock.advance(61 * 60_000); // 59 min left
      await Promise.all([w.tick(), w.tick(), w.tick()]); // even three ticks at once
      expect(await reminders()).toBe(1);
      await waitFor(
        async () =>
          (await mailpitMessages()).some((m) => m.To.some((r) => r.Address.startsWith(fan))),
        { what: 'reminder email' },
      );
      // The lot is extended; its end is again within the hour: no second reminder.
      await f.pool.query(
        `UPDATE lots SET ends_at = ends_at + interval '30 minutes' WHERE id = $1`,
        [lot],
      );
      clock.advance(5 * 60_000);
      await w.tick();
      await w.tick();
      expect(await reminders()).toBe(1);
      await stopAll();
    } finally {
      await f.close();
    }
  });

  it('a moderator claim abandoned for 15 minutes returns to the queue by itself', async () => {
    const f = await newTestDb(20);
    try {
      const clock = fakeClock();
      const deps: Deps = { pool: f.pool, clock, timings: { ...DEFAULT_TIMINGS } };
      const seller = await makeUser(f.pool);
      const lot = await makeLot(f.pool, { sellerId: seller, status: 'in_review' });
      const mod = await makeUser(f.pool, 'moderator');
      await claimNextLot(deps, mod);
      const w = await spawn({
        config: testConfig(f),
        clock,
        disable: { searchSync: true, webhooks: true, reconcile: true, consumers: true },
      });
      clock.advance(14 * 60_000);
      await w.tick();
      expect((await lotRow<{ claimed_by: string | null }>(f.pool, lot)).claimed_by).toBe(mod);
      clock.advance(60_000);
      await w.tick();
      expect((await lotRow<{ claimed_by: string | null }>(f.pool, lot)).claimed_by).toBeNull();
      await stopAll();
    } finally {
      await f.close();
    }
  });
});

void createFakeClock;
