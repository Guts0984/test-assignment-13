'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { SEARCH_SORTS, searchQuerySchema } from '@auction/shared';
import {
  useCatalogControllerSearch,
  useCatalogControllerCategories,
  useCatalogControllerCities,
} from '../../shared/api/generated/client';
import { useFieldText } from '../../shared/lib/errors';
import { parseMoneyInput, useMoney } from '../../shared/lib/money';

const MAX_PRICE = 10_000_000_000;
const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'for_parts'] as const;

/** Filters, sort and page live in the URL, so reload and Back give the same screen. */
export const SearchView = () => {
  const t = useTranslations('search');
  const sellT = useTranslations('sell');
  const fieldText = useFieldText();
  const [priceError, setPriceError] = useState('');
  const locale = useLocale();
  const money = useMoney();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const parsed = searchQuerySchema.safeParse(Object.fromEntries(sp.entries()));
  const params = Object.fromEntries(sp.entries());
  const result = useCatalogControllerSearch(params, { query: { enabled: parsed.success } });
  const categories = useCatalogControllerCategories();
  const cities = useCatalogControllerCities();
  const cityNames = new Map(
    (cities.data ?? []).map((c) => [
      String(c.id),
      locale === 'uk' ? c.nameUk : locale === 'pl' ? c.namePl : c.nameEn,
    ]),
  );
  const names = new Map(
    (categories.data ?? []).map((c) => [
      String(c.id),
      locale === 'uk' ? c.nameUk : locale === 'pl' ? c.namePl : c.nameEn,
    ]),
  );
  /** Writes several params at once, keeping every other one; no history entry when nothing changed. */
  const setMany = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    if (next.toString() === sp.toString()) return;
    router.push(`${path}?${next.toString()}`);
  };
  const set = (key: string, value: string | null) => setMany({ [key]: value });
  const toggleIn = (key: 'category' | 'city' | 'condition', id: string) => {
    const cur = new Set((sp.get(key) ?? '').split(',').filter(Boolean));
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    set(key, [...cur].join(','));
  };
  const applyPrice = (form: HTMLFormElement) => {
    const read = (name: string): string => {
      const el = form.elements.namedItem(name);
      return el instanceof HTMLInputElement ? el.value.trim() : '';
    };
    const lo = read('priceMin');
    const hi = read('priceMax');
    const kopecks = (raw: string): number | null | 'bad' =>
      raw === '' ? null : (parseMoneyInput(raw) ?? 'bad');
    const min = kopecks(lo);
    const max = kopecks(hi);
    if (min === 'bad' || max === 'bad') return setPriceError(fieldText('NOT_A_NUMBER'));
    if ((min ?? 0) > MAX_PRICE || (max ?? 0) > MAX_PRICE)
      return setPriceError(fieldText('MONEY_TOO_LARGE'));
    if (min !== null && max !== null && min > max)
      return setPriceError(fieldText('PRICE_RANGE_INVERTED'));
    setPriceError('');
    setMany({
      priceMin: min === null ? null : String(min),
      priceMax: max === null ? null : String(max),
    });
  };
  const uah = (kopecksParam: string | null): string =>
    kopecksParam && /^\d+$/.test(kopecksParam) ? String(Number(kopecksParam) / 100) : '';
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
              if (e.key === 'Enter' && e.currentTarget.value.trim() !== (sp.get('q') ?? ''))
                set('q', e.currentTarget.value);
            }}
            onBlur={(e) => {
              if (e.currentTarget.value.trim() !== (sp.get('q') ?? ''))
                set('q', e.currentTarget.value);
            }}
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
        <form
          key={`${sp.get('priceMin') ?? ''}-${sp.get('priceMax') ?? ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            applyPrice(e.currentTarget);
          }}
          className="space-y-2"
          noValidate
        >
          <label htmlFor="priceMin" className="block text-sm font-medium">
            {t('priceMin')}
          </label>
          <input
            id="priceMin"
            name="priceMin"
            inputMode="decimal"
            defaultValue={uah(sp.get('priceMin'))}
            aria-invalid={priceError ? true : undefined}
            aria-describedby="price-error"
            className="w-full rounded border px-3 py-2"
          />
          <label htmlFor="priceMax" className="block text-sm font-medium">
            {t('priceMax')}
          </label>
          <input
            id="priceMax"
            name="priceMax"
            inputMode="decimal"
            defaultValue={uah(sp.get('priceMax'))}
            aria-invalid={priceError ? true : undefined}
            aria-describedby="price-error"
            className="w-full rounded border px-3 py-2"
          />
          <p id="price-error" role="alert" className="text-sm text-red-600">
            {priceError}
          </p>
          <button type="submit" className="rounded border px-3 py-1">
            {t('apply')}
          </button>
        </form>
        <fieldset>
          <legend className="text-sm font-medium">{t('category')}</legend>
          {Object.entries(result.data?.facets.category ?? {}).map(([id, n]) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(sp.get('category') ?? '').split(',').includes(id)}
                onChange={() => toggleIn('category', id)}
              />{' '}
              {names.get(id) ?? id} <span className="text-gray-500">({n})</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">{t('city')}</legend>
          {Object.entries(result.data?.facets.city ?? {}).map(([id, n]) => (
            <label key={id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(sp.get('city') ?? '').split(',').includes(id)}
                onChange={() => toggleIn('city', id)}
              />{' '}
              {cityNames.get(id) ?? id} <span className="text-gray-500">({n})</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">{t('condition')}</legend>
          {CONDITIONS.filter((c) => (result.data?.facets.condition[c] ?? 0) > 0).map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={(sp.get('condition') ?? '').split(',').includes(c)}
                onChange={() => toggleIn('condition', c)}
              />{' '}
              {sellT(c)} <span className="text-gray-500">({result.data?.facets.condition[c]})</span>
            </label>
          ))}
        </fieldset>
      </aside>
      <section aria-live="polite">
        {!parsed.success ? (
          <p
            role="alert"
            data-testid="invalid-params"
            className="rounded bg-red-50 p-3 text-red-700"
          >
            {t('invalidParams')}{' '}
            <Link href={path} className="underline">
              {t('resetFilters')}
            </Link>
          </p>
        ) : null}
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
              <p className="text-sm text-gray-500">{names.get(String(l.category_id))}</p>
              <p>{money(l.current_price)}</p>
              <p className="text-sm text-gray-600">{t('bids', { count: l.bid_count })}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex gap-3">
          <button
            aria-label={t('prevPage')}
            disabled={page <= 1}
            onClick={() => set('page', String(page - 1))}
            className="rounded border px-3 py-1 disabled:opacity-40"
          >
            ‹
          </button>
          <button
            aria-label={t('nextPage')}
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
