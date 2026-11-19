'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  authControllerLogin,
  getAuthControllerMeQueryKey,
  useAuthControllerMe,
} from '../../shared/api/generated/client';
import { useErrorText, useFieldText } from '../../shared/lib/errors';

/** Same rules as the API's login schema, but with codes we translate (the shared schema's "too small" is English). */
const loginForm = z.object({
  email: z.email({ error: 'INVALID_EMAIL' }),
  password: z
    .string()
    .min(1, { error: 'PASSWORD_REQUIRED' })
    .max(128, { error: 'PASSWORD_TOO_LONG' }),
});

type Values = z.input<typeof loginForm>;

export const LoginForm = () => {
  const t = useTranslations('auth');
  const errorText = useErrorText();
  const fieldText = useFieldText();
  const router = useRouter();
  const locale = useLocale();
  const qc = useQueryClient();
  const me = useAuthControllerMe({ query: { retry: false } });
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(loginForm),
    defaultValues: { email: '', password: '' },
  });
  const login = useMutation({
    mutationFn: (v: Values) => authControllerLogin(v),
    onSuccess: async (u) => {
      await qc.invalidateQueries({ queryKey: getAuthControllerMeQueryKey() });
      router.push(
        `/${locale}${u.role === 'moderator' ? '/moderation' : u.role === 'finance' ? '/finance' : '/wallet'}`,
      );
    },
  });
  const field = (name: keyof Values, label: string, type: string) => (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        type={type}
        autoComplete={name === 'email' ? 'username' : 'current-password'}
        aria-invalid={formState.errors[name] ? true : undefined}
        className="mt-1 w-full rounded border px-3 py-2"
        {...register(name)}
      />
      <p role="alert" className="text-sm text-red-600">
        {formState.errors[name] ? fieldText(formState.errors[name]?.message) : ''}
      </p>
    </div>
  );
  if (me.data)
    return (
      <p role="status" className="max-w-sm rounded bg-green-100 p-3">
        {t('already', { name: me.data.displayName })}
      </p>
    );
  return (
    <form onSubmit={handleSubmit((v) => login.mutate(v))} className="max-w-sm space-y-3" noValidate>
      {field('email', t('email'), 'email')}
      {field('password', t('password'), 'password')}
      <p role="alert" className="text-sm text-red-600">
        {login.error ? errorText(login.error) : ''}
      </p>
      <button
        type="submit"
        disabled={login.isPending}
        className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {t('login')}
      </button>
      <p className="text-sm">
        {t('loginHint')}{' '}
        <Link href={`/${locale}/register`} className="underline">
          {t('register')}
        </Link>
      </p>
    </form>
  );
};
