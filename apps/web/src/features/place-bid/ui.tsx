'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { tradingControllerBid } from '../../shared/api/generated/client';
import { useErrorText } from '../../shared/lib/errors';
import { parseMoneyInput, useMoney } from '../../shared/lib/money';

const form = z.object({
  kind: z.enum(['manual', 'auto']),
  amount: z.string().refine((v) => parseMoneyInput(v) !== null && (parseMoneyInput(v) ?? 0) > 0, {
    message: 'VALIDATION_FAILED',
  }),
});
type Values = z.infer<typeof form>;

export const PlaceBidForm = ({
  lotId,
  minNextBid,
  onDone,
}: {
  lotId: string;
  minNextBid: number;
  onDone: () => void;
}) => {
  const t = useTranslations('lot');
  const money = useMoney();
  const errorText = useErrorText();
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(form),
    defaultValues: { kind: 'manual', amount: '' },
  });
  const bid = useMutation({
    mutationFn: (v: Values) =>
      tradingControllerBid(
        lotId,
        { kind: v.kind, amount: parseMoneyInput(v.amount) ?? 0 },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      ),
    onSuccess: onDone,
  });
  return (
    <form onSubmit={handleSubmit((v) => bid.mutate(v))} className="space-y-3" noValidate>
      <fieldset className="flex gap-4">
        <legend className="sr-only">{t('placeBid')}</legend>
        <label className="flex items-center gap-1">
          <input type="radio" value="manual" {...register('kind')} /> {t('manual')}
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" value="auto" {...register('kind')} /> {t('auto')}
        </label>
      </fieldset>
      <div>
        <label htmlFor="amount" className="block text-sm font-medium">
          {t('amount')}
        </label>
        <input
          id="amount"
          inputMode="decimal"
          autoComplete="off"
          aria-describedby="amount-hint amount-error"
          aria-invalid={formState.errors.amount ? true : undefined}
          className="mt-1 w-full rounded border px-3 py-2"
          {...register('amount')}
        />
        <p id="amount-hint" className="text-xs text-gray-500">
          {t('minNext', { amount: money(minNextBid) })}
        </p>
        <p id="amount-error" role="alert" className="text-sm text-red-600">
          {formState.errors.amount
            ? errorText({ code: 'VALIDATION_FAILED' })
            : bid.error
              ? errorText(bid.error)
              : ''}
        </p>
      </div>
      <button
        type="submit"
        disabled={bid.isPending}
        className="rounded bg-blue-600 px-4 py-2 text-white focus:outline-2 focus:outline-offset-2 disabled:opacity-50"
      >
        {t('placeBid')}
      </button>
      {bid.data ? (
        <p role="status" className="text-green-700">
          {bid.data.outcome === 'leading' ? t('leading') : t('outbid')}
        </p>
      ) : null}
    </form>
  );
};
