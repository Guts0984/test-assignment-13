'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useNotifications } from '../../entities/notification/live';
import { type AppNotification } from '../../entities/notification/model';
import {
  getMeControllerNotificationsQueryKey,
  meControllerRead,
  useAuthControllerMe,
} from '../../shared/api/generated/client';
import { useMoney } from '../../shared/lib/money';

export const NotificationsView = () => {
  const t = useTranslations('notifications');
  const locale = useLocale();
  const money = useMoney();
  const format = useFormatter();
  const qc = useQueryClient();
  const me = useAuthControllerMe({ query: { retry: false } });
  const { items, unread } = useNotifications(Boolean(me.data));
  const markRead = useMutation({
    mutationFn: () => meControllerRead(),
    onSuccess: () => qc.invalidateQueries({ queryKey: getMeControllerNotificationsQueryKey() }),
  });
  if (me.isError)
    return (
      <p className="p-4" role="status">
        {t('signin')}
      </p>
    );
  const text = (n: AppNotification): string => {
    const key = t.has(`kinds.${n.kind}`) ? n.kind : 'other';
    const price = n.payload['currentPrice'];
    const title = n.payload['title'];
    return t(`kinds.${key}`, {
      title: typeof title === 'string' ? title : '',
      price: typeof price === 'number' ? money(price) : '',
    });
  };
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <button
          disabled={unread === 0 || markRead.isPending}
          onClick={() => markRead.mutate()}
          className="rounded border px-3 py-1 disabled:opacity-40"
        >
          {t('markRead')}
        </button>
      </div>
      {me.data && items.length === 0 ? <p>{t('empty')}</p> : null}
      <ul className="divide-y" data-testid="notifications">
        {items.map((n) => {
          const lotId = n.payload['lotId'];
          const body = text(n);
          return (
            <li
              key={n.id}
              data-unread={n.read ? undefined : 'true'}
              className={`py-2 ${n.read ? 'text-gray-600' : 'font-semibold'}`}
            >
              {typeof lotId === 'string' ? (
                <Link href={`/${locale}/lots/${lotId}`} className="underline">
                  {body}
                </Link>
              ) : (
                body
              )}
              <time dateTime={n.at} className="block text-xs font-normal text-gray-500">
                {format.dateTime(new Date(n.at), { dateStyle: 'medium', timeStyle: 'short' })}
              </time>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
