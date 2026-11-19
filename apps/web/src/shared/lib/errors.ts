'use client';
import { useTranslations } from 'next-intl';
import { isApiError } from '../api/fetcher';

/** Turns an API error code into text in the viewer's language. */
export const useErrorText = (): ((e: unknown) => string) => {
  const t = useTranslations('errors');
  return (e) => {
    if (!isApiError(e)) return t('generic');
    const known = [
      'BID_TOO_LOW',
      'INSUFFICIENT_FUNDS',
      'LOT_ENDED',
      'OWN_LOT',
      'RATE_LIMITED',
      'VALIDATION_FAILED',
      'UNAUTHENTICATED',
    ];
    if (!known.includes(e.code)) return t('generic');
    return t(e.code as 'BID_TOO_LOW', {
      minNextBid:
        typeof e.meta['minNextBid'] === 'number' ? String(e.meta['minNextBid'] / 100) : '',
    });
  };
};
