import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTestDb, type TestDb } from '@auction/test-kit';
import {
  createPayment,
  decidePayment,
  deliverDueWebhooks,
  getPayment,
  MAX_DELAY_MS,
  planDeliveries,
  signWebhook,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhook,
  type Fetcher,
} from '../src/index.js';

const SECRET = 'test-webhook-secret-0123456789';
const NOW = new Date('2026-06-01T12:00:00Z');

describe('signature (invariant 6: a forged webhook is refused)', () => {
  const body = JSON.stringify({ type: 'payment.succeeded', data: { amount: 5000 } });
  const ts = NOW.getTime();
  const good = signWebhook(SECRET, ts, body);
  const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({
      secret: SECRET,
      signature: good,
      timestamp: String(ts),
      body,
      nowMs: ts + 1000,
      ...over,
    });

  it('accepts a correct, fresh signature', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it.each([
    ['no signature', { signature: undefined }, 'missing'],
    ['no timestamp', { timestamp: undefined }, 'missing'],
    ['empty signature', { signature: '' }, 'missing'],
    ['wrong secret', { secret: 'another-secret-another-secret' }, 'bad_signature'],
    ['tampered body (amount changed)', { body: body.replace('5000', '5000000') }, 'bad_signature'],
    ['tampered timestamp', { timestamp: String(ts + 1) }, 'bad_signature'],
    ['signature of another body', { signature: signWebhook(SECRET, ts, 'other') }, 'bad_signature'],
    ['garbage signature', { signature: 'v1=deadbeef' }, 'bad_signature'],
    ['wrong length signature', { signature: `${good}00` }, 'bad_signature'],
    ['non-numeric timestamp', { timestamp: 'yesterday' }, 'bad_signature'],
    ['timestamp with a sign', { timestamp: `-${ts}` }, 'bad_signature'],
    ['replay after 6 minutes', { nowMs: ts + 6 * 60_000 }, 'stale'],
    ['clock far in the past', { nowMs: ts - 6 * 60_000 }, 'stale'],
  ] as const)('refuses %s', (_name, over, reason) => {
    expect(verify(over)).toEqual({ ok: false, reason });
  });

  it('a signature made over the right text but with an unsigned timestamp header cannot be moved to a new time', () => {
    // Attacker re-uses a captured signature with a fresh timestamp header.
    expect(verify({ timestamp: String(ts + 5 * 60_000), nowMs: ts + 5 * 60_000 })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('verification is exact for random bodies and secrets, and any single-character change breaks it', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 16 }),
        fc.nat(40),
        (b, secret, pos) => {
          const sig = signWebhook(secret, ts, b);
          expect(
            verifyWebhook({ secret, signature: sig, timestamp: String(ts), body: b, nowMs: ts }),
          ).toEqual({ ok: true });
          const changed =
            b.slice(0, pos % b.length) +
            (b[pos % b.length] === 'x' ? 'y' : 'x') +
            b.slice((pos % b.length) + 1);
          expect(
            verifyWebhook({
              secret,
              signature: sig,
              timestamp: String(ts),
              body: changed,
              nowMs: ts,
            }).ok,
          ).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('chaos planner', () => {
  const seeded = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it('without chaos: exactly one honest webhook, right now', () => {
    for (const outcome of ['succeeded', 'failed'] as const) {
      const plan = planDeliveries(outcome, { chaos: false, now: NOW, random: () => 0.5 });
      expect(plan).toEqual([{ event: `payment.${outcome}`, deliverAt: NOW }]);
    }
  });

  it('with chaos every misbehaviour really happens, and the delay never exceeds a minute', () => {
    const random = seeded(7);
    const seen = { lost: 0, dup: 0, outOfOrder: 0, delayed: 0, plain: 0 };
    for (let i = 0; i < 3000; i++) {
      const plan = planDeliveries('succeeded', { chaos: true, now: NOW, random });
      if (plan.length === 0) seen.lost++;
      else {
        const honest = plan.filter((p) => p.event === 'payment.succeeded');
        const bogus = plan.filter((p) => p.event === 'payment.failed');
        if (honest.length > 1) seen.dup++;
        if (bogus.length > 0) {
          seen.outOfOrder++;
          // The contradicting event always arrives AFTER the first honest one.
          expect(Math.min(...bogus.map((b) => b.deliverAt.getTime()))).toBeGreaterThan(
            Math.min(...honest.map((h) => h.deliverAt.getTime())),
          );
        }
        if (plan[0] && plan[0].deliverAt.getTime() > NOW.getTime()) seen.delayed++;
        if (plan.length === 1 && plan[0]?.deliverAt.getTime() === NOW.getTime()) seen.plain++;
        for (const p of plan) {
          expect(p.deliverAt.getTime() - NOW.getTime()).toBeLessThanOrEqual(MAX_DELAY_MS + 40_000);
          expect(p.deliverAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
        }
        expect(honest.length).toBeGreaterThanOrEqual(1);
      }
    }
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(50);
  });

  it('the opposite also holds: a failed payment can be followed by a bogus "succeeded"', () => {
    const random = seeded(3);
    let bogus = 0;
    for (let i = 0; i < 2000; i++) {
      if (
        planDeliveries('failed', { chaos: true, now: NOW, random }).some(
          (p) => p.event === 'payment.succeeded',
        )
      )
        bogus++;
    }
    expect(bogus).toBeGreaterThan(50);
  });
});

describe('payments and webhook delivery against a real database and HTTP server', () => {
  let t: TestDb;
  let server: http.Server;
  let url: string;
  const received: { headers: http.IncomingHttpHeaders; body: string; status: number }[] = [];
  let respondWith = 200;

  beforeAll(async () => {
    t = await newTestDb();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          status: respondWith,
        });
        res.statusCode = respondWith;
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(async () => {
    server.close();
    await t.close();
  });

  const fetcher: Fetcher = async (u, init) => {
    const res = await fetch(u, init);
    return { status: res.status };
  };
  const mk = (amount = 5000) =>
    createPayment(t.pool, { amount, reference: randomUUID(), notifyUrl: url, now: NOW });
  const events = async (paymentId: string) =>
    (
      await t.pool.query<{ event: string; delivered_at: Date | null; attempts: number }>(
        `SELECT event, delivered_at, attempts FROM provider.webhook_events WHERE payment_id = $1 ORDER BY id`,
        [paymentId],
      )
    ).rows;

  it('a payment is created once per reference; the same reference with another amount is refused', async () => {
    const reference = randomUUID();
    const a = await createPayment(t.pool, { amount: 5000, reference, notifyUrl: url, now: NOW });
    const b = await createPayment(t.pool, { amount: 5000, reference, notifyUrl: url, now: NOW });
    expect(b.id).toBe(a.id);
    await expect(
      createPayment(t.pool, { amount: 9999, reference, notifyUrl: url, now: NOW }),
    ).rejects.toThrow(/different amount/);
    expect(await getPayment(t.pool, a.id)).toMatchObject({ status: 'pending', amount: 5000 });
    expect(await getPayment(t.pool, 'not-a-uuid')).toBeNull();
    expect(await getPayment(t.pool, randomUUID())).toBeNull();
  });

  it('the first click settles the payment and schedules one webhook; later clicks (even contradicting) change nothing', async () => {
    const p = await mk();
    const first = await decidePayment(t.pool, {
      paymentId: p.id,
      outcome: 'succeeded',
      chaos: false,
      now: NOW,
    });
    expect(first).toEqual({ applied: true, status: 'succeeded', webhooksPlanned: 1 });
    const second = await decidePayment(t.pool, {
      paymentId: p.id,
      outcome: 'failed',
      chaos: false,
      now: NOW,
    });
    expect(second).toEqual({ applied: false, status: 'succeeded', webhooksPlanned: 0 });
    expect((await events(p.id)).map((e) => e.event)).toEqual(['payment.succeeded']);
    await expect(
      decidePayment(t.pool, {
        paymentId: randomUUID(),
        outcome: 'succeeded',
        chaos: false,
        now: NOW,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('50 simultaneous clicks, half "success" and half "failure": one verdict, one webhook', async () => {
    const p = await mk();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        decidePayment(t.pool, {
          paymentId: p.id,
          outcome: i % 2 ? 'succeeded' : 'failed',
          chaos: false,
          now: NOW,
        }),
      ),
    );
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(new Set(results.map((r) => r.status)).size).toBe(1);
    expect(await events(p.id)).toHaveLength(1);
  });

  it('"close without answer": the payment stays pending and nothing is ever sent', async () => {
    const p = await mk();
    await deliverDueWebhooks(t.pool, {
      secret: SECRET,
      fetcher,
      now: () => new Date(NOW.getTime() + 3600_000),
    });
    expect((await getPayment(t.pool, p.id))?.status).toBe('pending');
    expect(await events(p.id)).toEqual([]);
    expect(received.filter((r) => r.body.includes(p.id))).toHaveLength(0);
  });

  it('delivers a correctly signed webhook that a receiver can verify, exactly once', async () => {
    const p = await mk(7777);
    await decidePayment(t.pool, { paymentId: p.id, outcome: 'succeeded', chaos: false, now: NOW });
    received.length = 0;
    const report = await deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => NOW });
    expect(report.sent).toBeGreaterThanOrEqual(1);
    const mine = received.filter((r) => r.body.includes(p.id));
    expect(mine).toHaveLength(1);
    const msg = mine[0]!;
    expect(
      verifyWebhook({
        secret: SECRET,
        signature: String(msg.headers[SIGNATURE_HEADER]),
        timestamp: String(msg.headers[TIMESTAMP_HEADER]),
        body: msg.body,
        nowMs: NOW.getTime(),
      }),
    ).toEqual({ ok: true });
    expect(JSON.parse(msg.body)).toMatchObject({
      type: 'payment.succeeded',
      data: { paymentId: p.id, amount: 7777, status: 'succeeded', reference: p.reference },
    });
    // Delivered rows are not sent again.
    received.length = 0;
    await deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => NOW });
    expect(received.filter((r) => r.body.includes(p.id))).toHaveLength(0);
  });

  it('a delayed webhook is not sent before it is due', async () => {
    const p = await mk();
    await decidePayment(t.pool, {
      paymentId: p.id,
      outcome: 'succeeded',
      chaos: true,
      now: NOW,
      random: (() => {
        const seq = [0.9, 0.0, 0.5, 0.99, 0.99];
        let i = 0;
        return () => seq[i++ % seq.length] as number;
      })(),
    });
    const rows = await events(p.id);
    expect(rows.length).toBeGreaterThan(0);
    received.length = 0;
    await deliverDueWebhooks(t.pool, {
      secret: SECRET,
      fetcher,
      now: () => new Date(NOW.getTime() - 1),
    });
    expect(received.filter((r) => r.body.includes(p.id))).toHaveLength(0);
    await deliverDueWebhooks(t.pool, {
      secret: SECRET,
      fetcher,
      now: () => new Date(NOW.getTime() + 2 * 60_000),
    });
    expect(received.filter((r) => r.body.includes(p.id)).length).toBe(rows.length);
  });

  it('five senders running at once deliver every webhook exactly once', async () => {
    const payments = await Promise.all(Array.from({ length: 30 }, () => mk()));
    for (const p of payments)
      await decidePayment(t.pool, {
        paymentId: p.id,
        outcome: 'succeeded',
        chaos: false,
        now: NOW,
      });
    received.length = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => NOW, batch: 7 }),
      ),
    );
    // Drain whatever the first round (batch 7 × 5) did not reach.
    await deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => NOW, batch: 100 });
    const counts = new Map<string, number>();
    for (const r of received) {
      const id = (JSON.parse(r.body) as { data: { paymentId: string } }).data.paymentId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const p of payments) expect(counts.get(p.id), p.id).toBe(1);
  });

  it('a failing receiver is retried with back-off, then the row is given up after 8 attempts', async () => {
    const p = await mk();
    await decidePayment(t.pool, { paymentId: p.id, outcome: 'succeeded', chaos: false, now: NOW });
    respondWith = 500;
    let clock = NOW.getTime();
    for (let i = 0; i < 12; i++) {
      await deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => new Date(clock) });
      clock += 2 * 60_000;
    }
    const rows = await events(p.id);
    expect(rows[0]).toMatchObject({ delivered_at: null, attempts: 8 });
    // Receiver recovers: the given-up row stays given up (the reconciler is the safety net).
    respondWith = 200;
    received.length = 0;
    await deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => new Date(clock) });
    expect(received.filter((r) => r.body.includes(p.id))).toHaveLength(0);
  });

  it('a receiver that is down (connection refused) does not break the sender', async () => {
    const p = await createPayment(t.pool, {
      amount: 1000,
      reference: randomUUID(),
      notifyUrl: 'http://127.0.0.1:1/hook',
      now: NOW,
    });
    await decidePayment(t.pool, { paymentId: p.id, outcome: 'failed', chaos: false, now: NOW });
    const r = await deliverDueWebhooks(t.pool, { secret: SECRET, fetcher, now: () => NOW });
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect((await events(p.id))[0]).toMatchObject({ delivered_at: null, attempts: 1 });
  });
});
