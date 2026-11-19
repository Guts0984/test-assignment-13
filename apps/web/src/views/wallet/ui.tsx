'use client';
import { useTranslations } from 'next-intl';
import { TopUpForm } from '../../features/top-up/ui';
import { useMeControllerWallet } from '../../shared/api/generated/client';
import { useMoney } from '../../shared/lib/money';

export const WalletView = () => {
  const t = useTranslations('wallet');
  const money = useMoney();
  const w = useMeControllerWallet({ query: { retry: false } });
  if (w.isError) return <p className="p-4">{t('signin')}</p>;
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <dl className="grid grid-cols-3 gap-3">
        {(
          [
            ['available', w.data?.available],
            ['held', w.data?.held],
            ['balance', w.data?.balance],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded border p-3">
            <dt className="text-sm text-gray-600">{t(k)}</dt>
            <dd className="text-xl font-bold">{v === undefined ? '—' : money(v)}</dd>
          </div>
        ))}
      </dl>
      <TopUpForm />
      <h2 className="text-lg font-semibold">{t('history')}</h2>
      <ul className="divide-y text-sm">
        {w.data?.history.map((h) => (
          <li key={`${h.at}${h.kind}${h.lotId ?? ''}`} className="flex justify-between py-1">
            <span>{h.kind}</span>
            <span>{money(h.availableDelta)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
