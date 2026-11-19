import { z } from 'zod';

/**
 * Money is always hryvnia in kopecks, stored and transported as an integer.
 * 1 ₴ = 100 kopecks. Never a float, never a string with a decimal point.
 */
export type Kopecks = number;

/** Upper bound for any single amount: 100 000 000 ₴. Keeps every product below 2^53. */
export const MAX_AMOUNT_KOP = 10_000_000_000;

export const UAH = (hryvnias: number): Kopecks => Math.round(hryvnias * 100);

export const isKopecks = (value: unknown): value is Kopecks =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_KOP;

/** Zod schema for a non-negative integer amount in kopecks. */
export const kopecksSchema = z
  .number({ error: 'MONEY_NOT_A_NUMBER' })
  .int({ error: 'MONEY_NOT_INTEGER_KOPECKS' })
  .min(0, { error: 'MONEY_NEGATIVE' })
  .max(MAX_AMOUNT_KOP, { error: 'MONEY_TOO_LARGE' });

/** Strictly positive amount (bids, top-ups, prices). */
export const positiveKopecksSchema = kopecksSchema.min(1, { error: 'MONEY_NOT_POSITIVE' });

/** Integer percentage of an amount, rounded down. Integer math only. */
export const percentFloor = (amount: Kopecks, percent: number): Kopecks =>
  Math.floor((amount * percent) / 100);

/** Integer percentage of an amount, rounded up. Integer math only. */
export const percentCeil = (amount: Kopecks, percent: number): Kopecks =>
  Math.ceil((amount * percent) / 100);

export type AppLocale = 'uk' | 'en' | 'pl';

const LOCALE_TAGS: Record<AppLocale, string> = { uk: 'uk-UA', en: 'en-GB', pl: 'pl-PL' };

const formatterCache = new Map<string, Intl.NumberFormat>();

const moneyFormatter = (locale: AppLocale): Intl.NumberFormat => {
  const key = `money:${locale}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(LOCALE_TAGS[locale], {
    style: 'currency',
    currency: 'UAH',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  formatterCache.set(key, created);
  return created;
};

/**
 * Formats kopecks for display: uk → "1 234,50 ₴", en → "₴1,234.50", pl → "1234,50 ₴".
 * Separators are the locale's own (uk uses a narrow no-break space for grouping).
 */
export const formatMoney = (amount: Kopecks, locale: AppLocale): string => {
  // Division by 100 of a safe integer is exact enough for 2 fraction digits at this magnitude.
  return moneyFormatter(locale).format(amount / 100);
};

const MONEY_INPUT = /^(\d{1,9})(?:[.,](\d{1,2}))?$/;

/**
 * Parses user input like "1 234,50", "1234.5", "1 234" into kopecks.
 * Returns null for anything that is not a plain non-negative amount with ≤ 2 decimals.
 */
// `\s` covers the no-break (U+00A0) and narrow no-break (U+202F) spaces Intl uses for grouping.
export const parseMoneyInput = (raw: string): Kopecks | null => {
  const compact = raw.replace(/\s/g, '').replace(/₴$/, '');
  const match = MONEY_INPUT.exec(compact);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = match[2] ? Number(match[2].padEnd(2, '0')) : 0;
  const value = whole * 100 + fraction;
  return isKopecks(value) ? value : null;
};
