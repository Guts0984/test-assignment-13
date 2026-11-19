'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SEARCH_SORTS, searchQuerySchema } from '@auction/shared';
import {
  useCatalogControllerSearch,
  useCatalogControllerCategories,
} from '../../shared/api/generated/client';
import { useMoney } from '../../shared/lib/money';

/** Filters, sort and page live in the URL, so reload and Back give the same screen. */
export const SearchView = () => {
  const t = useTranslations('search');
  const locale = useLocale();
  const money = useMoney();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const parsed = searchQuerySchema.safeParse(Object.fromEntries(sp.entries()));
  const params = Object.fromEntries(sp.entries());
  const result = useCatalogControllerSearch(params, { query: { enabled: parsed.success } });
  const categories = useCatalogControllerCategories();
  const names = new Map(
    (categories.data ?? []).map((c) => [
      String(c.id),
      locale === 'uk' ? c.nameUk : locale === 'pl' ? c.namePl : c.nameEn,
    ]),
  );
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(sp.toString());
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    router.push(`${path}?${next.toString()}`);
  };
  const toggleCategory = (id: string) => {
    const cur = new Set((sp.get('category') ?? '').split(',').filter(Boolean));
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    set('category', [...cur].join(','));
  };
  const page = Number(sp.get('page') ?? '1');
  return (
    <div className="grid gap-6 p-4 md:grid-cols-[16rem_1fr]">
      <aside className="space-y-4">
        <div>
          <label htmlFor="q" className="block text-sm font-medium">
            {t('q')}
          </label>
          <input
            id="q"
            defaultValue={sp.get('q') ?? ''}
            className="mt-1 w-full rounded border px-3 py-2"
            onKeyDown={(e) => {
              if (e.key === 'Enter') set('q', e.currentTarget.value);
            }}
            onBlur={(e) => set('q', e.currentTarget.value)}
          />
        </div>
        <div>
          <label htmlFor="sort" className="block text-sm font-medium">
            {t('sort')}
          </label>
          <select
            id="sort"
            value={sp.get('sort') ?? 'relevance'}
            onChange={(e) => set('sort', e.target.value)}
            className="mt-1 w-full rounded border px-2 py-2"
          >
            {SEARCH_SORTS.map((s) => (
              <option key={s} value={s}>
                {t(
                  s === 'ending_soon'
                    ? 'endingSoon'
                    : s === 'price_asc'
                      ? 'priceAsc'
                      : s === 'price_desc'
                        ? 'priceDesc'
                        : s,
                )}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={sp.get('noBids') === 'true'}
            onChange={(e) => set('noBids', e.target.checked ? 'true' : null)}
          />{' '}
          {t('noBids')}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={sp.get('endingSoon') === 'true'}
            onChange={(e) => set('endingSoon', e.target.checked ? 'true' : null)}
          />{' '}
          {t('endingSoonOnly')}
        </label>
        <fieldset>
          <legend className="text-sm font-medium">{t('category')}</legend>
          {Object.entries(result.data?.facets.category ?? {}).map(([id, n]) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(sp.get('category') ?? '').split(',').includes(id)}
                onChange={() => toggleCategory(id)}
              />{' '}
              {names.get(id) ?? id} <span className="text-gray-500">({n})</span>
            </label>
          ))}
        </fieldset>
      </aside>
      <section aria-live="polite">
        {result.isError ? (
          <p role="alert" className="rounded bg-red-50 p-3 text-red-700">
            {t('error')}
          </p>
        ) : null}
        {result.data ? (
          <p className="mb-3 text-sm text-gray-600">{t('found', { count: result.data.total })}</p>
        ) : null}
        {result.data?.items.length === 0 ? <p>{t('empty')}</p> : null}
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {result.data?.items.map((l) => (
            <li key={l.id} className="rounded border p-3">
              <Link href={`/${locale}/lots/${l.id}`} className="font-medium underline">
                {l.title}
              </Link>
              <p>{money(l.current_price)}</p>
              <p className="text-sm text-gray-600">{t('bids', { count: l.bid_count })}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex gap-3">
          <button
            disabled={page <= 1}
            onClick={() => set('page', String(page - 1))}
            className="rounded border px-3 py-1 disabled:opacity-40"
          >
            ‹
          </button>
          <button
            disabled={!result.data || page * (result.data.pageSize || 24) >= result.data.total}
            onClick={() => set('page', String(page + 1))}
            className="rounded border px-3 py-1 disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </section>
    </div>
  );
};
