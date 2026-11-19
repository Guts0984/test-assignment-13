/**
 * The one HTTP entry point used by the generated client (orval "mutator" shape). Same-origin (/api is
 * proxied by nginx); the session cookie rides along and every request carries the CSRF header the API demands.
 */
export type ApiError = Error & {
  readonly __apiError: true;
  readonly status: number;
  readonly code: string;
  readonly details: readonly { path: string; code: string; message: string }[];
  readonly meta: Record<string, unknown>;
};

export const createApiError = (
  status: number,
  code: string,
  message: string,
  details: ApiError['details'] = [],
  meta: Record<string, unknown> = {},
): ApiError =>
  Object.assign(new Error(message), { __apiError: true as const, status, code, details, meta });

export const isApiError = (e: unknown): e is ApiError =>
  e instanceof Error && (e as Partial<ApiError>).__apiError === true;

type Config = {
  url: string;
  method: string;
  headers?: HeadersInit;
  params?: Record<string, unknown>;
  data?: unknown;
  signal?: AbortSignal;
};
type ErrorBody = {
  error?: {
    code: string;
    message: string;
    details?: ApiError['details'];
    meta?: Record<string, unknown>;
  };
};

const toQuery = (params?: Record<string, unknown>): string => {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, Array.isArray(v) ? v.join(',') : String(v as string | number | boolean));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const apiFetch = async <T>(config: Config, options: RequestInit = {}): Promise<T> => {
  const headers = new Headers(config.headers);
  new Headers(options.headers).forEach((v, k) => headers.set(k, v));
  headers.set('x-requested-with', 'auction-web');
  const res = await fetch(`/api${config.url}${toQuery(config.params)}`, {
    method: config.method,
    headers,
    body: config.data === undefined ? undefined : JSON.stringify(config.data),
    credentials: 'include',
    signal: config.signal,
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = (data as ErrorBody | undefined)?.error;
    throw createApiError(
      res.status,
      e?.code ?? 'INTERNAL',
      e?.message ?? res.statusText,
      e?.details,
      e?.meta,
    );
  }
  return data as T;
};
export default apiFetch;
