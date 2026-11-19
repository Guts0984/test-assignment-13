/* eslint-disable @typescript-eslint/no-explicit-any -- test code inspects arbitrary JSON bodies dynamically */
import { randomUUID } from 'node:crypto';
import { DEFAULT_TIMINGS, errorResponseSchema } from '@auction/shared';
import { fund, infra, makeLot, makeUser, uniqueName, type TestDb } from '@auction/test-kit';
import { io, type Socket } from 'socket.io-client';
import type { RunningApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const PROVIDER_KEY = 'test-provider-api-key-0123456789';
export const PUBLIC = 'http://localhost:8080';
export const UAH = (n: number) => Math.round(n * 100);

export const testApiConfig = (t: TestDb, over: Partial<ApiConfig> = {}): ApiConfig => ({
  port: 0,
  nodeId: uniqueName('api'),
  publicUrl: PUBLIC,
  databaseUrl: t.url,
  redisUrl: `${infra.redisUrl}/3`,
  meili: { url: infra.meiliUrl, key: infra.meiliKey },
  s3: {
    endpoint: infra.s3Endpoint,
    accessKey: infra.s3AccessKey,
    secretKey: infra.s3SecretKey,
    privateBucket: uniqueName('apriv'),
    publicBucket: uniqueName('apub'),
  },
  publicUploadUrl: `${PUBLIC}/upload/bucket`,
  publicPhotoUrl: `${PUBLIC}/photos`,
  webhookSecret: WEBHOOK_SECRET,
  providerApiKey: PROVIDER_KEY,
  providerBaseUrl: 'http://nginx:8080',
  chaos: false,
  timings: { ...DEFAULT_TIMINGS },
  trustProxy: 'loopback',
  cookieSecure: false,
  testClock: false,
  rate: {
    global: 100_000,
    login: 100_000,
    loginAccount: 100_000,
    register: 100_000,
    bid: 100_000,
    topup: 100_000,
    presign: 100_000,
    search: 100_000,
  },
  ...over,
});

export type Res = { status: number; body: any; headers: Headers };
export type Client = {
  cookie: string | null;
  call: (
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      headers?: Record<string, string>;
      raw?: string;
      csrf?: boolean;
      idem?: string | false;
      ip?: string;
    },
  ) => Promise<Res>;
};

/** A browser-like client: keeps its cookie, sends the CSRF header unless told not to. */
export const client = (app: RunningApp): Client => {
  const c: Client = {
    cookie: null,
    call: async (method, path, opts = {}) => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (c.cookie) headers['cookie'] = c.cookie;
      if (opts.body !== undefined || opts.raw !== undefined)
        headers['content-type'] ??= 'application/json';
      if (method !== 'GET' && opts.csrf !== false) headers['x-requested-with'] = 'auction-web';
      if (opts.idem !== false && ['POST', 'PUT'].includes(method) && opts.idem !== undefined)
        headers['idempotency-key'] = opts.idem;
      if (opts.ip) headers['x-forwarded-for'] = opts.ip;
      const res = await fetch(`${app.url}${path}`, {
        method,
        headers,
        body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
        redirect: 'manual',
      });
      const set = res.headers.getSetCookie().find((s) => s.startsWith('sid='));
      if (set) c.cookie = set.split(';')[0] ?? null;
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* html or plain */
      }
      return { status: res.status, body, headers: res.headers };
    },
  };
  return c;
};

export const register = async (
  app: RunningApp,
  name = 'tester',
): Promise<{ c: Client; id: string; email: string }> => {
  const c = client(app);
  const email = `${randomUUID()}@t.test`;
  const r = await c.call('POST', '/auth/register', {
    body: { email, password: 'Passw0rd!', displayName: name },
  });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${JSON.stringify(r.body)}`);
  return { c, id: r.body.id as string, email };
};

export const loginAs = async (
  app: RunningApp,
  t: TestDb,
  role: 'moderator' | 'finance',
): Promise<{ c: Client; id: string }> => {
  const id = await makeUser(t.pool, role);
  const email = (
    await t.pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [id])
  ).rows[0]!.email;
  const { hashPassword } = await import('@auction/db');
  await t.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
    id,
    await hashPassword('Passw0rd!'),
  ]);
  const c = client(app);
  const r = await c.call('POST', '/auth/login', { body: { email, password: 'Passw0rd!' } });
  if (r.status !== 200) throw new Error(`login failed ${r.status}`);
  return { c, id };
};

export const isErrorShape = (body: unknown): boolean => errorResponseSchema.safeParse(body).success;

export const socket = (app: RunningApp, cookie: string | null): Socket =>
  io(app.url, {
    transports: ['websocket'],
    extraHeaders: cookie ? { cookie } : {},
    forceNew: true,
    reconnection: false,
  });
export const waitConnected = (s: Socket) =>
  new Promise<void>((res, rej) => {
    s.on('connect', () => res());
    s.on('connect_error', rej);
  });
export const ack = <T = any>(s: Socket, ev: string, data: unknown): Promise<T> =>
  new Promise((res) => s.emit(ev, data, res));
export const collect = (s: Socket, ev: string): any[] => {
  const got: any[] = [];
  s.on(ev, (m) => got.push(m));
  return got;
};
export { fund, makeLot, makeUser };
