'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { meControllerTopup } from '../../shared/api/generated/client';
import { useErrorText } from '../../shared/lib/errors';
import { amountProblem, parseMoneyInput } from '../../shared/lib/money';

const form = z.object({
  amount: z.string().superRefine((v, ctx) => {
    const problem = amountProblem(v, 100, 100_000_000);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  }),
});

export const TopUpForm = () => {
  const t = useTranslations('wallet');
  const errorText = useErrorText();
  const f = useTranslations('fields');
  const { register, handleSubmit, formState } = useForm<z.infer<typeof form>>({
    resolver: zodResolver(form),
    defaultValues: { amount: '' },
  });
  const topup = useMutation({
    mutationFn: (v: z.infer<typeof form>) =>
      meControllerTopup(
        { amount: parseMoneyInput(v.amount) ?? 0 },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      ),
    onSuccess: (r) => {
      window.location.href = r.payUrl; // the payment stub's own page
    },
  });
  return (
    <form
      onSubmit={handleSubmit((v) => topup.mutate(v))}
      className="flex flex-wrap items-end gap-3"
      noValidate
    >
      <div>
        <label htmlFor="topup" className="block text-sm font-medium">
          {t('amount')}
        </label>
        <input
          id="topup"
          inputMode="decimal"
          className="mt-1 rounded border px-3 py-2"
          aria-invalid={formState.errors.amount ? true : undefined}
          {...register('amount')}
        />
      </div>
      <button
        type="submit"
        disabled={topup.isPending}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {t('topup')}
      </button>
      <p role="alert" className="w-full text-sm text-red-600">
        {formState.errors.amount
          ? f((formState.errors.amount.message ?? 'generic') as 'generic')
          : topup.error
            ? errorText(topup.error)
            : ''}
      </p>
    </form>
  );
};
