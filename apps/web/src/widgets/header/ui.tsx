'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useNotifications } from '../../entities/notification/live';
import {
  authControllerLogout,
  getAuthControllerMeQueryKey,
  useAuthControllerMe,
} from '../../shared/api/generated/client';

const LOCALES = ['uk', 'en', 'pl'] as const;

/** Language links keep the path AND the query string, so switching language keeps filters and page. */
const LocaleSwitch = () => {
  const locale = useLocale();
  const path = usePathname();
  const sp = useSearchParams();
  const qs = sp.toString();
  const swap = (l: string) => `${path.replace(/^\/(uk|en|pl)/, `/${l}`)}${qs ? `?${qs}` : ''}`;
  return (
    <>
      {LOCALES.map((l) => (
        <a
          key={l}
          href={swap(l)}
          hrefLang={l}
          aria-current={l === locale ? 'true' : undefined}
          className={l === locale ? 'font-bold underline' : ''}
        >
          {l.toUpperCase()}
        </a>
      ))}
    </>
  );
};

export const Header = () => {
  const t = useTranslations('nav');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useAuthControllerMe({ query: { retry: false } });
  const logout = async () => {
    await authControllerLogout();
    qc.removeQueries();
    await qc.invalidateQueries({ queryKey: getAuthControllerMeQueryKey() });
    router.push(`/${locale}`);
  };
  const role = me.data?.role;
  const { unread } = useNotifications(Boolean(me.data));
  return (
    <header className="flex flex-wrap items-center gap-4 border-b px-4 py-3">
      <Link href={`/${locale}`} className="font-bold">
        Auction
      </Link>
      <nav className="flex gap-4" aria-label="main">
        <Link href={`/${locale}`}>{t('search')}</Link>
        {role === 'user' ? (
          <>
            <Link href={`/${locale}/wallet`}>{t('wallet')}</Link>
            <Link href={`/${locale}/sell`}>{t('sell')}</Link>
            <Link href={`/${locale}/favorites`}>{t('favorites')}</Link>
          </>
        ) : null}
        {role === 'finance' ? <Link href={`/${locale}/finance`}>{t('finance')}</Link> : null}
        {role === 'moderator' ? (
          <Link href={`/${locale}/moderation`}>{t('moderation')}</Link>
        ) : null}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <Suspense fallback={null}>
          <LocaleSwitch />
        </Suspense>
        {me.data ? (
          <>
            <Link
              href={`/${locale}/notifications`}
              aria-label={t('notificationsUnread', { count: unread })}
              className="relative"
            >
              <span aria-hidden="true">🔔</span>
              {unread > 0 ? (
                <span
                  data-testid="unread-count"
                  className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white"
                >
                  {unread}
                </span>
              ) : null}
            </Link>
            <span data-testid="whoami" className="rounded bg-green-100 px-2 py-1 text-sm">
              {me.data.displayName} · {role}
            </span>
            <button onClick={() => void logout()} className="rounded border px-3 py-1">
              {t('logout')}
            </button>
          </>
        ) : (
          <>
            <Link href={`/${locale}/login`}>{t('login')}</Link>
            <Link href={`/${locale}/register`}>{t('register')}</Link>
          </>
        )}
      </div>
    </header>
  );
};
