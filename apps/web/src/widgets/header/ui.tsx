'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  authControllerLogout,
  getAuthControllerMeQueryKey,
  useAuthControllerMe,
} from '../../shared/api/generated/client';

const LOCALES = ['uk', 'en', 'pl'] as const;

export const Header = () => {
  const t = useTranslations('nav');
  const locale = useLocale();
  const path = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useAuthControllerMe({ query: { retry: false } });
  const swap = (l: string) => path.replace(/^\/(uk|en|pl)/, `/${l}`);
  const logout = async () => {
    await authControllerLogout();
    qc.removeQueries();
    await qc.invalidateQueries({ queryKey: getAuthControllerMeQueryKey() });
    router.push(`/${locale}`);
  };
  const role = me.data?.role;
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
          </>
        ) : null}
        {role === 'finance' ? <Link href={`/${locale}/finance`}>{t('finance')}</Link> : null}
        {role === 'moderator' ? (
          <Link href={`/${locale}/moderation`}>{t('moderation')}</Link>
        ) : null}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        {LOCALES.map((l) => (
          <a
            key={l}
            href={swap(l)}
            aria-current={l === locale ? 'true' : undefined}
            className={l === locale ? 'font-bold underline' : ''}
          >
            {l.toUpperCase()}
          </a>
        ))}
        {me.data ? (
          <>
            <span data-testid="whoami" className="rounded bg-green-100 px-2 py-1 text-sm">
              {me.data.displayName} · {role}
            </span>
            <button onClick={() => void logout()} className="rounded border px-3 py-1">
              {t('logout')}
            </button>
          </>
        ) : (
          <Link href={`/${locale}/login`}>{t('login')}</Link>
        )}
      </div>
    </header>
  );
};
