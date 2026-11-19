'use client';
import { formatMoney, parseMoneyInput, type AppLocale } from '@auction/shared';
import { useLocale } from 'next-intl';

/** Money in the viewer's locale: `1 234,50 ₴` (uk), `₴1,234.50` (en), `1234,50 ₴` (pl). */
export const useMoney = (): ((kopecks: number) => string) => {
  const locale = useLocale() as AppLocale;
  return (kopecks) => formatMoney(kopecks, locale);
};
export { parseMoneyInput };
