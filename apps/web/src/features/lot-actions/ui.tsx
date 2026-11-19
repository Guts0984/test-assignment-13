'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  getCatalogControllerLotQueryKey,
  tradingControllerBuyNow,
  tradingControllerConfirm,
  tradingControllerPay,
  tradingControllerShip,
} from '../../shared/api/generated/client';
import { useErrorText } from '../../shared/lib/errors';
import { useMoney } from '../../shared/lib/money';

type Props = {
  lotId: string;
  status: string;
  buyNowPrice: number | null;
  isSeller: boolean;
  priceToPay: number | null;
  mustPayBy: string | null;
  isBuyer: boolean;
};

/** The actions that follow a lot through its life: buy now, pay, ship (seller), confirm receipt (buyer). */
export const LotActions = ({
  lotId,
  status,
  buyNowPrice,
  isSeller,
  priceToPay,
  mustPayBy,
  isBuyer,
}: Props) => {
  const t = useTranslations('lot');
  const money = useMoney();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [tracking, setTracking] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: getCatalogControllerLotQueryKey(lotId) });
  const key = () => ({ headers: { 'Idempotency-Key': crypto.randomUUID() } });
  const buy = useMutation({
    mutationFn: () => tradingControllerBuyNow(lotId, key()),
    onSuccess: refresh,
  });
  const pay = useMutation({
    mutationFn: () => tradingControllerPay(lotId, key()),
    onSuccess: refresh,
  });
  const ship = useMutation({
    mutationFn: () => tradingControllerShip(lotId, { trackingNumber: tracking }),
    onSuccess: refresh,
  });
  const confirm = useMutation({
    mutationFn: () => tradingControllerConfirm(lotId),
    onSuccess: refresh,
  });
  const err = buy.error ?? pay.error ?? ship.error ?? confirm.error;
  const btn = 'rounded px-4 py-2 text-white disabled:opacity-50';
  return (
    <section className="space-y-3 rounded border p-3" aria-label={t('actions')}>
      {status === 'active' && buyNowPrice !== null && !isSeller ? (
        <button
          onClick={() => buy.mutate()}
          disabled={buy.isPending}
          className={`${btn} bg-purple-600`}
        >
          {t('buyNow')} · {money(buyNowPrice)}
        </button>
      ) : null}
      {status === 'awaiting_payment' && isBuyer && priceToPay !== null ? (
        <div>
          <p>{t('payBy', { date: mustPayBy ? new Date(mustPayBy).toLocaleString() : '' })}</p>
          <button
            onClick={() => pay.mutate()}
            disabled={pay.isPending}
            className={`${btn} bg-green-600`}
          >
            {t('pay')} · {money(priceToPay)}
          </button>
        </div>
      ) : null}
      {status === 'paid' && isSeller ? (
        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="tracking" className="block text-sm font-medium">
              {t('tracking')}
            </label>
            <input
              id="tracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              className="rounded border px-3 py-2"
            />
          </div>
          <button
            onClick={() => ship.mutate()}
            disabled={tracking.trim().length < 3 || ship.isPending}
            className={`${btn} bg-blue-600`}
          >
            {t('ship')}
          </button>
        </div>
      ) : null}
      {status === 'shipped' && isBuyer ? (
        <button
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending}
          className={`${btn} bg-green-700`}
        >
          {t('confirmReceipt')}
        </button>
      ) : null}
      {status === 'completed' ? <p role="status">{t('completed')}</p> : null}
      {err ? (
        <p role="alert" className="text-sm text-red-600">
          {errorText(err)}
        </p>
      ) : null}
    </section>
  );
};
