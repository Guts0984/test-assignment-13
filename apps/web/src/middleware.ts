import createMiddleware from 'next-intl/middleware';
import { DEFAULT_LOCALE, LOCALES } from './shared/lib/i18n-request';

export default createMiddleware({
  locales: [...LOCALES],
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: 'always',
});
export const config = {
  matcher: ['/((?!api|_next|photos|upload|provider|docs|socket.io|.*\\..*).*)'],
};
