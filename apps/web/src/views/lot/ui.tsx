'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { useLiveLot } from '../../entities/lot/live';
import { PlaceBidForm } from '../../features/place-bid/ui';
import {
  getCatalogControllerLotQueryKey,
  moderationControllerRemove,
  useAuthControllerMe,
  useCatalogControllerBids,
  useCatalogControllerLot,
} from '../../shared/api/generated/client';
import { formatLeft, useServerCountdown } from '../../shared/lib/clock';
import { useMoney } from '../../shared/lib/money';

export const LotView = ({ id }: { id: string }) => {
  const t = useTranslations('lot');
  const money = useMoney();
  const qc = useQueryClient();
  const me = useAuthControllerMe({ query: { retry: false } });
  const mt = useTranslations('fin');
  const [why, setWhy] = useState('');
  const [gone, setGone] = useState(false);
  const lot = useCatalogControllerLot(id);
  const bids = useCatalogControllerBids(id);
  const receivedAt = useRef(Date.now());
  if (!lot.isFetching) receivedAt.current = Date.now();
  const { patch, connected } = useLiveLot(id, lot.data?.eventSeq);
  const price = patch?.currentPrice ?? lot.data?.currentPrice ?? 0;
  const bidCount = patch?.bidCount ?? lot.data?.bidCount ?? 0;
  const endsAt = patch?.endsAt ?? lot.data?.endsAt ?? null;
  const reserveMet = patch?.reserveMet ?? lot.data?.reserveMet ?? null;
  const left = useServerCountdown(endsAt, lot.data?.serverNow, receivedAt.current);
  if (lot.isError)
    return (
      <p role="alert" className="p-4">
        {t('notFound')}
      </p>
    );
  if (!lot.data) return null;
  const minNext =
    bidCount === 0
      ? lot.data.startPrice
      : price + (price < 10_000 ? 500 : price < 100_000 ? 1000 : price < 1_000_000 ? 5000 : 10_000);
  return (
    <article className="mx-auto max-w-3xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">{lot.data.title}</h1>
      <p className="text-gray-700">{lot.data.description}</p>
      <div className="grid grid-cols-2 gap-4 rounded border p-4">
        <div>
          <p className="text-sm text-gray-600">{t('currentPrice')}</p>
          <p data-testid="price" className="text-3xl font-bold">
            {money(price)}
          </p>
          <p data-testid="bid-count">{bidCount}</p>
        </div>
        <div>
          <p className="text-sm text-gray-600">{t('timeLeft')}</p>
          <p data-testid="time-left" className="text-3xl font-bold" aria-live="off">
            {left === null ? '—' : left === 0 ? t('ended') : formatLeft(left)}
          </p>
        </div>
        {reserveMet !== null ? (
          <p className="col-span-2 text-sm">{reserveMet ? t('reserveMet') : t('reserveNotMet')}</p>
        ) : null}
        <p className="col-span-2 text-xs text-gray-500">
          {connected ? `● ${t('connection')}` : '○'}
        </p>
      </div>
      {lot.data.status === 'active' && left !== 0 ? (
        <PlaceBidForm
          lotId={id}
          minNextBid={minNext}
          onDone={() =>
            void qc.invalidateQueries({ queryKey: getCatalogControllerLotQueryKey(id) })
          }
        />
      ) : null}
      {me.data?.role === 'moderator' && (lot.data.status === 'active' || gone) ? (
        <section className="space-y-2 rounded border border-red-300 p-3">
          <label htmlFor="why" className="block text-sm font-medium">
            {mt('reason')}
          </label>
          <input
            id="why"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            className="w-full rounded border px-3 py-2"
          />
          <button
            disabled={why.trim().length < 3}
            onClick={() =>
              void moderationControllerRemove(id, { reason: why }).then(() => {
                setGone(true);
                void qc.invalidateQueries({ queryKey: getCatalogControllerLotQueryKey(id) });
              })
            }
            className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
          >
            {mt('remove')}
          </button>
          {gone ? <p role="status">{mt('removed')}</p> : null}
        </section>
      ) : null}
      <section>
        <h2 className="text-lg font-semibold">{t('history')}</h2>
        <ul className="divide-y">
          {bids.data?.items.map((b) => (
            <li key={b.id} className="flex justify-between py-1">
              <span>
                {b.bidder}
                {b.you ? ` (${t('you')})` : ''}
                {b.isAuto ? ` · ${t('autoMark')}` : ''}
              </span>
              <span>{money(b.amount)}</span>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
};
