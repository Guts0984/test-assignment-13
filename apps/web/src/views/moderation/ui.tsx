'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  moderationControllerApprove,
  moderationControllerClaim,
  moderationControllerLot,
  moderationControllerReject,
  useAuthControllerMe,
} from '../../shared/api/generated/client';
import { useErrorText } from '../../shared/lib/errors';

/** Minimal review queue: take the next lot, read it, approve or reject with a reason. */
export const ModerationView = () => {
  const t = useTranslations('mod');
  const me = useAuthControllerMe({ query: { retry: false } });
  const errorText = useErrorText();
  const [lotId, setLotId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const lot = useQuery({
    queryKey: ['mod-lot', lotId],
    queryFn: () => moderationControllerLot(lotId as string),
    enabled: lotId !== null,
  });
  const claim = useMutation({
    mutationFn: () => moderationControllerClaim(),
    onSuccess: (c) => {
      setLotId(c.lotId);
      setMessage('');
    },
  });
  const done = (text: string) => {
    setLotId(null);
    setReason('');
    setMessage(text);
  };
  const approve = useMutation({
    mutationFn: () => moderationControllerApprove(lotId as string),
    onSuccess: () => done(t('approved')),
  });
  const reject = useMutation({
    mutationFn: () => moderationControllerReject(lotId as string, { reason }),
    onSuccess: () => done(t('rejected')),
  });
  if (me.data?.role !== 'moderator') return <p className="p-4">{t('only')}</p>;
  const err = claim.error ?? approve.error ?? reject.error ?? lot.error;
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      {lotId === null ? (
        <button onClick={() => claim.mutate()} className="rounded bg-blue-600 px-4 py-2 text-white">
          Take next lot
        </button>
      ) : null}
      {message ? (
        <p role="status" className="text-green-700">
          {message}
        </p>
      ) : null}
      {lot.data ? (
        <article className="space-y-2 rounded border p-4">
          <h2 className="text-xl font-semibold">{String(lot.data['title'])}</h2>
          <p>{String(lot.data['description'])}</p>
          <div className="flex flex-wrap gap-2">
            {(lot.data['photos'] as { id: string; previewUrl: string | null }[] | undefined)?.map(
              (p) => (
                <img key={p.id} src={p.previewUrl ?? ''} alt="" className="h-24 rounded border" />
              ),
            )}
          </div>
          <p>
            Start price: {Number(lot.data['startPrice']) / 100} ₴ · duration{' '}
            {String(lot.data['durationDays'])} days
          </p>
          <label htmlFor="reason" className="block text-sm font-medium">
            Reason (for rejection)
          </label>
          <input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded border px-3 py-2"
          />
          <div className="flex gap-3">
            <button
              onClick={() => approve.mutate()}
              className="rounded bg-green-600 px-4 py-2 text-white"
            >
              Approve
            </button>
            <button
              onClick={() => reject.mutate()}
              disabled={reason.trim().length < 3}
              className="rounded bg-red-600 px-4 py-2 text-white disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </article>
      ) : null}
      {err ? (
        <p role="alert" className="text-red-600">
          {errorText(err)}
        </p>
      ) : null}
    </div>
  );
};
