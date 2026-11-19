'use client';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { parseFavorites } from '../../entities/favorite/model';
import { useMeControllerFavorites } from '../../shared/api/generated/client';
import { useMoney } from '../../shared/lib/money';

export const FavoritesView = () => {
  const t = useTranslations('favorites');
  const locale = useLocale();
  const money = useMoney();
  const list = useMeControllerFavorites({ query: { retry: false } });
  if (list.isError)
    return (
      <p className="p-4" role="status">
        {t('signin')}
      </p>
    );
  const items = parseFavorites(list.data);
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {list.data && items.length === 0 ? <p>{t('empty')}</p> : null}
      <ul className="divide-y" data-testid="favorites">
        {items.map((f) => (
          <li key={f.id} className="flex justify-between py-2">
            <Link href={`/${locale}/lots/${f.id}`} className="font-medium underline">
              {f.title}
            </Link>
            <span>{money(f.currentPrice)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
