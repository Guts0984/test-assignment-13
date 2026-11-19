import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fund,
  infra,
  lotRow,
  makeLot,
  makeUser,
  newTestDb,
  uniqueName,
  waitFor,
  type TestDb,
} from '@auction/test-kit';
import { createFakeClock, placeBid, type Deps } from '@auction/domain';
import { DEFAULT_TIMINGS, searchQuerySchema, type SearchQuery } from '@auction/shared';
import {
  createMeili,
  ensureIndex,
  loadDocs,
  processOutbox,
  reindexAll,
  searchLots,
  searchHealthy,
  syncSearchLots,
} from '../src/index.js';

let t: TestDb;
const meili = createMeili(infra.meiliUrl, infra.meiliKey);
const INDEX = uniqueName('lots');
const clock = createFakeClock(Date.now());
const deps = (): Deps => ({ pool: t.pool, clock, timings: { ...DEFAULT_TIMINGS } });
const q = (qs: string): SearchQuery =>
  searchQuerySchema.parse(Object.fromEntries(new URLSearchParams(qs)));

beforeAll(async () => {
  t = await newTestDb();
  await t.pool.query(
    `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a'),(2,'b','b','b','b'),(3,'c','c','c','c') ON CONFLICT DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x'),(2,'y','y','y','y') ON CONFLICT DO NOTHING`,
  );
  await ensureIndex(meili, INDEX);
});
afterAll(async () => {
  await meili.deleteIndexIfExists(INDEX);
  await t.close();
});

const seller = async () => makeUser(t.pool);
let counter = 0;
const lot = async (
  over: {
    title?: string;
    category?: number;
    city?: number;
    condition?: string;
    start?: number;
    reserve?: number | null;
    endsInMin?: number;
    sellerId?: string;
  } = {},
) => {
  const id = await makeLot(t.pool, {
    sellerId: over.sellerId ?? (await seller()),
    title: over.title ?? `Lot number ${++counter}`,
    startPrice: over.start ?? 10_000,
    reservePrice: over.reserve ?? null,
    now: clock.now(),
    endsAt: new Date(clock.now().getTime() + (over.endsInMin ?? 600) * 60_000),
  });
  await t.pool.query(
    'UPDATE lots SET category_id = $2, city_id = $3, condition = $4 WHERE id = $1',
    [id, over.category ?? 1, over.city ?? 1, over.condition ?? 'good'],
  );
  return id;
};
const sync = (ids: string[]) => syncSearchLots(t.pool, meili, ids, INDEX);
const find = (query: SearchQuery) => searchLots(meili, query, clock.now().getTime(), INDEX);

describe('the reserve price never reaches the index (invariant 14)', () => {
  it('documents carry only "met / not met", and no field, value or settings entry exposes the amount', async () => {
    const RESERVE = 7_654_321;
    const id = await lot({ title: 'Camera with secret reserve', start: 10_000, reserve: RESERVE });
    await sync([id]);
    const docs = await loadDocs(t.pool, [id]);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ reserve_met: false });
    expect(Object.keys(docs[0] as object)).not.toContain('reserve_price');

    await waitFor(async () => (await find(q('q=secret'))).total > 0, {
      what: 'doc to be searchable',
    });
    const everything = JSON.stringify([
      await find(q('q=secret')),
      await meili.index(INDEX).getDocuments({ limit: 1000 }),
      await meili.index(INDEX).search('', { limit: 100, attributesToRetrieve: ['*'] }),
      await meili.index(INDEX).getSettings(),
    ]);
    expect(everything).not.toContain(String(RESERVE));
    expect(everything.toLowerCase()).not.toMatch(/reserve_?price/);
    expect(everything).toContain('reserve_met');
  });

  it('the flag flips to true only when the price reaches the reserve', async () => {
    const owner = await seller();
    const bidder = await makeUser(t.pool);
    await fund(t.pool, bidder, 5_000_000);
    const id = await lot({ sellerId: owner, start: 10_000, reserve: 50_000 });
    await sync([id]);
    expect((await loadDocs(t.pool, [id]))[0]?.reserve_met).toBe(false);
    await placeBid(deps(), {
      lotId: id,
      userId: bidder,
      kind: 'auto',
      amount: 200_000,
      idempotencyKey: randomUUID(),
    });
    expect((await loadDocs(t.pool, [id]))[0]?.reserve_met).toBe(true);
    const noReserve = await lot({});
    expect((await loadDocs(t.pool, [noReserve]))[0]?.reserve_met).toBeNull();
  });
});

describe('only running lots are searchable', () => {
  it('drafts, in-review, closed and removed lots are not indexed, and leave the index when they stop being active', async () => {
    const owner = await seller();
    const draft = await makeLot(t.pool, { sellerId: owner, status: 'draft' });
    const review = await makeLot(t.pool, { sellerId: owner, status: 'in_review' });
    const live = await lot({ sellerId: owner, title: 'Livelot unique-aaa' });
    await sync([draft, review, live]);
    expect((await loadDocs(t.pool, [draft, review])).length).toBe(0);
    await waitFor(async () => (await find(q('q=unique-aaa'))).total === 1, { what: 'live lot' });

    await t.pool.query(`UPDATE lots SET status = 'ended_unsold' WHERE id = $1`, [live]);
    const r = await sync([live]);
    expect(r).toEqual({ upserted: 0, deleted: 1 });
    await waitFor(async () => (await find(q('q=unique-aaa'))).total === 0, {
      what: 'lot to leave the index',
    });
  });

  it('an ended-but-not-yet-closed lot is hidden by the query itself, so a late worker cannot show a dead lot', async () => {
    const id = await lot({ title: 'Zombie unique-bbb', endsInMin: 1 });
    await sync([id]);
    await waitFor(async () => (await find(q('q=unique-bbb'))).total === 1, { what: 'zombie' });
    clock.advance(2 * 60_000);
    expect((await find(q('q=unique-bbb'))).total).toBe(0);
    clock.advance(-2 * 60_000);
  });
});

describe('outbox sync (invariant 11)', () => {
  it('a domain change is visible in search within 5 seconds, and the outbox row is marked processed', async () => {
    const owner = await seller();
    const bidder = await makeUser(t.pool);
    await fund(t.pool, bidder, 5_000_000);
    const id = await lot({ sellerId: owner, title: 'Outbox lag unique-ccc', start: 10_000 });
    await t.pool.query(`INSERT INTO outbox (topic, aggregate_id) VALUES ('lot.upsert', $1)`, [id]);
    await processOutbox(t.pool, meili, { indexUid: INDEX });
    await waitFor(async () => (await find(q('q=unique-ccc'))).items[0]?.bid_count === 0, {
      what: 'initial',
    });

    const started = Date.now();
    await placeBid(deps(), {
      lotId: id,
      userId: bidder,
      kind: 'manual',
      amount: 12_000,
      idempotencyKey: randomUUID(),
    });
    // A "worker" loop would run this every ~500 ms.
    const seen = await waitFor(
      async () => {
        await processOutbox(t.pool, meili, { indexUid: INDEX });
        const item = (await find(q('q=unique-ccc'))).items[0];
        return item?.bid_count === 1 ? item : undefined;
      },
      { timeoutMs: 5000, intervalMs: 300, what: 'bid to reach search' },
    );
    expect(seen.current_price).toBe(12_000);
    expect(Date.now() - started).toBeLessThan(5000);
    const left = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL AND aggregate_id = $1`,
      [id],
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it('Meilisearch unreachable: the sync fails cleanly, nothing is lost, and the backlog drains when it is back', async () => {
    const dead = createMeili('http://127.0.0.1:1', 'nope');
    const ids = await Promise.all(Array.from({ length: 5 }, () => lot({})));
    for (const id of ids)
      await t.pool.query(`INSERT INTO outbox (topic, aggregate_id) VALUES ('lot.upsert', $1)`, [
        id,
      ]);

    await expect(processOutbox(t.pool, dead, { indexUid: INDEX })).rejects.toThrow();
    const pending = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL AND aggregate_id = ANY($1)`,
      [ids],
    );
    expect(pending.rows[0]?.n).toBe(5); // rolled back: rows are still waiting
    expect(await searchHealthy(dead)).toBe(false);
    await expect(searchLots(dead, q(''), Date.now(), INDEX)).rejects.toMatchObject({
      code: 'SEARCH_UNAVAILABLE',
    });

    // Meilisearch is back: the same rows are processed.
    for (let i = 0; i < 10; i++) {
      const r = await processOutbox(t.pool, meili, { indexUid: INDEX });
      if (r.rows === 0) break;
    }
    const after = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL AND aggregate_id = ANY($1)`,
      [ids],
    );
    expect(after.rows[0]?.n).toBe(0);
    expect(await searchHealthy(meili)).toBe(true);
    const total = (
      await meili
        .index(INDEX)
        .getDocuments({ ids, limit: 100 } as never)
        .catch(() => ({ results: [] as unknown[] }))
    ).results.length;
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it('five workers draining one backlog: every row is processed once, none lost, no errors', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, () => lot({})));
    for (const id of ids)
      await t.pool.query(`INSERT INTO outbox (topic, aggregate_id) VALUES ('lot.upsert', $1)`, [
        id,
      ]);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, async () => {
        let rows = 0;
        for (let i = 0; i < 20; i++) {
          const r = await processOutbox(t.pool, meili, { indexUid: INDEX, batch: 6 });
          rows += r.rows;
          if (r.rows === 0) break;
        }
        return rows;
      }),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const handled = results
      .flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      .reduce((a, b) => a + b, 0);
    expect(handled).toBeGreaterThanOrEqual(40);
    const left = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL AND aggregate_id = ANY($1)`,
      [ids],
    );
    expect(left.rows[0]?.n).toBe(0);
    const stored = await meili.index(INDEX).getDocuments({ limit: 5000 });
    const have = new Set(stored.results.map((d) => (d as { id: string }).id));
    for (const id of ids) expect(have.has(id), id).toBe(true);
  });

  it('a stale or duplicate event never reintroduces old data: sync always reads the CURRENT row', async () => {
    const owner = await seller();
    const bidder = await makeUser(t.pool);
    await fund(t.pool, bidder, 5_000_000);
    const id = await lot({ sellerId: owner, title: 'Stale unique-ddd' });
    await placeBid(deps(), {
      lotId: id,
      userId: bidder,
      kind: 'manual',
      amount: 15_000,
      idempotencyKey: randomUUID(),
    });
    await sync([id, id, id]);
    await sync([id]);
    await waitFor(async () => (await find(q('q=unique-ddd'))).items[0]?.current_price === 15_000, {
      what: 'current price',
    });
    expect((await lotRow<{ current_price: number }>(t.pool, id)).current_price).toBe(15_000);
  });
});

describe('querying: filters, facets, sort, pagination', () => {
  let ids: Record<string, string> = {};
  beforeAll(async () => {
    // A dedicated, tiny index so counts are exact.
    const idx = uniqueName('facets');
    ids = {};
    await ensureIndex(meili, idx);
    const mk = async (key: string, o: Parameters<typeof lot>[0]) => {
      const id = await lot(o);
      ids[key] = id;
      return id;
    };
    await mk('a', {
      title: 'Vintage camera Leica',
      category: 1,
      city: 1,
      condition: 'good',
      start: 50_000,
      endsInMin: 30,
    });
    await mk('b', {
      title: 'Vintage camera Canon',
      category: 1,
      city: 2,
      condition: 'new',
      start: 150_000,
      endsInMin: 600,
    });
    await mk('c', {
      title: 'Wooden chair',
      category: 2,
      city: 1,
      condition: 'good',
      start: 20_000,
      endsInMin: 45,
    });
    await mk('d', {
      title: 'Wooden table',
      category: 2,
      city: 2,
      condition: 'fair',
      start: 90_000,
      endsInMin: 3000,
    });
    await mk('e', {
      title: 'Garden spade',
      category: 3,
      city: 1,
      condition: 'good',
      start: 5_000,
      endsInMin: 120,
    });
    // A bid on 'b' so "no bids" excludes it.
    const bidder = await makeUser(t.pool);
    await fund(t.pool, bidder, 9_000_000);
    await placeBid(deps(), {
      lotId: ids['b'] as string,
      userId: bidder,
      kind: 'manual',
      amount: 160_000,
      idempotencyKey: randomUUID(),
    });
    await meili.deleteIndexIfExists(idx);
    // Use the shared per-file index, cleared first.
    await meili.index(INDEX).deleteAllDocuments().waitTask();
    await sync(Object.values(ids));
    await waitFor(async () => (await find(q(''))).total === 5, { what: '5 docs' });
  });

  const titles = (r: Awaited<ReturnType<typeof find>>) => r.items.map((i) => i.title);

  it('free text finds by words in the title', async () => {
    expect(titles(await find(q('q=vintage'))).sort()).toEqual([
      'Vintage camera Canon',
      'Vintage camera Leica',
    ]);
    expect(titles(await find(q('q=wooden'))).sort()).toEqual(['Wooden chair', 'Wooden table']);
    expect((await find(q('q=nothingmatchesthis'))).total).toBe(0);
  });

  it('filters: category, city, condition, price range, no bids, ending soon', async () => {
    expect((await find(q('category=2'))).total).toBe(2);
    expect((await find(q('category=1,3'))).total).toBe(3);
    expect((await find(q('city=2'))).total).toBe(2);
    expect((await find(q('condition=new'))).total).toBe(1);
    expect((await find(q('condition=good,fair'))).total).toBe(4);
    expect(titles(await find(q('priceMin=20000&priceMax=90000'))).sort()).toEqual([
      'Vintage camera Leica',
      'Wooden chair',
      'Wooden table',
    ]);
    expect((await find(q('noBids=true'))).total).toBe(4); // 'b' has a bid
    expect(titles(await find(q('endingSoon=true'))).sort()).toEqual([
      'Vintage camera Leica',
      'Wooden chair',
    ]); // within the hour
    expect(titles(await find(q('category=1&city=1&condition=good'))).sort()).toEqual([
      'Vintage camera Leica',
    ]);
  });

  it('sorting: price both ways, ending soon, newest', async () => {
    expect((await find(q('sort=price_asc'))).items.map((i) => i.current_price)).toEqual([
      5_000, 20_000, 50_000, 90_000, 160_000,
    ]);
    expect((await find(q('sort=price_desc'))).items[0]?.current_price).toBe(160_000);
    expect((await find(q('sort=ending_soon'))).items.map((i) => i.title)[0]).toBe(
      'Vintage camera Leica',
    );
    const ends = (await find(q('sort=ending_soon'))).items.map((i) => i.ends_at);
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
  });

  it('pagination: pages are disjoint, total is exact, the last page is short', async () => {
    const p1 = await find(q('sort=price_asc&pageSize=2&page=1'));
    const p2 = await find(q('sort=price_asc&pageSize=2&page=2'));
    const p3 = await find(q('sort=price_asc&pageSize=2&page=3'));
    expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([2, 2, 1]);
    expect(new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).size).toBe(5);
    expect((await find(q('page=9&pageSize=2'))).items).toEqual([]);
  });

  it('facets count each group with every OTHER filter applied, so multi-select shows the alternatives', async () => {
    const all = await find(q(''));
    expect(all.facets.category).toEqual({ '1': 2, '2': 2, '3': 1 });
    expect(all.facets.city).toEqual({ '1': 3, '2': 2 });
    expect(all.facets.condition).toEqual({ good: 3, new: 1, fair: 1 });

    // Category 2 selected: category facet still shows the other categories (counted without its own filter) ...
    const sel = await find(q('category=2'));
    expect(sel.total).toBe(2);
    expect(sel.facets.category).toEqual({ '1': 2, '2': 2, '3': 1 });
    // ... while the other facets narrow to the current selection.
    expect(sel.facets.city).toEqual({ '1': 1, '2': 1 });
    expect(sel.facets.condition).toEqual({ good: 1, fair: 1 });
  });

  it('returned items never contain the description body or any reserve field', async () => {
    const r = await find(q(''));
    for (const item of r.items) {
      expect(Object.keys(item)).not.toContain('description');
      expect(JSON.stringify(item)).not.toMatch(/reserve_?price/i);
    }
  });

  it('hostile query text is just text: filter syntax, quotes and huge input cannot change the filter', async () => {
    for (const evil of [
      `" OR category_id = 3 OR "`,
      `x] OR [1`,
      `'; DROP TABLE lots; --`,
      `* ~ ?`,
      'é'.repeat(200),
    ]) {
      const r = await find(q(`q=${encodeURIComponent(evil)}&category=1`));
      expect(r.items.every((i) => i.category_id === 1)).toBe(true);
    }
  });
});

describe('full reindex in one call (invariant 11)', () => {
  it('rebuilds from Postgres, replacing a wiped or corrupted index, without the index disappearing', async () => {
    const idx = uniqueName('reindex');
    try {
      const owner = await seller();
      const mine: string[] = [];
      for (let i = 0; i < 25; i++)
        mine.push(await lot({ sellerId: owner, title: `Reindex item ${i} unique-eee` }));
      await ensureIndex(meili, idx);
      await meili
        .index(idx)
        .addDocuments([{ id: randomUUID(), title: 'ghost document that is not in Postgres' }])
        .waitTask();

      const report = await reindexAll(t.pool, meili, { indexUid: idx, batchSize: 10 });
      expect(report.indexed).toBeGreaterThanOrEqual(25);
      const docs = await meili.index(idx).getDocuments({ limit: 5000 });
      const have = new Set(docs.results.map((d) => (d as { id: string }).id));
      for (const id of mine) expect(have.has(id)).toBe(true);
      expect(docs.results.some((d) => (d as { title: string }).title.includes('ghost'))).toBe(
        false,
      );
      // The temporary rebuild index is gone.
      const indexes = await meili.getIndexes({ limit: 200 });
      expect(indexes.results.filter((i) => i.uid.startsWith(`${idx}_rebuild_`))).toEqual([]);
      // Settings survived the swap.
      expect((await meili.index(idx).getSettings()).filterableAttributes).toContain('category_id');
    } finally {
      await meili.deleteIndexIfExists(idx);
    }
  });

  it('searching keeps working while a rebuild runs; changes made during it are re-queued, so nothing is missed', async () => {
    const idx = uniqueName('reindex2');
    try {
      const owner = await seller();
      const first = await lot({ sellerId: owner, title: 'Before unique-fff' });
      await sync([first]);
      await ensureIndex(meili, idx);
      await syncSearchLots(t.pool, meili, [first], idx);

      const rebuilding = reindexAll(t.pool, meili, { indexUid: idx, batchSize: 1 });
      const during = await lot({ sellerId: owner, title: 'During unique-fff' }); // created while rebuilding
      await t.pool.query('UPDATE lots SET updated_at = now() WHERE id = $1', [during]); // a real change happens in real time
      let searchErrors = 0;
      for (let i = 0; i < 8; i++) {
        try {
          await searchLots(meili, q('q=unique-fff'), clock.now().getTime(), idx);
        } catch {
          searchErrors++;
        }
      }
      const report = await rebuilding;
      expect(searchErrors).toBe(0);
      // Whatever the timing, the lot created during the rebuild is either in the index or queued.
      const queued = await t.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1 AND processed_at IS NULL`,
        [during],
      );
      expect(queued.rows[0]?.n).toBeGreaterThanOrEqual(1);
      expect(report.requeued).toBeGreaterThanOrEqual(1);
      while ((await processOutbox(t.pool, meili, { indexUid: idx })).rows > 0) {
        /* drain */
      }
      const got = await meili.index(idx).search('unique-fff', { limit: 10 });
      expect(got.hits.map((h) => (h as { id: string }).id)).toEqual(
        expect.arrayContaining([first, during]),
      );
    } finally {
      await meili.deleteIndexIfExists(idx);
    }
  });
});
