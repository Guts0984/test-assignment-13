import { getRequestConfig } from 'next-intl/server';

export const LOCALES = ['uk', 'en', 'pl'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'uk';

export default getRequestConfig(async ({ requestLocale }) => {
  const asked = await requestLocale;
  const locale = (LOCALES as readonly string[]).includes(asked ?? '')
    ? (asked as Locale)
    : DEFAULT_LOCALE;
  return {
    locale,
    messages: (
      (await import(`../../../messages/${locale}.json`)) as { default: Record<string, unknown> }
    ).default,
  };
});
