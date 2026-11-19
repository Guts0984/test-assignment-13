'use client';
import { useTranslations } from 'next-intl';
import { isApiError } from '../api/fetcher';

/** Turns an API error code into text in the viewer's language. */
export const useErrorText = (): ((e: unknown) => string) => {
  const t = useTranslations('errors');
  const f = useTranslations('fields');
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
    if (e.code === 'VALIDATION_FAILED' && e.details.length > 0) {
      return e.details
        .map((d) => (f.has(d.message as 'generic') ? f(d.message as 'generic') : f('generic')))
        .join('; ');
    }
    if (!known.includes(e.code)) return e.message || t('generic');
    return t(e.code as 'BID_TOO_LOW', {
      minNextBid:
        typeof e.meta['minNextBid'] === 'number' ? String(e.meta['minNextBid'] / 100) : '',
    });
  };
};
