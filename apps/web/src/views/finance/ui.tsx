'use client';
import { useTranslations } from 'next-intl';
import { useSearchParams, usePathname, useRouter } from 'next/navigation';
import {
  useAuthControllerMe,
  useFinanceControllerReconciliation,
  useFinanceControllerReport,
} from '../../shared/api/generated/client';
import { useMoney } from '../../shared/lib/money';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Finance: report for a period (the period is in the URL) and the ledger reconciliation. */
export const FinanceView = () => {
  const t = useTranslations('fin');
  const money = useMoney();
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const me = useAuthControllerMe({ query: { retry: false } });
  const to = sp.get('to') ?? iso(new Date());
  const from = sp.get('from') ?? iso(new Date(Date.now() - 89 * 86_400_000));
  const report = useFinanceControllerReport(
    { from, to },
    { query: { enabled: me.data?.role === 'finance' } },
  );
  const recon = useFinanceControllerReconciliation({
    query: { enabled: me.data?.role === 'finance' },
  });
  if (me.data?.role !== 'finance') return <p className="p-4">{t('only')}</p>;
  const setPeriod = (k: 'from' | 'to', v: string) => {
    const n = new URLSearchParams(sp.toString());
    n.set('from', from);
    n.set('to', to);
    n.set(k, v);
    router.push(`${path}?${n.toString()}`);
  };
  const r = report.data as Record<string, unknown> | undefined;
  const cats =
    (r?.['byCategory'] as
      { categoryId: number; lots: number; turnover: number; commission: number }[] | undefined) ??
    [];
  const rc = recon.data as { ok: boolean; entriesSum: number } | undefined;
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <div className="flex gap-4">
        <div>
          <label htmlFor="from" className="block text-sm">
            {t('from')}
          </label>
          <input
            id="from"
            type="date"
            value={from}
            onChange={(e) => setPeriod('from', e.target.value)}
            className="rounded border px-2 py-1"
          />
        </div>
        <div>
          <label htmlFor="to" className="block text-sm">
            {t('to')}
          </label>
          <input
            id="to"
            type="date"
            value={to}
            onChange={(e) => setPeriod('to', e.target.value)}
            className="rounded border px-2 py-1"
          />
        </div>
      </div>
      {r ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(
            [
              ['turnover', money(Number(r['turnover']))],
              ['commission', money(Number(r['commission']))],
              ['paid', String(r['paidLots'])],
              ['unpaid', `${(Number(r['unpaidShare']) * 100).toFixed(1)}%`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="rounded border p-3">
              <dt className="text-sm text-gray-600">{t(k)}</dt>
              <dd data-testid={`fin-${k}`} className="text-xl font-bold">
                {v}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <section>
        <h2 className="font-semibold">{t('byCat')}</h2>
        <table className="w-full text-sm">
          <tbody>
            {cats.map((c) => (
              <tr key={c.categoryId} className="border-b">
                <td>#{c.categoryId}</td>
                <td>{c.lots}</td>
                <td>{money(c.turnover)}</td>
                <td>{money(c.commission)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="rounded border p-3">
        <h2 className="font-semibold">{t('recon')}</h2>
        <p data-testid="recon" className={rc?.ok ? 'text-green-700' : 'text-red-700'}>
          {rc ? (rc.ok ? t('ok') : t('bad')) : '…'} · {t('entries')}: {rc?.entriesSum ?? '…'}
        </p>
      </section>
    </div>
  );
};
