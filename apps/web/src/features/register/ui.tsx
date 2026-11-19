'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  authControllerRegister,
  getAuthControllerMeQueryKey,
} from '../../shared/api/generated/client';
import { isApiError } from '../../shared/api/fetcher';
import { useErrorText, useFieldText } from '../../shared/lib/errors';

const registerForm = z.object({
  email: z.email({ error: 'INVALID_EMAIL' }),
  password: z
    .string()
    .min(8, { error: 'PASSWORD_TOO_SHORT' })
    .max(128, { error: 'PASSWORD_TOO_LONG' }),
  displayName: z
    .string()
    .trim()
    .min(2, { error: 'NAME_REQUIRED' })
    .max(40, { error: 'NAME_REQUIRED' }),
});
type Values = z.input<typeof registerForm>;
const NAMES = ['email', 'password', 'displayName'] as const;
const handledAtFields = (e: unknown): boolean =>
  isApiError(e) &&
  (e.code === 'EMAIL_TAKEN' || e.details.some((d) => NAMES.some((n) => n === d.path)));

export const RegisterForm = () => {
  const t = useTranslations('auth');
  const locale = useLocale();
  const router = useRouter();
  const qc = useQueryClient();
  const errorText = useErrorText();
  const et = useTranslations('errors');
  const fieldText = useFieldText();
  const { register, handleSubmit, formState, setError } = useForm<Values>({
    resolver: zodResolver(registerForm),
    defaultValues: { email: '', password: '', displayName: '' },
  });
  const signUp = useMutation({
    mutationFn: (v: Values) => authControllerRegister(v),
    onSuccess: async () => {
      // The API opened a session with the response: refresh "who am I" and go to the wallet.
      await qc.invalidateQueries({ queryKey: getAuthControllerMeQueryKey() });
      router.push(`/${locale}/wallet`);
    },
    onError: (e) => {
      if (!isApiError(e)) return;
      if (e.code === 'EMAIL_TAKEN') setError('email', { message: 'EMAIL_TAKEN' });
      for (const d of e.details) {
        const name = NAMES.find((n) => n === d.path);
        if (name) setError(name, { message: d.message });
      }
    },
  });
  const fieldError = (name: (typeof NAMES)[number]): string => {
    const m = formState.errors[name]?.message;
    if (!m) return '';
    return et.has(m) ? et(m) : fieldText(m);
  };
  const field = (name: (typeof NAMES)[number], label: string, type: string, auto: string) => (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        type={type}
        autoComplete={auto}
        aria-invalid={formState.errors[name] ? true : undefined}
        aria-describedby={`${name}-error`}
        className="mt-1 w-full rounded border px-3 py-2"
        {...register(name)}
      />
      <p id={`${name}-error`} role="alert" className="text-sm text-red-600">
        {fieldError(name)}
      </p>
    </div>
  );
  return (
    <form
      onSubmit={handleSubmit((v) => signUp.mutate(v))}
      className="max-w-sm space-y-3"
      noValidate
    >
      <h1 className="text-2xl font-bold">{t('registerTitle')}</h1>
      {field('displayName', t('name'), 'text', 'name')}
      {field('email', t('email'), 'email', 'username')}
      {field('password', t('password'), 'password', 'new-password')}
      <p className="text-xs text-gray-500">{t('passwordHint')}</p>
      <p role="alert" className="text-sm text-red-600">
        {signUp.error && !handledAtFields(signUp.error) ? errorText(signUp.error) : ''}
      </p>
      <button
        type="submit"
        disabled={signUp.isPending}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {t('register')}
      </button>
      <p className="text-sm">
        {t('registerHint')}{' '}
        <Link href={`/${locale}/login`} className="underline">
          {t('login')}
        </Link>
      </p>
    </form>
  );
};
