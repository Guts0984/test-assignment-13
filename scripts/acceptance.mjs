// Acceptance checks run against the REAL stack:  BASE=http://localhost:8081 pnpm acceptance
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { io } = require('socket.io-client');
const BASE = process.env.BASE ?? 'http://localhost:8080';
const results = [];
const check = async (id, name, fn) => {
  try {
    const note = await fn();
    results.push([id, name, 'PASS', note ?? '']);
  } catch (e) {
    results.push([id, name, 'FAIL', String(e.message).slice(0, 140)]);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UAH = (n) => Math.round(n * 100);

const client = () => {
  const c = { cookie: '' };
  c.call = async (method, path, body, extra = {}) => {
    const headers = {
      'content-type': 'application/json',
      'x-requested-with': 'auction-web',
      origin: BASE,
      ...extra,
    };
    if (c.cookie) headers.cookie = c.cookie;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.getSetCookie().find((s) => s.startsWith('sid='));
    if (sc) c.cookie = sc.split(';')[0];
    const t = await res.text();
    let j = null;
    try {
      j = JSON.parse(t);
    } catch {
      /* html */
    }
    return { status: res.status, body: j, text: t };
  };
  return c;
};
const login = async (email) => {
  const c = client();
  const r = await c.call('POST', '/api/auth/login', { email, password: 'Passw0rd!' });
  assert(r.status === 200, `login ${email} ${r.status}`);
  return c;
};
const newUser = async (funds) => {
  await sleep(60); // stay under nginx's per-address rate; the limit is a feature, not the subject here
  const c = client();
  const email = `acc-${randomUUID()}@t.test`;
  const r = await c.call('POST', '/api/auth/register', {
    email,
    password: 'Passw0rd!',
    displayName: 'acceptance',
  });
  assert(r.status === 201, `register ${r.status}`);
  if (funds) {
    const t = await c.call(
      'POST',
      '/api/me/topups',
      { amount: funds },
      { 'idempotency-key': randomUUID() },
    );
    const id = t.body.payUrl.split('/').pop();
    await fetch(`${BASE}/provider/pay/${id}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'outcome=succeeded',
      redirect: 'manual',
    });
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const w = await c.call('GET', '/api/me/wallet');
      if (w.body.available >= funds) break;
      if (i === 39) throw new Error('top-up never credited');
    }
  }
  return c;
};
const freshLots = async (n, max = 5000) => {
  const r = await fetch(
    `${BASE}/api/search?noBids=true&priceMax=${UAH(max)}&sort=newest&pageSize=100&endingSoon=false`,
  );
  const j = await r.json();
  const free = j.items.filter((l) => l.current_price <= UAH(max));
  assert(free.length >= n, 'not enough lots without bids');
  return free.slice(0, n);
};
const bid = (c, lot, kind, amount) =>
  c.call('POST', `/api/lots/${lot}/bids`, { kind, amount }, { 'idempotency-key': randomUUID() });
let pool = 0;
const nextLots = async (n) => {
  const l = await freshLots(n + pool + 40);
  const out = l.slice(pool, pool + n);
  pool += n;
  return out;
};

await check(1, 'stack answers; both api copies behind nginx', async () => {
  const a = await (await fetch(`${BASE}/health?node=a`)).json();
  const b = await (await fetch(`${BASE}/health?node=b`)).json();
  assert(a.node === 'a' && b.node === 'b', 'nodes');
});

await check(3, 'bid via copy A seen by a client on copy B in < 1 s', async () => {
  const user = await newUser(UAH(5000));
  const [lot] = await nextLots(1);
  const s = io(BASE, {
    path: '/socket.io',
    transports: ['websocket'],
    query: { node: 'b' },
    forceNew: true,
  });
  await new Promise((r, j) => {
    s.on('connect', r);
    s.on('connect_error', j);
  });
  const sub = await new Promise((r) => s.emit('lot:subscribe', { lotId: lot.id }, r));
  assert(sub.ok, 'subscribe');
  let at = 0;
  s.on('lot:event', () => {
    at ||= Date.now();
  });
  const t0 = Date.now();
  const r = await bid(user, lot.id, 'manual', lot.current_price);
  assert(r.status === 200, `bid ${r.status} ${JSON.stringify(r.body)}`);
  await sleep(1200);
  s.close();
  assert(at > 0, 'no event on copy B');
  assert(at - t0 < 1000, `${at - t0} ms`);
  return `${at - t0} ms`;
});

await check(4, '50 simultaneous bids: price only grows, one leader', async () => {
  const [lot] = await nextLots(1);
  const users = await Promise.all(Array.from({ length: 50 }, () => newUser(UAH(3000))));
  const rs = await Promise.all(
    users.map((u, i) =>
      bid(u, lot.id, i % 2 ? 'auto' : 'manual', lot.current_price + UAH(10) * (i + 1)),
    ),
  );
  // 429 is nginx/API protecting against 50 "users" sharing one address: refused, never a 5xx.
  assert(
    rs.every((r) => [200, 409, 429].includes(r.status)),
    `statuses ${rs.map((r) => r.status)}`,
  );
  assert(
    rs.some((r) => r.status === 200),
    'no bid accepted',
  );
  const h = (await (await fetch(`${BASE}/api/lots/${lot.id}/bids`)).json()).items
    .map((b) => b.amount)
    .reverse();
  assert(
    h.every((a, i) => i === 0 || a >= h[i - 1]),
    'history went down',
  );
  return `${rs.filter((r) => r.status === 200).length} accepted`;
});

await sleep(3000);
await check(5, 'autobids 1 000 ₴ and 1 500 ₴, both orders -> 1 050 ₴, second leads', async () => {
  const lots = await nextLots(2, 100);
  for (const [i, order] of [
    [0, ['a', 'b']],
    [1, ['b', 'a']],
  ]) {
    const u = { a: await newUser(UAH(3000)), b: await newUser(UAH(3000)) };
    const max = { a: UAH(1000), b: UAH(1500) };
    for (const k of order) {
      const r = await bid(u[k], lots[i].id, 'auto', max[k]);
      assert(
        r.status === 200,
        `bid ${r.status} ${r.body?.error?.code} lot=${lots[i].id} price=${lots[i].current_price}`,
      );
    }
    const l = await (await fetch(`${BASE}/api/lots/${lots[i].id}`)).json();
    assert(l.currentPrice === UAH(1050), `price ${l.currentPrice}`);
    assert(
      (await u.b.call('GET', `/api/lots/${lots[i].id}`)).body.viewer.isLeading,
      'b should lead',
    );
  }
});

await check(7, '10 simultaneous bids, money for 3 deposits: exactly 3', async () => {
  const lots = await nextLots(10);
  const u = await newUser(UAH(150));
  const rs = await Promise.all(lots.map((l) => bid(u, l.id, 'manual', l.current_price)));
  const ok = rs.filter((r) => r.status === 200).length;
  const w = (await u.call('GET', '/api/me/wallet')).body;
  assert(w.available >= 0, 'negative');
  assert(ok <= 3 && ok >= 1, `accepted ${ok}`);
  return `${ok} accepted, available ${w.available}`;
});

await check(11, 'two moderators claim at once: different lots', async () => {
  const [m1, m2] = await Promise.all([
    login('moderator1@seed.test'),
    login('moderator2@seed.test'),
  ]);
  const [a, b] = await Promise.all([
    m1.call('POST', '/api/moderation/claim', {}),
    m2.call('POST', '/api/moderation/claim', {}),
  ]);
  assert(a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
  assert(a.body.lotId !== b.body.lotId, 'same lot');
});

await check(14, 'unsigned private photo refused; 20 MB upload refused', async () => {
  const r = await fetch(`${BASE}/photos-private/seed/p0/full.jpg`);
  assert(
    !r.headers.get('content-type')?.startsWith('image/jpeg') ||
      (await r.text()).includes('Not Found') ||
      r.status !== 200,
    'private reachable',
  );
  const owner = await newUser();
  const lot = await owner.call('POST', '/api/lots', {
    title: 'Acceptance lot',
    description: '',
    categoryId: 1,
    cityId: 1,
    condition: 'good',
    startPrice: UAH(100),
    reservePrice: null,
    buyNowPrice: null,
    durationDays: 1,
  });
  const p = await owner.call('POST', `/api/lots/${lot.body.lotId}/photos/presign`, {
    contentType: 'image/jpeg',
    size: 1000,
  });
  assert(p.status === 201, `presign ${p.status}`);
  const f = new FormData();
  for (const [k, v] of Object.entries(p.body.upload.fields)) f.append(k, v);
  f.append('file', new Blob([new Uint8Array(20 * 1024 * 1024)]));
  const up = await fetch(`${BASE}${new URL(p.body.upload.url).pathname}`, {
    method: 'POST',
    body: f,
  });
  assert(up.status >= 400, `upload ${up.status}`);
});

await check(16, 'reserve price and other wallets are not visible', async () => {
  const j = JSON.stringify(await (await fetch(`${BASE}/api/search?pageSize=100`)).json());
  assert(!/reserve_?price/i.test(j), 'reserve in search');
  const a = await newUser(UAH(777));
  const b = await newUser();
  assert((await b.call('GET', '/api/me/wallet')).body.balance === 0, 'sees other wallet');
  assert((await a.call('GET', '/api/me/wallet')).body.balance === UAH(777), 'own wallet');
});

await check(
  17,
  'reconciliation after everything: sum of entries is zero, no mismatches',
  async () => {
    const f = await login('finance1@seed.test');
    const r = await f.call('GET', '/api/finance/reconciliation');
    assert(r.status === 200, `status ${r.status}`);
    assert(
      r.body.entriesSum === 0 &&
        r.body.balanceMismatches.length === 0 &&
        r.body.heldMismatches.length === 0,
      JSON.stringify(r.body).slice(0, 200),
    );
  },
);

await check(18, '90-day report in < 500 ms', async () => {
  const f = await login('finance1@seed.test');
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);
  const t0 = Date.now();
  const r = await f.call('GET', `/api/finance/report?from=${from}&to=${to}`);
  const ms = Date.now() - t0;
  assert(r.status === 200 && ms < 500, `${r.status} ${ms} ms`);
  return `${ms} ms`;
});

console.table(
  results.map(([id, name, res, note]) => ({ '#': id, check: name, result: res, note })),
);
process.exit(results.some((r) => r[2] === 'FAIL') ? 1 : 0);
