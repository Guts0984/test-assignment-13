/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- test code inspects arbitrary JSON bodies dynamically */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { count, lotRow, newTestDb, balanceOf, type TestDb } from '@auction/test-kit';
import { createPayment, decidePayment, signWebhook } from '@auction/payment-stub';
import { attachProviderPayment, createTopup } from '@auction/domain';
import { DEFAULT_TIMINGS, errorResponseSchema } from '@auction/shared';
import type { RunningApp } from '../src/app.js';
import { startApp } from '../src/app.js';
import { createMeili, ensureIndex } from '@auction/platform';
import { infra } from '@auction/test-kit';
import {
  PUBLIC,
  UAH,
  WEBHOOK_SECRET,
  ack,
  client,
  collect,
  fund,
  isErrorShape,
  loginAs,
  makeLot,
  makeUser,
  register,
  socket,
  testApiConfig,
  waitConnected,
} from './support.js';

let t: TestDb;
let app: RunningApp;
beforeAll(async () => {
  t = await newTestDb(60);
  await t.pool.query(
    `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
  );
  await ensureIndex(createMeili(infra.meiliUrl, infra.meiliKey)); // the catalog index exists in a real stack
  app = await startApp(testApiConfig(t), 0);
});
afterAll(async () => {
  await app.close();
  await t.close();
});

const idem = () => randomUUID();
const lotInput = (over: Record<string, unknown> = {}) => ({
  title: 'Vintage camera',
  description: 'works',
  categoryId: 1,
  cityId: 1,
  condition: 'good',
  startPrice: UAH(100),
  reservePrice: null,
  buyNowPrice: null,
  durationDays: 3,
  ...over,
});

describe('invariant 15: every failure has one shape and a code, never "Internal server error"', () => {
  it.each([
    ['malformed JSON', 'POST', '/auth/login', { raw: '{"email": ' }, 400, 'MALFORMED_JSON'],
    ['empty body on a body route', 'POST', '/auth/login', { body: {} }, 400, 'VALIDATION_FAILED'],
    ['unknown route', 'GET', '/no/such/route', {}, 404, 'ROUTE_NOT_FOUND'],
    [
      'body over 100 KB',
      'POST',
      '/auth/login',
      { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(200_000) }) },
      413,
      'PAYLOAD_TOO_LARGE',
    ],
    ['non-UUID id', 'GET', '/lots/not-a-uuid', {}, 404, 'NOT_FOUND'],
    ['bad search query', 'GET', '/search?page=-1&sort=hack', {}, 400, 'VALIDATION_FAILED'],
    ['bad report period', 'GET', '/finance/report?from=x&to=y', {}, 401, 'UNAUTHENTICATED'],
  ] as const)('%s', async (_n, method, path, opts, status, code) => {
    const r = await client(app).call(method, path, opts);
    expect(r.status).toBe(status);
    expect(isErrorShape(r.body), JSON.stringify(r.body)).toBe(true);
    expect(r.body.error.code).toBe(code);
    expect(typeof r.body.requestId).toBe('string');
  });

  it('validation errors point at the field with a machine code', async () => {
    const { c } = await register(app);
    const r = await c.call('POST', '/lots', {
      body: lotInput({ startPrice: 10.5, durationDays: 99, status: 'active' }),
    });
    expect(r.status).toBe(400);
    const paths = r.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['startPrice', 'durationDays']));
  });

  it('fuzz: hostile bodies against every state-changing route never produce a 5xx or a non-standard error', async () => {
    const { c } = await register(app);
    const evil: unknown[] = [
      null,
      0,
      -1,
      1e308,
      'x'.repeat(50_000),
      [],
      [[[]]],
      {},
      { __proto__: { polluted: 1 } },
      JSON.parse('{"__proto__":{"admin":true}}'),
      { amount: 'NaN' },
      { amount: 1e21 },
      { amount: -5 },
      { kind: { $ne: 1 } },
      { title: '\u0000\u0007' },
      { text: '😀'.repeat(3000) },
      { reason: 'x'.repeat(10_000) },
      { trackingNumber: '<script>' },
      { outcome: 'hack' },
    ];
    const lot = await makeLot(t.pool, { sellerId: await makeUser(t.pool), now: new Date() });
    const routes = [
      '/auth/register',
      '/auth/login',
      '/lots',
      `/lots/${lot}/bids`,
      `/lots/${lot}/buy-now`,
      `/lots/${lot}/pay`,
      `/lots/${lot}/ship`,
      `/lots/${lot}/confirm`,
      `/lots/${lot}/description`,
      `/lots/${lot}/submit`,
      `/lots/${lot}/photos/presign`,
      '/me/topups',
      '/moderation/claim',
      `/moderation/lots/${lot}/reject`,
    ];
    let seen = 0;
    for (const path of routes) {
      for (const body of evil) {
        const r = await c.call('POST', path, { body, idem: idem() });
        seen++;
        expect(
          r.status,
          `${path} ${JSON.stringify(body).slice(0, 60)} -> ${JSON.stringify(r.body).slice(0, 120)}`,
        ).toBeLessThan(500);
        if (r.status >= 400)
          expect(isErrorShape(r.body), `${path} ${JSON.stringify(r.body).slice(0, 120)}`).toBe(
            true,
          );
      }
    }
    expect(seen).toBeGreaterThan(200);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
  });
});

describe('invariant 14: rights are enforced on the server for every role', () => {
  it('authorization matrix: who may call what (anonymous, buyer, another buyer, moderator, finance)', async () => {
    const seller = await register(app, 'seller');
    const buyer = await register(app, 'buyer');
    const mod = await loginAs(app, t, 'moderator');
    const fin = await loginAs(app, t, 'finance');
    const anon = client(app);
    const lot = await makeLot(t.pool, { sellerId: seller.id, now: new Date() });
    const L = `/lots/${lot}`;
    // [method, path, body, who may succeed-or-be-refused-by-business-rules (non-401/403)]
    const rows: [string, string, unknown, ('anon' | 'user' | 'mod' | 'fin')[]][] = [
      ['GET', '/me/wallet', undefined, ['user']],
      ['GET', '/me/bids', undefined, ['user']],
      ['GET', '/me/lots', undefined, ['user']],
      ['POST', '/me/topups', { amount: 1000 }, ['user']],
      ['POST', `${L}/bids`, { kind: 'manual', amount: 20000 }, ['user']],
      ['POST', `${L}/buy-now`, {}, ['user']],
      ['POST', `${L}/pay`, {}, ['user']],
      ['POST', '/lots', lotInput(), ['user']],
      ['POST', '/moderation/claim', {}, ['mod']],
      ['GET', '/finance/report?from=2026-01-01&to=2026-01-31', undefined, ['fin']],
      ['GET', '/finance/reconciliation', undefined, ['fin']],
      ['POST', `/moderation/lots/${lot}/remove`, { reason: 'because' }, ['mod']],
      ['GET', '/auth/me', undefined, ['user', 'mod', 'fin']],
      ['GET', '/me/notifications', undefined, ['user', 'mod', 'fin']],
      ['GET', `/lots/${lot}`, undefined, ['anon', 'user', 'mod', 'fin']],
      ['GET', '/search', undefined, ['anon', 'user', 'mod', 'fin']],
    ];
    const actors = { anon, user: buyer.c, mod: mod.c, fin: fin.c };
    for (const [method, path, body, allowed] of rows) {
      for (const [who, c] of Object.entries(actors)) {
        const r = await c.call(method, path, { body, idem: idem() });
        const may = allowed.includes(who as 'anon');
        if (may)
          expect([401, 403], `${who} ${method} ${path} should be allowed`).not.toContain(r.status);
        else
          expect(r.status, `${who} ${method} ${path} must be refused (got ${r.status})`).toBe(
            who === 'anon' ? 401 : 403,
          );
        expect(r.status).toBeLessThan(500);
      }
    }
  });

  it('the OpenAPI document is served and describes the routes, request bodies, responses and the one error shape', async () => {
    const raw = await fetch(`${app.url}/docs/json`);
    expect(
      raw.status,
      await raw
        .clone()
        .text()
        .then((x) => x.slice(0, 200)),
    ).toBe(200);
    const doc = (await raw.json()) as {
      paths: Record<string, Record<string, any>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(Object.keys(doc.paths).length).toBeGreaterThan(30);
    expect(doc.components.schemas['ErrorResponse']).toBeTruthy();
    const bid = doc.paths['/lots/{id}/bids']!['post']!;
    expect(bid.requestBody.content['application/json'].schema.properties.amount).toBeTruthy();
    expect(bid.responses['200'].content['application/json'].schema.properties.outcome).toBeTruthy();
    expect(bid.responses['409'].content['application/json'].schema.$ref).toContain('ErrorResponse');
    expect(bid.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key')).toBe(true);
    expect((await fetch(`${app.url}/docs`)).status).toBe(200);
  });

  it('IDOR: a buyer cannot read another user’s wallet/bids/lots, a stranger cannot touch or see a draft', async () => {
    const a = await register(app, 'alice');
    const b = await register(app, 'bobby');
    await fund(t.pool, a.id, UAH(777));
    expect((await b.c.call('GET', '/me/wallet')).body.balance).toBe(0); // always the caller's own
    expect((await a.c.call('GET', '/me/wallet')).body.balance).toBe(UAH(777));
    const draft = await makeLot(t.pool, { sellerId: a.id, status: 'draft' });
    for (const [method, path, body] of [
      ['GET', `/lots/${draft}`, undefined],
      ['PUT', `/lots/${draft}`, lotInput()],
      ['POST', `/lots/${draft}/submit`, {}],
      ['POST', `/lots/${draft}/description`, { text: 'hijack' }],
      ['POST', `/lots/${draft}/photos/presign`, { contentType: 'image/png', size: 100 }],
    ] as const) {
      const r = await b.c.call(method, path, { body });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect((await client(app).call('GET', `/lots/${draft}`)).status).toBe(404);
    expect((await a.c.call('GET', `/lots/${draft}`)).status).toBe(200);
  });

  it('the reserve price is visible to the seller only; everyone else sees "met / not met"', async () => {
    const seller = await register(app, 'seller2');
    const buyer = await register(app, 'buyer2');
    await fund(t.pool, buyer.id, UAH(10_000));
    const RESERVE = UAH(4321.09);
    const lot = await makeLot(t.pool, {
      sellerId: seller.id,
      reservePrice: RESERVE,
      now: new Date(),
    });
    const bidRes = await buyer.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(150) },
      idem: idem(),
    });
    expect(bidRes.status).toBe(200);
    for (const who of [client(app), buyer.c]) {
      const dump = JSON.stringify([
        (await who.call('GET', `/lots/${lot}`)).body,
        (await who.call('GET', `/lots/${lot}/bids`)).body,
        (await who.call('GET', `/lots/${lot}/events?after=0`)).body,
        bidRes.body,
      ]);
      expect(dump).not.toContain(String(RESERVE));
      expect(dump.toLowerCase()).not.toMatch(/reserve_?price"\s*:\s*\d/);
      expect(JSON.parse(dump)[0].reserveMet).toBe(false);
    }
    const own = (await seller.c.call('GET', `/lots/${lot}`)).body;
    expect(own.viewer.reservePrice).toBe(RESERVE);
    expect((await client(app).call('GET', `/lots/${lot}`)).body.viewer.reservePrice).toBeNull();
  });

  it('bid history masks names, marks your own bids, and a seller learns the winner only after payment', async () => {
    const seller = await register(app, 'seller3');
    const buyer = await register(app, 'olena_7');
    await fund(t.pool, buyer.id, UAH(10_000));
    const lot = await makeLot(t.pool, { sellerId: seller.id, now: new Date() });
    await buyer.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(150) },
      idem: idem(),
    });
    const pub = (await client(app).call('GET', `/lots/${lot}/bids`)).body;
    expect(pub.items[0]).toMatchObject({ bidder: 'o***7', you: false });
    expect(JSON.stringify(pub)).not.toContain('olena');
    expect((await buyer.c.call('GET', `/lots/${lot}/bids`)).body.items[0].you).toBe(true);
    expect((await seller.c.call('GET', `/lots/${lot}`)).body.viewer.winner).toBeNull();
  });
});

describe('authentication, sessions, CSRF', () => {
  it('registration and login set an HttpOnly, SameSite cookie; logout kills the session server-side', async () => {
    const { c, email } = await register(app);
    const login = await c.call('POST', '/auth/login', { body: { email, password: 'Passw0rd!' } });
    const cookie = login.headers.getSetCookie().find((s) => s.startsWith('sid='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const stolen = c.cookie!;
    expect((await c.call('GET', '/auth/me')).status).toBe(200);
    expect((await c.call('POST', '/auth/logout')).status).toBe(204);
    const replay = client(app);
    replay.cookie = stolen;
    expect((await replay.call('GET', '/auth/me')).status).toBe(401); // the stolen cookie is dead
  });

  it('forged, empty, oversized and SQL-looking cookies are simply "not signed in"', async () => {
    for (const cookie of [
      'sid=',
      'sid=abc',
      `sid=${'a'.repeat(5000)}`,
      "sid=' OR 1=1 --",
      `sid=${'A'.repeat(43)}`,
    ]) {
      const c = client(app);
      c.cookie = cookie;
      const r = await c.call('GET', '/auth/me');
      expect(r.status).toBe(401);
      expect(isErrorShape(r.body)).toBe(true);
    }
  });

  it('login guessing is limited per account AND address: the owner on another address is never locked out by a stranger', async () => {
    const f = await newTestDb(20);
    const strict = await startApp(
      testApiConfig(f, {
        rate: {
          global: 100_000,
          login: 100_000,
          loginAccount: 5,
          register: 100_000,
          bid: 100_000,
          topup: 100_000,
          presign: 100_000,
          search: 100_000,
        },
      }),
      0,
    );
    try {
      const { email } = await register(strict);
      const attacker = client(strict);
      const guess = () =>
        attacker.call('POST', '/auth/login', {
          body: { email, password: 'wrong-password' },
          ip: '203.0.113.5',
        });
      const codes: string[] = [];
      for (let i = 0; i < 8; i++) codes.push((await guess()).body.error.code);
      expect(codes.slice(0, 5)).toEqual(Array(5).fill('INVALID_CREDENTIALS'));
      expect(codes.slice(5)).toEqual(Array(3).fill('ACCOUNT_LOCKED'));
      // The attacker's address is now blocked even with the right password...
      expect(
        (
          await attacker.call('POST', '/auth/login', {
            body: { email, password: 'Passw0rd!' },
            ip: '203.0.113.5',
          })
        ).body.error.code,
      ).toBe('ACCOUNT_LOCKED');
      // ...but the real owner, on another address, signs in normally.
      const owner = client(strict);
      expect(
        (
          await owner.call('POST', '/auth/login', {
            body: { email, password: 'Passw0rd!' },
            ip: '198.51.100.20',
          })
        ).status,
      ).toBe(200);
      // Unknown emails behave identically (no enumeration): same budget, same answers.
      const ghostEmail = `ghost-${randomUUID()}@t.test`;
      const ghost: string[] = [];
      for (let i = 0; i < 7; i++)
        ghost.push(
          (
            await attacker.call('POST', '/auth/login', {
              body: { email: ghostEmail, password: 'x'.repeat(10) },
              ip: '203.0.113.5',
            })
          ).body.error.code,
        );
      expect(ghost).toEqual([
        ...Array(5).fill('INVALID_CREDENTIALS'),
        'ACCOUNT_LOCKED',
        'ACCOUNT_LOCKED',
      ]);
    } finally {
      await strict.close();
      await f.close();
    }
  });

  it('10 parallel wrong guesses cannot slip past the limit (atomic counter)', async () => {
    const f = await newTestDb(20);
    const strict = await startApp(
      testApiConfig(f, {
        rate: {
          global: 100_000,
          login: 100_000,
          loginAccount: 3,
          register: 100_000,
          bid: 100_000,
          topup: 100_000,
          presign: 100_000,
          search: 100_000,
        },
      }),
      0,
    );
    try {
      const { email } = await register(strict);
      const rs = await Promise.all(
        Array.from({ length: 10 }, () =>
          client(strict).call('POST', '/auth/login', {
            body: { email, password: 'wrong-password' },
            ip: '203.0.113.9',
          }),
        ),
      );
      expect(rs.filter((r) => r.body.error.code === 'INVALID_CREDENTIALS')).toHaveLength(3);
      expect(rs.filter((r) => r.body.error.code === 'ACCOUNT_LOCKED')).toHaveLength(7);
    } finally {
      await strict.close();
      await f.close();
    }
  });

  it('a lot with a non-existent category or city is a 400 with a code, never a 500', async () => {
    const { c } = await register(app);
    for (const bad of [{ categoryId: 31999 }, { cityId: 31999 }]) {
      const r = await c.call('POST', '/lots', { body: lotInput(bad) });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('photo rules: no uploads to a live lot; a rejected photo frees its slot', async () => {
    const { c, id } = await register(app);
    const live = await makeLot(t.pool, { sellerId: id, now: new Date() });
    expect(
      (
        await c.call('POST', `/lots/${live}/photos/presign`, {
          body: { contentType: 'image/png', size: 1000 },
        })
      ).body.error.code,
    ).toBe('LOT_NOT_EDITABLE');
    const draft = await makeLot(t.pool, { sellerId: id, status: 'draft' });
    const first = await c.call('POST', `/lots/${draft}/photos/presign`, {
      body: { contentType: 'image/png', size: 1000 },
    });
    await t.pool.query(`UPDATE lot_photos SET status = 'rejected' WHERE id = $1`, [
      first.body.photoId,
    ]);
    for (let i = 0; i < 3; i++)
      expect(
        (
          await c.call('POST', `/lots/${draft}/photos/presign`, {
            body: { contentType: 'image/png', size: 1000 },
          })
        ).status,
      ).toBe(201);
  });

  it('duplicate email is refused with its own code', async () => {
    const { email } = await register(app);
    const r = await client(app).call('POST', '/auth/register', {
      body: { email, password: 'Passw0rd!', displayName: 'dup' },
    });
    expect(r.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('CSRF: a state-changing request without the custom header, or from another origin, is refused', async () => {
    const { c } = await register(app);
    const noHeader = await c.call('POST', '/me/topups', {
      body: { amount: 1000 },
      csrf: false,
      idem: idem(),
    });
    expect(noHeader.body.error.code).toBe('CSRF_REJECTED');
    const evilOrigin = await c.call('POST', '/me/topups', {
      body: { amount: 1000 },
      headers: { origin: 'https://evil.example' },
      idem: idem(),
    });
    expect(evilOrigin.body.error.code).toBe('CSRF_REJECTED');
    const ownOrigin = await c.call('POST', '/me/topups', {
      body: { amount: 1000 },
      headers: { origin: PUBLIC },
      idem: idem(),
    });
    expect(ownOrigin.status).toBe(201);
  });

  it('staff and buyers: moderators and finance cannot bid, top up or sell (403), even directly', async () => {
    const mod = await loginAs(app, t, 'moderator');
    const lot = await makeLot(t.pool, { sellerId: await makeUser(t.pool), now: new Date() });
    for (const [m, p, b] of [
      ['POST', `/lots/${lot}/bids`, { kind: 'manual', amount: 20000 }],
      ['POST', '/me/topups', { amount: 1000 }],
      ['POST', '/lots', lotInput()],
    ] as const) {
      expect((await mod.c.call(m, p, { body: b, idem: idem() })).status).toBe(403);
    }
  });
});

describe('bidding over HTTP', () => {
  it('requires an Idempotency-Key; a retry returns the same result; a refusal carries the minimum next bid', async () => {
    const seller = await register(app);
    const buyer = await register(app);
    await fund(t.pool, buyer.id, UAH(5000));
    const lot = await makeLot(t.pool, { sellerId: seller.id, now: new Date() });
    expect(
      (
        await buyer.c.call('POST', `/lots/${lot}/bids`, {
          body: { kind: 'manual', amount: UAH(150) },
        })
      ).body.error.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = idem();
    const a = await buyer.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(150) },
      idem: key,
    });
    const b = await buyer.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(150) },
      idem: key,
    });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(await count(t.pool, 'SELECT count(*) AS n FROM bids WHERE lot_id = $1', [lot])).toBe(1);
    const reused = await buyer.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(999) },
      idem: key,
    });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const rival = await register(app);
    await fund(t.pool, rival.id, UAH(5000));
    const low = await rival.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(150) },
      idem: idem(),
    });
    expect(low.status).toBe(409);
    expect(low.body.error).toMatchObject({ code: 'BID_TOO_LOW', meta: { minNextBid: UAH(160) } });
    const own = await seller.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(500) },
      idem: idem(),
    });
    expect(own.body.error.code).toBe('OWN_LOT');
  });

  it('40 users bidding at the same time over HTTP: only 200 and 409, never a 500; prices only grow', async () => {
    const seller = await register(app);
    const users = await Promise.all(Array.from({ length: 40 }, () => register(app)));
    for (const u of users) await fund(t.pool, u.id, UAH(5000));
    const lot = await makeLot(t.pool, { sellerId: seller.id, now: new Date() });
    const rs = await Promise.all(
      users.map((u, i) =>
        u.c.call('POST', `/lots/${lot}/bids`, {
          body: { kind: i % 2 ? 'auto' : 'manual', amount: UAH(100 + i * 10) },
          idem: idem(),
        }),
      ),
    );
    expect(
      rs.every((r) => r.status === 200 || r.status === 409),
      rs.map((r) => r.status).join(','),
    ).toBe(true);
    const amounts = (
      await t.pool.query<{ amount: number }>(
        'SELECT amount FROM bids WHERE lot_id = $1 ORDER BY id',
        [lot],
      )
    ).rows.map((r) => r.amount);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
  });
});

describe('payment stub webhooks (invariant 6)', () => {
  const mkTopup = async (userId: string) => {
    const deps = {
      pool: t.pool,
      clock: { now: () => new Date() },
      timings: { ...DEFAULT_TIMINGS },
    };
    const { result } = await createTopup(deps, {
      userId,
      amount: UAH(500),
      idempotencyKey: idem(),
    });
    const p = await createPayment(t.pool, {
      amount: UAH(500),
      reference: result.topupId,
      notifyUrl: 'http://x/webhooks/payments',
      now: new Date(),
    });
    await attachProviderPayment(t.pool, result.topupId, p.id);
    return { topupId: result.topupId, paymentId: p.id };
  };
  const send = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${app.url}/webhooks/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  const signed = (paymentId: string, ts = Date.now(), type = 'payment.succeeded') => {
    const body = JSON.stringify({ type, data: { paymentId } });
    return {
      body,
      headers: {
        'x-provider-timestamp': String(ts),
        'x-provider-signature': signWebhook(WEBHOOK_SECRET, ts, body),
      },
    };
  };

  it('forged, unsigned, tampered, stale and unknown webhooks are refused and credit nothing', async () => {
    const u = await register(app);
    const { paymentId } = await mkTopup(u.id);
    await decidePayment(t.pool, { paymentId, outcome: 'succeeded', chaos: false, now: new Date() });
    const good = signed(paymentId);
    for (const [name, res] of [
      ['unsigned', await send(good.body)],
      [
        'bad signature',
        await send(good.body, { ...good.headers, 'x-provider-signature': 'v1=' + '0'.repeat(64) }),
      ],
      ['tampered body', await send(good.body.replace('succeeded', 'failed'), good.headers)],
      [
        'stale (replay)',
        await send(
          ...(Object.values(signed(paymentId, Date.now() - 10 * 60_000)) as [
            string,
            Record<string, string>,
          ]),
        ),
      ],
    ] as const) {
      expect(res.status, name).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'WEBHOOK_SIGNATURE_INVALID',
      );
    }
    expect(await balanceOf(t.pool, u.id, 'available')).toBe(0);
    const unknown = signed(randomUUID());
    expect((await send(unknown.body, unknown.headers)).status).toBe(404);
  });

  it('a valid webhook credits once; duplicates and a contradicting "failed" afterwards change nothing', async () => {
    const u = await register(app);
    const { paymentId } = await mkTopup(u.id);
    await decidePayment(t.pool, { paymentId, outcome: 'succeeded', chaos: false, now: new Date() });
    const ok = signed(paymentId);
    const results = await Promise.all(Array.from({ length: 10 }, () => send(ok.body, ok.headers)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const bogus = signed(paymentId, Date.now(), 'payment.failed');
    expect((await send(bogus.body, bogus.headers)).status).toBe(200); // accepted as a hint, but the provider says succeeded
    expect(await balanceOf(t.pool, u.id, 'available')).toBe(UAH(500));
    expect(
      await count(
        t.pool,
        `SELECT count(*) AS n FROM ledger_transactions WHERE kind = 'topup' AND user_id = $1`,
        [u.id],
      ),
    ).toBe(1);
  });

  it('the provider status API needs its key; the pay page and the Failure/Close buttons behave', async () => {
    const u = await register(app);
    const { paymentId, topupId } = await mkTopup(u.id);
    expect((await fetch(`${app.url}/provider/payments/${paymentId}`)).status).toBe(401);
    expect(
      (
        await fetch(`${app.url}/provider/payments/${paymentId}`, {
          headers: { authorization: 'Bearer wrong' },
        })
      ).status,
    ).toBe(401);
    const status = await fetch(`${app.url}/provider/payments/${paymentId}`, {
      headers: { authorization: 'Bearer test-provider-api-key-0123456789' },
    });
    expect(await status.json()).toMatchObject({ status: 'pending', reference: topupId });
    const page = await (await fetch(`${app.url}/provider/pay/${paymentId}`)).text();
    for (const label of ['Success', 'Failure', 'Close without answer'])
      expect(page).toContain(label);
    const close = await fetch(`${app.url}/provider/pay/${paymentId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'outcome=close',
      redirect: 'manual',
    });
    expect(close.status).toBe(303);
    expect(
      (
        (await (
          await fetch(`${app.url}/provider/payments/${paymentId}`, {
            headers: { authorization: 'Bearer test-provider-api-key-0123456789' },
          })
        ).json()) as { status: string }
      ).status,
    ).toBe('pending');
    await fetch(`${app.url}/provider/pay/${paymentId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'outcome=failed',
      redirect: 'manual',
    });
    expect(
      (
        (await (
          await fetch(`${app.url}/provider/payments/${paymentId}`, {
            headers: { authorization: 'Bearer test-provider-api-key-0123456789' },
          })
        ).json()) as { status: string }
      ).status,
    ).toBe('failed');
  });
});

describe('moderation and photos over HTTP', () => {
  it('two moderators claiming one queued lot at once: exactly one gets it', async () => {
    const f = await newTestDb(20);
    const a2 = await startApp(testApiConfig(f), 0);
    try {
      const seller = await makeUser(f.pool);
      await f.pool.query(
        `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
      );
      await f.pool.query(
        `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
      );
      await makeLot(f.pool, { sellerId: seller, status: 'in_review' });
      const mods = await Promise.all(Array.from({ length: 8 }, () => loginAs(a2, f, 'moderator')));
      const rs = await Promise.all(
        mods.map((m) => m.c.call('POST', '/moderation/claim', { body: {} })),
      );
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'REVIEW_QUEUE_EMPTY'),
      ).toBe(true);
    } finally {
      await a2.close();
      await f.close();
    }
  });

  it('presign: at most 10 photos per lot, exact type and size pinned, bad requests refused', async () => {
    const { c, id } = await register(app);
    const lot = await makeLot(t.pool, { sellerId: id, status: 'draft' });
    const pre = (body: unknown) => c.call('POST', `/lots/${lot}/photos/presign`, { body });
    const first = await pre({ contentType: 'image/png', size: 5000 });
    expect(first.status).toBe(201);
    const policy = JSON.parse(
      Buffer.from(first.body.upload.fields.Policy, 'base64').toString(),
    ) as { conditions: unknown[] };
    expect(JSON.stringify(policy.conditions)).toContain('["content-length-range",5000,5000]');
    expect(first.body.upload.url).toBe(`${PUBLIC}/upload/bucket`);
    for (let i = 1; i < 10; i++)
      expect((await pre({ contentType: 'image/jpeg', size: 1000 })).status).toBe(201);
    expect((await pre({ contentType: 'image/jpeg', size: 1000 })).body.error.code).toBe(
      'PHOTO_LIMIT_REACHED',
    );
    for (const bad of [
      { contentType: 'image/svg+xml', size: 10 },
      { contentType: 'image/png', size: 0 },
      { contentType: 'image/png', size: 11 * 1024 * 1024 },
      {},
    ]) {
      expect((await pre(bad)).status).toBe(400);
    }
  });
});

describe('abuse: one hostile address must not take everybody else down (check by IP)', () => {
  it('an attacker flooding from one address is cut off with 429; a bystander on another address is unaffected', async () => {
    const f = await newTestDb(20);
    const limited = await startApp(
      testApiConfig(f, {
        rate: {
          global: 60,
          login: 10,
          loginAccount: 100_000,
          register: 100_000,
          bid: 100_000,
          topup: 100_000,
          presign: 100_000,
          search: 100_000,
        },
      }),
      0,
    );
    try {
      const attacker = client(limited);
      const bystander = client(limited);
      const statuses: number[] = [];
      for (let i = 0; i < 150; i++)
        statuses.push((await attacker.call('GET', '/time', { ip: '203.0.113.9' })).status);
      // Fixed one-minute windows: a burst may straddle a boundary, so allow up to two windows' worth.
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(120);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(30);
      expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
      const blocked = await attacker.call('GET', '/time', { ip: '203.0.113.9' });
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      expect(blocked.headers.get('retry-after')).toBeTruthy();
      // The bystander, different address: all fine, and fast.
      const t0 = Date.now();
      const mine = await Promise.all(
        Array.from({ length: 30 }, () => bystander.call('GET', '/time', { ip: '198.51.100.7' })),
      );
      expect(mine.every((r) => r.status === 200)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      await limited.close();
      await f.close();
    }
  });

  it('login guessing is rate limited per address independently of the global budget', async () => {
    const f = await newTestDb(20);
    const limited = await startApp(
      testApiConfig(f, {
        rate: {
          global: 100_000,
          login: 8,
          loginAccount: 100_000,
          register: 100_000,
          bid: 100_000,
          topup: 100_000,
          presign: 100_000,
          search: 100_000,
        },
      }),
      0,
    );
    try {
      const c = client(limited);
      const codes: string[] = [];
      for (let i = 0; i < 20; i++)
        codes.push(
          (
            await c.call('POST', '/auth/login', {
              body: { email: `x${i}@t.test`, password: 'guess-guess' },
              ip: '203.0.113.50',
            })
          ).body.error.code,
        );
      expect(codes.filter((x) => x === 'RATE_LIMITED').length).toBeGreaterThanOrEqual(10);
      expect(
        (
          await c.call('POST', '/auth/login', {
            body: { email: 'y@t.test', password: 'guess-guess' },
            ip: '198.51.100.99',
          })
        ).body.error.code,
      ).toBe('INVALID_CREDENTIALS');
    } finally {
      await limited.close();
      await f.close();
    }
  });

  it('a spoofed X-Forwarded-For from an untrusted client cannot reset the attacker’s budget', async () => {
    const f = await newTestDb(20);
    // Here the direct peer (127.0.0.1) is NOT a trusted proxy, so the header must be ignored.
    const strict = await startApp(
      testApiConfig(f, {
        trustProxy: '10.255.255.254',
        rate: {
          global: 40,
          login: 100_000,
          loginAccount: 100_000,
          register: 100_000,
          bid: 100_000,
          topup: 100_000,
          presign: 100_000,
          search: 100_000,
        },
      }),
      0,
    );
    try {
      const c = client(strict);
      const statuses: number[] = [];
      for (let i = 0; i < 120; i++)
        statuses.push((await c.call('GET', '/time', { ip: `198.51.100.${i % 250}` })).status);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(80);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(30);
    } finally {
      await strict.close();
      await f.close();
    }
  });

  it('with Redis lost the limiter keeps counting in memory: the limit cannot be switched off', async () => {
    const f = await newTestDb(20);
    const deadRedis = await startApp(
      testApiConfig(f, {
        redisUrl: 'redis://127.0.0.1:1',
        rate: {
          global: 25,
          login: 100_000,
          loginAccount: 100_000,
          register: 100_000,
          bid: 100_000,
          topup: 100_000,
          presign: 100_000,
          search: 100_000,
        },
      }),
      0,
    );
    try {
      const c = client(deadRedis);
      const s: number[] = [];
      for (let i = 0; i < 60; i++)
        s.push((await c.call('GET', '/time', { ip: '203.0.113.77' })).status);
      expect(s.filter((x) => x === 200).length).toBeLessThanOrEqual(50);
      expect(s.filter((x) => x === 429).length).toBeGreaterThan(8);
    } finally {
      await deadRedis.close();
      await f.close();
    }
  });
});

describe('invariant 10/14: sockets', () => {
  it('private notifications reach only their addressee; anonymous and other users get nothing', async () => {
    const seller = await register(app);
    const a = await register(app, 'alice9');
    const b = await register(app, 'bobby9');
    await fund(t.pool, a.id, UAH(5000));
    await fund(t.pool, b.id, UAH(5000));
    const lot = await makeLot(t.pool, { sellerId: seller.id, now: new Date() });
    const [sa, sb, sx] = [socket(app, a.c.cookie), socket(app, b.c.cookie), socket(app, null)];
    await Promise.all([sa, sb, sx].map(waitConnected));
    const gotA = collect(sa, 'notification'),
      gotB = collect(sb, 'notification'),
      gotX = collect(sx, 'notification');
    try {
      expect((await ack(sx, 'lot:subscribe', { lotId: lot })).ok).toBe(true); // lots are public
      await a.c.call('POST', `/lots/${lot}/bids`, {
        body: { kind: 'manual', amount: UAH(100) },
        idem: idem(),
      });
      await b.c.call('POST', `/lots/${lot}/bids`, {
        body: { kind: 'manual', amount: UAH(200) },
        idem: idem(),
      }); // outbids a
      await new Promise((r) => setTimeout(r, 800));
      expect(gotA.map((m) => m.kind)).toEqual(['outbid']);
      expect(gotB).toEqual([]);
      expect(gotX).toEqual([]);
    } finally {
      [sa, sb, sx].forEach((s) => s.close());
    }
  });

  it('lot events reach subscribers with numbered, reserve-free payloads; drafts cannot be subscribed to; there is no way to join someone else’s room', async () => {
    const seller = await register(app);
    const a = await register(app);
    const victim = await register(app);
    await fund(t.pool, a.id, UAH(5000));
    const lot = await makeLot(t.pool, {
      sellerId: seller.id,
      reservePrice: UAH(7777.77),
      now: new Date(),
    });
    const draft = await makeLot(t.pool, { sellerId: seller.id, status: 'draft' });
    const s = socket(app, a.c.cookie);
    await waitConnected(s);
    const events = collect(s, 'lot:event');
    const stolen = collect(s, 'notification');
    try {
      expect((await ack(s, 'lot:subscribe', { lotId: draft })).code).toBe('NOT_FOUND');
      expect((await ack(s, 'lot:subscribe', { lotId: 'x' })).code).toBe('VALIDATION_FAILED');
      expect((await ack(s, 'lot:subscribe', { lotId: lot })).ok).toBe(true);
      await a.c.call('POST', `/lots/${lot}/bids`, {
        body: { kind: 'manual', amount: UAH(150) },
        idem: idem(),
      });
      await new Promise((r) => setTimeout(r, 600));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ lotId: lot, seq: 1, type: 'bid' });
      expect(JSON.stringify(events)).not.toContain('777777');
      // Trying to join another user's private room through every message we can think of changes nothing.
      for (const ev of ['join', 'room:join', 'subscribe', 'user:subscribe'])
        s.emit(ev, { room: `user:${victim.id}`, userId: victim.id });
      expect((await ack(s, 'lot:subscribe', { lotId: `user:${victim.id}` })).ok).toBe(false);
      await victim.c.call('POST', '/me/topups', { body: { amount: 1000 }, idem: idem() });
      await new Promise((r) => setTimeout(r, 300));
      expect(stolen).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('flooding a socket gets it disconnected', async () => {
    const s = socket(app, null);
    await waitConnected(s);
    const closed = new Promise<string>((res) => s.on('disconnect', res));
    for (let i = 0; i < 200; i++) s.emit('lot:subscribe', { lotId: randomUUID() });
    expect(
      await Promise.race([
        closed,
        new Promise((r) => setTimeout(() => r('still connected'), 4000)),
      ]),
    ).not.toBe('still connected');
  });
});

describe('server clock and test-only routes', () => {
  it('GET /time returns server time; the test clock route does not exist unless TEST_CLOCK is on', async () => {
    const before = Date.now();
    const r = await client(app).call('GET', '/time');
    expect(Math.abs(r.body.serverNow - before)).toBeLessThan(2000);
    const off = await client(app).call('POST', '/__test/clock', { body: { offsetMs: 3_600_000 } });
    expect(off.status).toBe(404);
    expect(off.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('with TEST_CLOCK on, the server clock can be moved (and only then)', async () => {
    const f = await newTestDb(10);
    const on = await startApp(testApiConfig(f, { testClock: true }), 0);
    try {
      const c = client(on);
      await c.call('POST', '/__test/clock', { body: { offsetMs: 3_600_000 } });
      const r = await c.call('GET', '/time');
      expect(r.body.serverNow - Date.now()).toBeGreaterThan(3_500_000);
    } finally {
      await on.close();
      await f.close();
    }
  });
});

void errorResponseSchema;
void lotRow;

describe('sockets after logout', () => {
  it('logout disconnects the sockets of that session only and no private event reaches them afterwards', async () => {
    const a = await register(app, 'logoutA');
    const other = client(app);
    const login = await other.call('POST', '/auth/login', {
      body: { email: a.email, password: 'Passw0rd!' },
    });
    expect(login.status).toBe(200);
    const [s1, s2, sOther] = [
      socket(app, a.c.cookie),
      socket(app, a.c.cookie),
      socket(app, other.cookie),
    ];
    await Promise.all([s1, s2, sOther].map(waitConnected));
    await new Promise((r) => setTimeout(r, 400)); // the server authenticates the handshake asynchronously
    const got1 = collect(s1, 'notification');
    const closed = Promise.all(
      [s1, s2].map((s) => new Promise<string>((res) => s.on('disconnect', res))),
    );
    try {
      expect((await a.c.call('POST', '/auth/logout')).status).toBe(204);
      const outcome = await Promise.race([
        closed,
        new Promise((r) => setTimeout(() => r('still connected'), 3000)),
      ]);
      expect(outcome).not.toBe('still connected');
      expect(s1.connected || s2.connected).toBe(false);
      expect(sOther.connected).toBe(true); // a different session of the same user stays
      await other.call('POST', '/me/topups', { body: { amount: 1000 }, idem: idem() });
      await new Promise((r) => setTimeout(r, 400));
      expect(got1).toEqual([]);
    } finally {
      [s1, s2, sOther].forEach((s) => s.close());
    }
  });
});
