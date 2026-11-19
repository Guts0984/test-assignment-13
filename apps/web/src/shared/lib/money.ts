'use client';
import { formatMoney, parseMoneyInput, type AppLocale } from '@auction/shared';
import { useLocale } from 'next-intl';

/** Money in the viewer's locale: `1 234,50 ₴` (uk), `₴1,234.50` (en), `1234,50 ₴` (pl). */
export const useMoney = (): ((kopecks: number) => string) => {
  const locale = useLocale() as AppLocale;
  return (kopecks) => formatMoney(kopecks, locale);
};
export { parseMoneyInput };

/** Client-side check of a typed amount. Returns the message key to show, or null when the value is acceptable. */
export const amountProblem = (raw: string, min: number, max: number): string | null => {
  const compact = raw.replace(/\s/g, '').replace(/,/g, '.');
  if (!/^\d+(\.\d+)?$/.test(compact)) return 'NOT_A_NUMBER';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(compact))
    return compact.includes('.') && (compact.split('.')[1] ?? '').length > 2
      ? 'MONEY_NOT_INTEGER_KOPECKS'
      : 'MONEY_TOO_LARGE';
  const kop = Math.round(Number(compact) * 100);
  if (kop > max) return max === 100_000_000 ? 'TOPUP_TOO_LARGE' : 'MONEY_TOO_LARGE';
  if (kop < min) return min === 100 ? 'TOPUP_TOO_SMALL' : 'MONEY_NOT_POSITIVE';
  return null;
};
