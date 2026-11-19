import type { Pool } from '@auction/db';
import { ENDING_SOON_MS, appError, type SearchQuery } from '@auction/shared';
import { Meilisearch, type Index, type MultiSearchQuery } from 'meilisearch';

/**
 * Search = a read-only projection of Postgres. Only ACTIVE lots are indexed, and the document is
 * built by `toDoc()` below from an explicit column list: it never selects the reserve price (it
 * only learns "met / not met" from a computed boolean), so the reserve cannot leak into the index
 * however the mapper is changed later.
 */

export const LOTS_INDEX = 'lots';

export type SearchDoc = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category_id: number;
  readonly city_id: number;
  readonly condition: string;
  /** kopecks */
  readonly current_price: number;
  readonly bid_count: number;
  readonly has_bids: boolean;
  /** epoch seconds (Meilisearch filters on numbers) */
  readonly ends_at: number;
  readonly created_at: number;
  /** null = the lot has no reserve; otherwise only whether it is met */
  readonly reserve_met: boolean | null;
  readonly photo: string | null;
};

export const INDEX_SETTINGS = {
  searchableAttributes: ['title', 'description'],
  filterableAttributes: [
    'category_id',
    'city_id',
    'condition',
    'current_price',
    'has_bids',
    'ends_at',
  ],
  sortableAttributes: ['current_price', 'ends_at', 'created_at'],
  displayedAttributes: [
    'id',
    'title',
    'description',
    'category_id',
    'city_id',
    'condition',
    'current_price',
    'bid_count',
    'has_bids',
    'ends_at',
    'created_at',
    'reserve_met',
    'photo',
  ],
  pagination: { maxTotalHits: 20_000 },
  faceting: { maxValuesPerFacet: 100, sortFacetValuesBy: { '*': 'count' as const } },
};

export const createMeili = (host: string, apiKey: string): Meilisearch =>
  new Meilisearch({ host, apiKey, timeout: 4000 });

type DocRow = {
  id: string;
  title: string;
  description: string;
  category_id: number;
  city_id: number;
  condition: string;
  current_price: number;
  bid_count: number;
  ends_at: Date;
  created_at: Date;
  reserve_met: boolean | null;
  photo: string | null;
};

// The explicit column list is the whitelist. `reserve_price` appears only inside a computed flag.
const DOC_SQL = `
  SELECT l.id, l.title, l.description, l.category_id, l.city_id, l.condition, l.current_price,
         l.bid_count, l.ends_at, l.created_at,
         CASE WHEN l.reserve_price IS NULL THEN NULL
              ELSE (l.bid_count > 0 AND l.current_price >= l.reserve_price) END AS reserve_met,
         (SELECT p.preview_key FROM lot_photos p
           WHERE p.lot_id = l.id AND p.status = 'ready' ORDER BY p.position LIMIT 1) AS photo
    FROM lots l
   WHERE l.status = 'active' AND l.id = ANY($1::uuid[])`;

const toDoc = (r: DocRow): SearchDoc => ({
  id: r.id,
  title: r.title,
  description: r.description,
  category_id: r.category_id,
  city_id: r.city_id,
  condition: r.condition,
  current_price: r.current_price,
  bid_count: r.bid_count,
  has_bids: r.bid_count > 0,
  ends_at: Math.floor(r.ends_at.getTime() / 1000),
  created_at: Math.floor(r.created_at.getTime() / 1000),
  reserve_met: r.reserve_met,
  photo: r.photo,
});

export const loadDocs = async (pool: Pool, lotIds: readonly string[]): Promise<SearchDoc[]> => {
  if (lotIds.length === 0) return [];
  const { rows } = await pool.query<DocRow>(DOC_SQL, [lotIds]);
  return rows.map(toDoc);
};

const unavailable = (e: unknown) =>
  appError('SEARCH_UNAVAILABLE', 'search is temporarily unavailable', {
    meta: { cause: e instanceof Error ? e.name : 'unknown' },
  });

const isNotFound = (e: unknown): boolean =>
  (e as { cause?: { code?: string } }).cause?.code === 'index_not_found' ||
  (e as { code?: string }).code === 'index_not_found';

/** Creates the index with its settings if it does not exist yet. Idempotent. */
export const ensureIndex = async (
  meili: Meilisearch,
  uid = LOTS_INDEX,
): Promise<Index<SearchDoc>> => {
  try {
    await meili.getIndex(uid);
  } catch (e) {
    if (!isNotFound(e)) throw e;
    await meili.createIndex(uid, { primaryKey: 'id' }).waitTask({ timeout: 20_000 });
  }
  const index = meili.index<SearchDoc>(uid);
  await index.updateSettings(INDEX_SETTINGS).waitTask({ timeout: 20_000 });
  return index;
};

export type SyncReport = { readonly upserted: number; readonly deleted: number };

/**
 * Brings the index in line with Postgres for these lots: active ones are upserted from their
 * CURRENT row, everything else (closed, removed, never public) is deleted. Because it always
 * reads the current state, duplicate or out-of-order calls converge to the same result.
 */
export const syncSearchLots = async (
  pool: Pool,
  meili: Meilisearch,
  lotIds: readonly string[],
  indexUid = LOTS_INDEX,
): Promise<SyncReport> => {
  const ids = [...new Set(lotIds)];
  if (ids.length === 0) return { upserted: 0, deleted: 0 };
  const docs = await loadDocs(pool, ids);
  const live = new Set(docs.map((d) => d.id));
  const gone = ids.filter((id) => !live.has(id));
  const index = meili.index<SearchDoc>(indexUid);
  if (docs.length > 0)
    await index.addDocuments([...docs], { primaryKey: 'id' }).waitTask({ timeout: 20_000 });
  if (gone.length > 0) await index.deleteDocuments(gone).waitTask({ timeout: 20_000 });
  return { upserted: docs.length, deleted: gone.length };
};

export type OutboxReport = { readonly rows: number; readonly lots: number };

/**
 * Consumes `outbox` rows (written by the domain in the same transaction as the lot change).
 * Rows are claimed with FOR UPDATE SKIP LOCKED, so several workers split the work and never
 * process one row twice. They are marked processed only AFTER Meilisearch accepted the change:
 * if Meilisearch is down, the transaction rolls back and the rows simply wait.
 * `afterSync` lets the caller piggy-back other per-lot work on the same batch (photo publishing).
 */
export const processOutbox = async (
  pool: Pool,
  meili: Meilisearch,
  options: {
    batch?: number;
    afterSync?: (lotIds: readonly string[]) => Promise<void>;
    now?: () => Date;
    indexUid?: string;
  } = {},
): Promise<OutboxReport> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number; aggregate_id: string | null }>(
      `SELECT id, aggregate_id FROM outbox
        WHERE processed_at IS NULL AND topic = 'lot.upsert'
        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [options.batch ?? 200],
    );
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { rows: 0, lots: 0 };
    }
    const lotIds = [...new Set(rows.flatMap((r) => (r.aggregate_id ? [r.aggregate_id] : [])))];
    await syncSearchLots(pool, meili, lotIds, options.indexUid);
    if (options.afterSync) await options.afterSync(lotIds);
    await client.query(`UPDATE outbox SET processed_at = $2 WHERE id = ANY($1::bigint[])`, [
      rows.map((r) => r.id),
      (options.now ?? (() => new Date()))(),
    ]);
    await client.query('COMMIT');
    return { rows: rows.length, lots: lotIds.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

export type ReindexReport = {
  readonly indexed: number;
  readonly requeued: number;
  readonly ms: number;
};

/**
 * Full rebuild with no downtime: build a NEW index from Postgres, then swap it with the live one
 * atomically. Lots that changed while the rebuild ran are re-queued through the outbox, so the new
 * index converges even for changes it missed.
 */
export const reindexAll = async (
  pool: Pool,
  meili: Meilisearch,
  options: { batchSize?: number; indexUid?: string } = {},
): Promise<ReindexReport> => {
  const started = Date.now();
  const live = options.indexUid ?? LOTS_INDEX;
  const batchSize = options.batchSize ?? 1000;
  const tmp = `${live}_rebuild_${started}`;
  await ensureIndex(meili, live); // the swap needs both to exist
  const fresh = await ensureIndex(meili, tmp);

  let after = '00000000-0000-0000-0000-000000000000';
  let indexed = 0;
  for (;;) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM lots WHERE status = 'active' AND id > $1 ORDER BY id LIMIT $2`,
      [after, batchSize],
    );
    if (rows.length === 0) break;
    const docs = await loadDocs(
      pool,
      rows.map((r) => r.id),
    );
    if (docs.length > 0)
      await fresh.addDocuments(docs, { primaryKey: 'id' }).waitTask({ timeout: 120_000 });
    indexed += docs.length;
    after = rows[rows.length - 1]?.id ?? after;
  }

  await meili.swapIndexes([{ indexes: [live, tmp], rename: false }]).waitTask({ timeout: 60_000 });
  await meili.deleteIndexIfExists(tmp);

  const requeued =
    (
      await pool.query(
        `INSERT INTO outbox (topic, aggregate_id, payload)
       SELECT 'lot.upsert', id, '{}' FROM lots WHERE updated_at >= $1`,
        [new Date(started - 1000)],
      )
    ).rowCount ?? 0;
  return { indexed, requeued, ms: Date.now() - started };
};

// ---------------------------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------------------------

export type FacetCounts = {
  readonly category: Readonly<Record<string, number>>;
  readonly city: Readonly<Record<string, number>>;
  readonly condition: Readonly<Record<string, number>>;
};

export type SearchResult = {
  readonly items: readonly Omit<SearchDoc, 'description'>[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly facets: FacetCounts;
};

const SORTS: Record<SearchQuery['sort'], string[] | undefined> = {
  relevance: undefined,
  ending_soon: ['ends_at:asc'],
  newest: ['created_at:desc'],
  price_asc: ['current_price:asc'],
  price_desc: ['current_price:desc'],
};

type FilterKey = 'category' | 'city' | 'condition' | 'rest';

/** Builds the Meilisearch filter. Only validated numbers and enum strings ever reach it. */
const buildFilters = (q: SearchQuery, nowSec: number): Record<FilterKey, string[]> => {
  const rest: string[] = [];
  if (q.priceMin !== undefined) rest.push(`current_price >= ${Math.trunc(q.priceMin)}`);
  if (q.priceMax !== undefined) rest.push(`current_price <= ${Math.trunc(q.priceMax)}`);
  if (q.noBids) rest.push('has_bids = false');
  if (q.endingSoon)
    rest.push(`ends_at > ${nowSec} AND ends_at <= ${nowSec + Math.floor(ENDING_SOON_MS / 1000)}`);
  // A live lot is only searchable while it is still running.
  rest.push(`ends_at > ${nowSec}`);
  return {
    category: q.category?.length
      ? [`category_id IN [${q.category.map((c) => Math.trunc(c)).join(', ')}]`]
      : [],
    city: q.city?.length ? [`city_id IN [${q.city.map((c) => Math.trunc(c)).join(', ')}]`] : [],
    condition: q.condition?.length
      ? [`condition IN [${q.condition.map((c) => JSON.stringify(c)).join(', ')}]`]
      : [],
    rest,
  };
};

const join = (parts: string[]): string | undefined =>
  parts.length === 0 ? undefined : parts.map((p) => `(${p})`).join(' AND ');

export const searchLots = async (
  meili: Meilisearch,
  query: SearchQuery,
  nowMs: number,
  indexUid = LOTS_INDEX,
): Promise<SearchResult> => {
  const nowSec = Math.floor(nowMs / 1000);
  const f = buildFilters(query, nowSec);
  const all = (without?: FilterKey) =>
    join(
      (['category', 'city', 'condition', 'rest'] as const)
        .filter((k) => k !== without)
        .flatMap((k) => f[k]),
    );

  const common = { indexUid, q: query.q ?? '' } as const;
  const main: MultiSearchQuery = {
    ...common,
    filter: all(),
    sort: SORTS[query.sort],
    page: query.page,
    hitsPerPage: query.pageSize,
    attributesToRetrieve: INDEX_SETTINGS.displayedAttributes.filter((a) => a !== 'description'),
    facets: ['category_id', 'city_id', 'condition'],
  };
  // Facet counts: each facet is counted with every filter EXCEPT its own, so choosing a category
  // still shows how many lots the other categories would give (standard multi-select behaviour).
  const facetQuery = (facet: string, without: FilterKey): MultiSearchQuery => ({
    ...common,
    filter: all(without),
    facets: [facet],
    limit: 0,
  });

  try {
    const res = await meili.multiSearch({
      queries: [
        main,
        facetQuery('category_id', 'category'),
        facetQuery('city_id', 'city'),
        facetQuery('condition', 'condition'),
      ],
    });
    const [m, c, ci, co] = res.results;
    const mainHits = m as unknown as {
      hits: SearchResult['items'];
      totalHits: number;
      page: number;
      hitsPerPage: number;
    };
    const dist = (r: unknown, key: string): Record<string, number> =>
      (r as { facetDistribution?: Record<string, Record<string, number>> } | undefined)
        ?.facetDistribution?.[key] ?? {};
    return {
      items: mainHits.hits,
      total: mainHits.totalHits,
      page: mainHits.page,
      pageSize: mainHits.hitsPerPage,
      facets: {
        category: dist(c, 'category_id'),
        city: dist(ci, 'city_id'),
        condition: dist(co, 'condition'),
      },
    };
  } catch (e) {
    throw unavailable(e);
  }
};

export const searchHealthy = async (meili: Meilisearch): Promise<boolean> => {
  try {
    await meili.health();
    return true;
  } catch {
    return false;
  }
};
