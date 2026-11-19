'use client';
import { useTranslations } from 'next-intl';
import { isApiError } from '../api/fetcher';
import { useMoney } from './money';

/** Turns a validation code (a Zod message such as INVALID_EMAIL) into text in the viewer's language. */
export const useFieldText = (): ((code: string | undefined) => string) => {
  const f = useTranslations('fields');
  return (code) => (code && f.has(code) ? f(code) : f('generic'));
};

/**
 * Turns an API error into text in the viewer's language. Every code the API can return has a translation
 * (messages `errors.<CODE>`); an unknown code or a non-API error gets the generic text, never the raw English message.
 */
export const useErrorText = (): ((e: unknown) => string) => {
  const t = useTranslations('errors');
  const fieldText = useFieldText();
  const money = useMoney();
  return (e) => {
    if (!isApiError(e)) return t('generic');
    if (e.code === 'VALIDATION_FAILED' && e.details.length > 0) {
      return e.details.map((d) => fieldText(d.message)).join('; ');
    }
    if (!t.has(e.code)) return t('generic');
    const min = e.meta['minNextBid'];
    return t(e.code, { minNextBid: typeof min === 'number' ? money(min) : '' });
  };
};
