/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- test code inspects arbitrary JSON bodies dynamically */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTestDb, type TestDb } from '@auction/test-kit';
import { startApp, type RunningApp } from '../src/app.js';
import {
  UAH,
  ack,
  collect,
  fund,
  makeLot,
  register,
  socket,
  testApiConfig,
  waitConnected,
} from './support.js';

/** Two api copies on one Postgres and one Redis, like the two replicas behind nginx. */
let t: TestDb;
let a: RunningApp;
let b: RunningApp;
beforeAll(async () => {
  t = await newTestDb(60);
  await t.pool.query(
    `INSERT INTO categories (id, slug, name_uk, name_en, name_pl) VALUES (1,'a','a','a','a') ON CONFLICT DO NOTHING`,
  );
  await t.pool.query(
    `INSERT INTO cities (id, slug, name_uk, name_en, name_pl) VALUES (1,'x','x','x','x') ON CONFLICT DO NOTHING`,
  );
  a = await startApp(testApiConfig(t, { nodeId: 'a' }), 0);
  b = await startApp(testApiConfig(t, { nodeId: 'b' }), 0);
});
afterAll(async () => {
  await a.close();
  await b.close();
  await t.close();
});

const idem = () => randomUUID();

describe('invariant 10: live updates through both api copies', () => {
  it('a bid accepted by copy A reaches a client connected to copy B in well under a second (p99 of 60 bids)', async () => {
    const seller = await register(a);
    const bidder = await register(a);
    await fund(t.pool, bidder.id, UAH(1_000_000));
    const lot = await makeLot(t.pool, {
      sellerId: seller.id,
      startPrice: UAH(100),
      now: new Date(),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const viewer = socket(b, null);
    await waitConnected(viewer);
    expect((await ack(viewer, 'lot:subscribe', { lotId: lot })).ok).toBe(true);
    const arrivals = new Map<number, number>();
    viewer.on('lot:event', (m: { seq: number }) => arrivals.set(m.seq, Date.now()));
    const latencies: number[] = [];
    try {
      for (let i = 0; i < 60; i++) {
        const sent = Date.now();
        const r = await bidder.c.call('POST', `/lots/${lot}/bids`, {
          body: { kind: 'manual', amount: UAH(100 + i * 20) },
          idem: idem(),
        });
        expect(r.status).toBe(200);
        // wait for event i+1
        const deadline = Date.now() + 2000;
        while (!arrivals.has(i + 1) && Date.now() < deadline)
          await new Promise((x) => setTimeout(x, 5));
        expect(arrivals.has(i + 1), `event ${i + 1} reached copy B`).toBe(true);
        latencies.push((arrivals.get(i + 1) as number) - sent);
      }
    } finally {
      viewer.close();
    }
    latencies.sort((x, y) => x - y);
    expect(latencies[Math.floor(latencies.length * 0.99) - 1] as number).toBeLessThan(1000);
    expect(latencies[Math.floor(latencies.length / 2)] as number).toBeLessThan(300);
  });

  it('a private notification emitted by copy A reaches only its addressee, who is connected to copy B', async () => {
    const seller = await register(a);
    const x = await register(a, 'xavier');
    const y = await register(a, 'yaroslav');
    await fund(t.pool, x.id, UAH(5000));
    await fund(t.pool, y.id, UAH(5000));
    const lot = await makeLot(t.pool, { sellerId: seller.id, now: new Date() });
    const sx = socket(b, x.c.cookie);
    const sy = socket(b, y.c.cookie);
    await Promise.all([waitConnected(sx), waitConnected(sy)]);
    const gx = collect(sx, 'notification');
    const gy = collect(sy, 'notification');
    try {
      await x.c.call('POST', `/lots/${lot}/bids`, {
        body: { kind: 'manual', amount: UAH(100) },
        idem: idem(),
      });
      await y.c.call('POST', `/lots/${lot}/bids`, {
        body: { kind: 'manual', amount: UAH(200) },
        idem: idem(),
      });
      await new Promise((r) => setTimeout(r, 700));
      expect(gx.map((m) => m.kind)).toEqual(['outbid']);
      expect(gy).toEqual([]);
    } finally {
      sx.close();
      sy.close();
    }
  });

  it('a client offline during bidding catches up by sequence number and never shows a stale price (acceptance 12)', async () => {
    const seller = await register(a);
    const bidder = await register(a);
    await fund(t.pool, bidder.id, UAH(100_000));
    const lot = await makeLot(t.pool, {
      sellerId: seller.id,
      startPrice: UAH(100),
      now: new Date(),
      endsAt: new Date(Date.now() + 86_400_000),
    });
    const first = socket(b, null);
    await waitConnected(first);
    await ack(first, 'lot:subscribe', { lotId: lot });
    const seen: number[] = [];
    first.on('lot:event', (m: { seq: number }) => seen.push(m.seq));
    await bidder.c.call('POST', `/lots/${lot}/bids`, {
      body: { kind: 'manual', amount: UAH(100) },
      idem: idem(),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toEqual([1]);
    first.close(); // the client drops off for a while

    for (let i = 1; i <= 5; i++)
      await bidder.c.call('POST', `/lots/${lot}/bids`, {
        body: { kind: 'manual', amount: UAH(100 + i * 20) },
        idem: idem(),
      });

    // Reconnect (to the OTHER copy this time) and catch up from the last number it had.
    const again = socket(a, null);
    await waitConnected(again);
    const sub = await ack(again, 'lot:subscribe', { lotId: lot });
    expect(sub.latestSeq).toBe(6);
    const missed = (await (await fetch(`${b.url}/lots/${lot}/events?after=1`)).json()) as {
      latestSeq: number;
      events: { seq: number; payload: any }[];
      serverNow: number;
    };
    expect(missed.events.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(missed.latestSeq).toBe(6);
    // The latest event matches the lot page: no stale price.
    const page = (await (await fetch(`${a.url}/lots/${lot}`)).json()) as {
      currentPrice: number;
      eventSeq: number;
    };
    expect(page.currentPrice).toBe(missed.events.at(-1)?.payload.currentPrice);
    expect(page.eventSeq).toBe(6);
    again.close();
  });

  it('the countdown uses the server clock: a client whose clock is 5 minutes off still computes the right remaining time', async () => {
    const seller = await register(a);
    const endsAt = Date.now() + 90 * 60_000;
    const lot = await makeLot(t.pool, {
      sellerId: seller.id,
      now: new Date(),
      endsAt: new Date(endsAt),
    });
    const clientClock = () => Date.now() - 5 * 60_000; // a wrong clock
    const t0 = clientClock();
    const page = (await (await fetch(`${a.url}/lots/${lot}`)).json()) as {
      serverNow: number;
      endsAt: string;
    };
    const t1 = clientClock();
    const offset = page.serverNow - (t0 + t1) / 2; // NTP-style estimate of server − client
    const remaining = new Date(page.endsAt).getTime() - (clientClock() + offset);
    expect(Math.abs(remaining - 90 * 60_000)).toBeLessThan(1500);
    const naive = new Date(page.endsAt).getTime() - clientClock();
    expect(Math.abs(naive - 90 * 60_000)).toBeGreaterThan(4 * 60_000); // the naive method is off by ~5 minutes
  });
});
