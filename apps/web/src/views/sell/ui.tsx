'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { ITEM_CONDITIONS } from '@auction/shared';
import {
  getMeControllerLotsQueryKey,
  meControllerLots,
  sellerControllerCreate,
  sellerControllerPresign,
  sellerControllerSubmit,
  useAuthControllerMe,
  useCatalogControllerCategories,
  useCatalogControllerCities,
} from '../../shared/api/generated/client';
import { useErrorText } from '../../shared/lib/errors';
import { amountProblem } from '../../shared/lib/money';

const toKop = (v: string): number =>
  Math.round(Number(v.replace(/\s/g, '').replace(',', '.')) * 100);

/** Seller: create a lot, add photos (straight to storage), send it for review, see my lots. */
export const SellView = () => {
  const t = useTranslations('sell');
  const f = useTranslations('fields');
  const locale = useLocale();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const me = useAuthControllerMe({ query: { retry: false } });
  const cats = useCatalogControllerCategories();
  const cities = useCatalogControllerCities();
  const mine = useQuery({
    queryKey: getMeControllerLotsQueryKey(),
    queryFn: () => meControllerLots(),
    enabled: me.data?.role === 'user',
  });
  const [v, setV] = useState({
    title: '',
    description: '',
    categoryId: '1',
    cityId: '1',
    condition: 'good',
    startPrice: '',
    reservePrice: '',
    buyNowPrice: '',
    durationDays: '7',
  });
  const [lotId, setLotId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const name = (o: { nameUk: string; nameEn: string; namePl: string }) =>
    locale === 'uk' ? o.nameUk : locale === 'pl' ? o.namePl : o.nameEn;
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () => {
      const bad =
        amountProblem(v.startPrice, 1, 10_000_000_000) ??
        (v.reservePrice ? amountProblem(v.reservePrice, 1, 10_000_000_000) : null) ??
        (v.buyNowPrice ? amountProblem(v.buyNowPrice, 1, 10_000_000_000) : null);
      if (bad) {
        setProblem(f(bad as 'generic'));
        return Promise.reject(new Error(bad));
      }
      setProblem('');
      return sellerControllerCreate({
        title: v.title,
        description: v.description,
        categoryId: Number(v.categoryId),
        cityId: Number(v.cityId),
        condition: v.condition as (typeof ITEM_CONDITIONS)[number],
        startPrice: toKop(v.startPrice),
        reservePrice: v.reservePrice ? toKop(v.reservePrice) : null,
        buyNowPrice: v.buyNowPrice ? toKop(v.buyNowPrice) : null,
        durationDays: Number(v.durationDays),
      });
    },
    onSuccess: (r) => {
      setLotId(r.lotId);
      setNote(t('created'));
      void qc.invalidateQueries({ queryKey: getMeControllerLotsQueryKey() });
    },
  });
  const submit = useMutation({
    mutationFn: () => sellerControllerSubmit(lotId as string),
    onSuccess: () => {
      setNote(t('submitted'));
      setLotId(null);
      void qc.invalidateQueries({ queryKey: getMeControllerLotsQueryKey() });
    },
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const type = file.type as 'image/jpeg' | 'image/png' | 'image/webp';
      const ticket = await sellerControllerPresign(lotId as string, {
        contentType: type,
        size: file.size,
      });
      const form = new FormData();
      for (const [k, val] of Object.entries(ticket.upload.fields)) form.append(k, val);
      form.append('file', file);
      const res = await fetch(ticket.upload.url, { method: 'POST', body: form });
      if (!res.ok) throw new Error(`upload ${res.status}`);
    },
    onSuccess: () => setNote(t('uploaded')),
  });

  if (me.data?.role !== 'user') return <p className="p-4">{t('myLots')}: —</p>;
  const field = (id: keyof typeof v, label: string, type = 'text') => (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={v[id]}
        onChange={set(id)}
        className="mt-1 w-full rounded border px-3 py-2"
      />
    </div>
  );
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="space-y-3"
        noValidate
      >
        {field('title', t('name'))}
        <div>
          <label htmlFor="description" className="block text-sm font-medium">
            {t('description')}
          </label>
          <textarea
            id="description"
            value={v.description}
            onChange={set('description')}
            rows={4}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="categoryId" className="block text-sm font-medium">
              {t('category')}
            </label>
            <select
              id="categoryId"
              value={v.categoryId}
              onChange={set('categoryId')}
              className="mt-1 w-full rounded border px-2 py-2"
            >
              {cats.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cityId" className="block text-sm font-medium">
              {t('city')}
            </label>
            <select
              id="cityId"
              value={v.cityId}
              onChange={set('cityId')}
              className="mt-1 w-full rounded border px-2 py-2"
            >
              {cities.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {name(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="condition" className="block text-sm font-medium">
              {t('condition')}
            </label>
            <select
              id="condition"
              value={v.condition}
              onChange={set('condition')}
              className="mt-1 w-full rounded border px-2 py-2"
            >
              {ITEM_CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {t(c)}
                </option>
              ))}
            </select>
          </div>
          {field('durationDays', t('days'), 'number')}
          {field('startPrice', t('startPrice'))}
          {field('reservePrice', t('reserve'))}
          {field('buyNowPrice', t('buyNow'))}
        </div>
        <p role="alert" className="text-sm text-red-600">
          {problem || (create.error && !problem ? errorText(create.error) : '')}
        </p>
        <button
          type="submit"
          disabled={create.isPending}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {t('create')}
        </button>
      </form>
      {note ? (
        <p role="status" className="rounded bg-green-100 p-3">
          {note}
        </p>
      ) : null}
      {lotId ? (
        <section className="space-y-3 rounded border p-4">
          <label htmlFor="photo" className="block text-sm font-medium">
            {t('photos')}
          </label>
          <input
            id="photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload.mutate(file);
            }}
          />
          <p role="alert" className="text-sm text-red-600">
            {upload.error ? errorText(upload.error) : ''}
          </p>
          <button
            onClick={() => submit.mutate()}
            className="rounded bg-green-600 px-4 py-2 text-white"
          >
            {t('submit')}
          </button>
        </section>
      ) : null}
      <section>
        <h2 className="text-lg font-semibold">{t('myLots')}</h2>
        {mine.data?.items.length === 0 ? <p>{t('empty')}</p> : null}
        <ul className="divide-y">
          {mine.data?.items.map((l) => (
            <li key={String(l['id'])} className="flex justify-between py-1">
              <span>{String(l['title'])}</span>
              <span>
                {t('status')}: {String(l['status'])}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
