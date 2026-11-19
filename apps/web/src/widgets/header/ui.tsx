'use client';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuthControllerMe } from '../../shared/api/generated/client';

const LOCALES = ['uk', 'en', 'pl'] as const;

export const Header = () => {
  const t = useTranslations('nav');
  const locale = useLocale();
  const path = usePathname();
  const me = useAuthControllerMe({ query: { retry: false } });
  const swap = (l: string) => path.replace(/^\/(uk|en|pl)/, `/${l}`);
  return (
    <header className="flex flex-wrap items-center gap-4 border-b px-4 py-3">
      <Link href={`/${locale}`} className="font-bold">
        Auction
      </Link>
      <nav className="flex gap-4" aria-label="main">
        <Link href={`/${locale}`}>{t('search')}</Link>
        <Link href={`/${locale}/wallet`}>{t('wallet')}</Link>
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
          <span>{me.data.displayName}</span>
        ) : (
          <Link href={`/${locale}/login`}>{t('login')}</Link>
        )}
      </div>
    </header>
  );
};
