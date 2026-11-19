import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AuctionState,
  type BidKind,
  type BidResolution,
  bidStep,
  isReserveMet,
  minNextBid,
  placeBid,
  UAH,
} from '../src/index.js';

const OPTS = { antiSnipeMs: 120_000 };
const T0 = 1_700_000_000_000;
const ENDS = T0 + 24 * 3600_000;

const lot = (over: Partial<AuctionState> = {}): AuctionState => ({
  status: 'active',
  sellerId: 'seller',
  startPrice: UAH(100),
  reservePrice: null,
  currentPrice: UAH(100),
  bidCount: 0,
  leader: null,
  endsAt: ENDS,
  ...over,
});

type Step = { userId: string; kind: BidKind; amount: number; now?: number };

/** Applies bids in order; returns the final state and every resolution. */
const run = (initial: AuctionState, steps: readonly Step[]) => {
  let state = initial;
  const results: BidResolution[] = [];
  steps.forEach((s, i) => {
    const r = placeBid(state, { ...s, now: s.now ?? T0 + i }, OPTS);
    results.push(r);
    if (r.ok) state = r.state;
  });
  return { state, results };
};

const accepted = (r: BidResolution) => {
  if (!r.ok) throw new Error(`expected accepted bid, got ${r.reason}`);
  return r;
};

describe('assignment examples', () => {
  it('autobids 1 000 ₴ and 1 500 ₴ → price 1 050 ₴, the 1 500 bidder leads (order A,B)', () => {
    const { state } = run(lot(), [
      { userId: 'a', kind: 'auto', amount: UAH(1000) },
      { userId: 'b', kind: 'auto', amount: UAH(1500) },
    ]);
    expect(state.currentPrice).toBe(UAH(1050));
    expect(state.leader?.userId).toBe('b');
  });

  it('autobids 1 000 ₴ and 1 500 ₴ → price 1 050 ₴, the 1 500 bidder leads (order B,A)', () => {
    const { state, results } = run(lot(), [
      { userId: 'b', kind: 'auto', amount: UAH(1500) },
      { userId: 'a', kind: 'auto', amount: UAH(1000) },
    ]);
    expect(state.currentPrice).toBe(UAH(1050));
    expect(state.leader?.userId).toBe('b');
    expect(accepted(results[1]!).outcome).toBe('outbid_by_autobid');
  });

  it('equal maxes → the earlier bidder leads at that max, whatever the order', () => {
    for (const [first, second] of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const { state, results } = run(lot(), [
        { userId: first, kind: 'auto', amount: UAH(700) },
        { userId: second, kind: 'auto', amount: UAH(700) },
      ]);
      expect(state.leader?.userId).toBe(first);
      expect(state.currentPrice).toBe(UAH(700));
      expect(accepted(results[1]!).outcome).toBe('outbid_by_autobid');
    }
  });

  it('the price never exceeds the leader max even when second max + step would', () => {
    const { state } = run(lot(), [
      { userId: 'a', kind: 'auto', amount: UAH(1000) },
      { userId: 'b', kind: 'auto', amount: UAH(1020) },
    ]);
    // 1 000 + 50 = 1 050 > 1 020 → capped at the winner's max.
    expect(state.currentPrice).toBe(UAH(1020));
    expect(state.leader?.userId).toBe('b');
  });
});

describe('manual bids', () => {
  it('first manual bid sets the price to the bid itself', () => {
    const r = accepted(
      placeBid(lot(), { userId: 'a', kind: 'manual', amount: UAH(150), now: T0 }, OPTS),
    );
    expect(r.state.currentPrice).toBe(UAH(150));
    expect(r.history).toEqual([{ userId: 'a', amount: UAH(150), isAuto: false }]);
  });

  it('first autobid starts at the start price, not at the max', () => {
    const r = accepted(
      placeBid(lot(), { userId: 'a', kind: 'auto', amount: UAH(900), now: T0 }, OPTS),
    );
    expect(r.state.currentPrice).toBe(UAH(100));
    expect(r.state.leader).toEqual({ userId: 'a', maxBid: UAH(900) });
    expect(r.history).toEqual([{ userId: 'a', amount: UAH(100), isAuto: true }]);
  });

  it('a manual bid against a higher autobid is answered by the autobid (marked isAuto)', () => {
    const { results, state } = run(lot(), [
      { userId: 'a', kind: 'auto', amount: UAH(500) },
      { userId: 'b', kind: 'manual', amount: UAH(200) },
    ]);
    const r = accepted(results[1]!);
    expect(r.outcome).toBe('outbid_by_autobid');
    expect(r.history).toEqual([
      { userId: 'b', amount: UAH(200), isAuto: false },
      { userId: 'a', amount: UAH(210), isAuto: true },
    ]);
    expect(state.currentPrice).toBe(UAH(210));
    expect(state.bidCount).toBe(3);
  });

  it('a manual bid above the leader max wins at exactly the bid amount and reports the displaced leader', () => {
    const { results, state } = run(lot(), [
      { userId: 'a', kind: 'auto', amount: UAH(500) },
      { userId: 'b', kind: 'manual', amount: UAH(800) },
    ]);
    const r = accepted(results[1]!);
    expect(r.outcome).toBe('leading');
    expect(r.displacedLeader).toEqual({ userId: 'a', maxBid: UAH(500) });
    // The old autobid silently went up to its max before being beaten.
    expect(r.history).toEqual([
      { userId: 'a', amount: UAH(500), isAuto: true },
      { userId: 'b', amount: UAH(800), isAuto: false },
    ]);
    expect(state.currentPrice).toBe(UAH(800));
  });

  it('does not repeat the displaced leader in history when their max equals the price', () => {
    const { results } = run(lot(), [
      { userId: 'a', kind: 'manual', amount: UAH(300) },
      { userId: 'b', kind: 'manual', amount: UAH(310) },
    ]);
    expect(accepted(results[1]!).history).toEqual([
      { userId: 'b', amount: UAH(310), isAuto: false },
    ]);
  });
});

describe('leader raising own max', () => {
  it('raises silently: no price change, no public history', () => {
    const { results, state } = run(lot(), [
      { userId: 'a', kind: 'auto', amount: UAH(500) },
      { userId: 'a', kind: 'auto', amount: UAH(900) },
    ]);
    const r = accepted(results[1]!);
    expect(r.raisedOwnMax).toBe(true);
    expect(r.history).toEqual([]);
    expect(state.currentPrice).toBe(UAH(100));
    expect(state.bidCount).toBe(1);
    expect(state.leader?.maxBid).toBe(UAH(900));
  });

  it('rejects a raise that is not above the current max', () => {
    const { results } = run(lot(), [
      { userId: 'a', kind: 'auto', amount: UAH(500) },
      { userId: 'a', kind: 'auto', amount: UAH(500) },
    ]);
    expect(results[1]).toMatchObject({ ok: false, reason: 'BID_NOT_ABOVE_OWN_MAX' });
  });

  it('rejects a raise below price + step when the leader sits exactly at the price', () => {
    const { results } = run(lot(), [
      { userId: 'a', kind: 'manual', amount: UAH(1000) },
      { userId: 'a', kind: 'auto', amount: UAH(1020) },
    ]);
    expect(results[1]).toMatchObject({ ok: false, reason: 'BID_TOO_LOW', minNextBid: UAH(1050) });
  });
});

describe('rejections', () => {
  it('rejects a bid on your own lot', () => {
    const r = placeBid(
      lot(),
      { userId: 'seller', kind: 'manual', amount: UAH(200), now: T0 },
      OPTS,
    );
    expect(r).toMatchObject({ ok: false, reason: 'OWN_LOT' });
  });

  it.each(['draft', 'in_review', 'awaiting_payment', 'removed', 'ended_unsold'] as const)(
    'rejects bids while the lot is %s',
    (status) => {
      const r = placeBid(
        lot({ status }),
        { userId: 'a', kind: 'manual', amount: UAH(200), now: T0 },
        OPTS,
      );
      expect(r).toMatchObject({ ok: false, reason: 'LOT_NOT_ACTIVE' });
    },
  );

  it('rejects at exactly endsAt and after it; accepts 1 ms before', () => {
    const bid = (now: number) =>
      placeBid(lot(), { userId: 'a', kind: 'manual', amount: UAH(100), now }, OPTS);
    expect(bid(ENDS)).toMatchObject({ ok: false, reason: 'LOT_ENDED' });
    expect(bid(ENDS + 1000)).toMatchObject({ ok: false, reason: 'LOT_ENDED' });
    expect(bid(ENDS - 1).ok).toBe(true);
  });

  it('rejects below the start price on the first bid and below price + step afterwards', () => {
    expect(
      placeBid(lot(), { userId: 'a', kind: 'manual', amount: UAH(99.99), now: T0 }, OPTS),
    ).toMatchObject({
      ok: false,
      reason: 'BID_TOO_LOW',
      minNextBid: UAH(100),
    });
    const { results } = run(lot(), [
      { userId: 'a', kind: 'manual', amount: UAH(100) },
      { userId: 'b', kind: 'manual', amount: UAH(109.99) },
      { userId: 'b', kind: 'manual', amount: UAH(110) },
    ]);
    expect(results[1]).toMatchObject({ ok: false, reason: 'BID_TOO_LOW', minNextBid: UAH(110) });
    expect(results[2]?.ok).toBe(true);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    10_000_000_001,
    Number.MAX_SAFE_INTEGER + 2,
  ])('rejects malformed amount %s', (amount) => {
    const r = placeBid(lot(), { userId: 'a', kind: 'manual', amount, now: T0 }, OPTS);
    expect(r).toMatchObject({ ok: false, reason: 'BID_INVALID_AMOUNT' });
  });

  it('a rejected bid reports minNextBid and does not touch state', () => {
    const before = lot({
      currentPrice: UAH(1000),
      bidCount: 3,
      leader: { userId: 'a', maxBid: UAH(1000) },
    });
    const r = placeBid(before, { userId: 'b', kind: 'manual', amount: UAH(1001), now: T0 }, OPTS);
    expect(r).toEqual({ ok: false, reason: 'BID_TOO_LOW', minNextBid: UAH(1050) });
  });
});

describe('anti-sniping', () => {
  it('a bid in the last 2 minutes moves the end to now + 2 minutes', () => {
    const now = ENDS - 60_000;
    const r = accepted(
      placeBid(lot(), { userId: 'a', kind: 'manual', amount: UAH(100), now }, OPTS),
    );
    expect(r.extended).toBe(true);
    expect(r.state.endsAt).toBe(now + 120_000);
  });

  it('exactly 2 minutes before the end does not extend', () => {
    const r = accepted(
      placeBid(lot(), { userId: 'a', kind: 'manual', amount: UAH(100), now: ENDS - 120_000 }, OPTS),
    );
    expect(r.extended).toBe(false);
    expect(r.state.endsAt).toBe(ENDS);
  });

  it('extensions are unlimited: each late bid pushes the end again', () => {
    let state = lot();
    let now = ENDS - 1000;
    for (let i = 0; i < 50; i++) {
      const r = accepted(
        placeBid(
          state,
          { userId: i % 2 ? 'a' : 'b', kind: 'manual', amount: minNextBid(state), now },
          OPTS,
        ),
      );
      expect(r.state.endsAt).toBe(now + 120_000);
      state = r.state;
      now = state.endsAt - 1000;
    }
  });

  it('an outbid (autobid answered) late bid still extends: it is an accepted bid', () => {
    const base = run(lot(), [{ userId: 'a', kind: 'auto', amount: UAH(1000) }]).state;
    const now = ENDS - 10_000;
    const r = accepted(
      placeBid(base, { userId: 'b', kind: 'manual', amount: UAH(200), now }, OPTS),
    );
    expect(r.outcome).toBe('outbid_by_autobid');
    expect(r.state.endsAt).toBe(now + 120_000);
  });
});

describe('reserve price', () => {
  it('single autobid above the reserve lifts the price to the reserve', () => {
    const r = accepted(
      placeBid(
        lot({ reservePrice: UAH(3000) }),
        { userId: 'a', kind: 'auto', amount: UAH(5000), now: T0 },
        OPTS,
      ),
    );
    expect(r.state.currentPrice).toBe(UAH(3000));
    expect(isReserveMet(r.state)).toBe(true);
  });

  it('two autobids below a reserve between them: price jumps to the reserve, higher max leads', () => {
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      const maxes = { a: UAH(1000), b: UAH(1500) };
      const { state } = run(
        lot({ reservePrice: UAH(1200) }),
        order.map((u) => ({ userId: u, kind: 'auto' as const, amount: maxes[u] })),
      );
      expect(state.currentPrice).toBe(UAH(1200));
      expect(state.leader?.userId).toBe('b');
    }
  });

  it('autobid below the reserve leaves the price at start and reserve not met', () => {
    const r = accepted(
      placeBid(
        lot({ reservePrice: UAH(3000) }),
        { userId: 'a', kind: 'auto', amount: UAH(2999), now: T0 },
        OPTS,
      ),
    );
    expect(r.state.currentPrice).toBe(UAH(100));
    expect(isReserveMet(r.state)).toBe(false);
  });

  it('leader raising max over the reserve triggers the jump and a public autobid row', () => {
    const { results, state } = run(lot({ reservePrice: UAH(3000) }), [
      { userId: 'a', kind: 'auto', amount: UAH(500) },
      { userId: 'a', kind: 'auto', amount: UAH(4000) },
    ]);
    expect(accepted(results[1]!).history).toEqual([
      { userId: 'a', amount: UAH(3000), isAuto: true },
    ]);
    expect(state.currentPrice).toBe(UAH(3000));
  });

  it('no bids → reserve not met even without a reserve', () => {
    expect(isReserveMet(lot())).toBe(false);
    expect(isReserveMet(lot({ bidCount: 1 }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------------------------

const permutations = <T>(items: readonly T[]): T[][] =>
  items.length <= 1
    ? [items.slice()]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

/** The assignment's formula, evaluated over the autobids that were actually accepted. */
const expectedFinal = (
  acceptedInOrder: readonly { userId: string; amount: number }[],
  start: number,
  reserve: number | null,
) => {
  // Highest max; on equal maxes the one placed earlier (lower index) wins.
  const ranked = acceptedInOrder
    .map((b, i) => ({ ...b, i }))
    .sort((x, y) => y.amount - x.amount || x.i - y.i);
  const first = ranked[0]!;
  const second = ranked[1];
  const base = second ? Math.min(first.amount, second.amount + bidStep(second.amount)) : start;
  const price = reserve !== null && first.amount >= reserve && base < reserve ? reserve : base;
  return { leader: first.userId, price };
};

const amountArb = fc.integer({ min: UAH(100), max: UAH(20_000) });

describe('properties', () => {
  it('autobids: final price and leader follow the formula for every arrival order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(amountArb, { minLength: 2, maxLength: 5 }),
        fc.option(fc.integer({ min: UAH(100), max: UAH(20_000) }), { nil: null }),
        (maxes, reserve) => {
          const bidders = maxes.map((amount, i) => ({ userId: `u${i}`, amount }));
          const finals = new Set<string>();
          for (const order of permutations(bidders)) {
            const { state, results } = run(
              lot({ reservePrice: reserve }),
              order.map((b) => ({ ...b, kind: 'auto' as const })),
            );
            const acceptedBids = order.filter((_, i) => results[i]!.ok);
            const expected = expectedFinal(acceptedBids, UAH(100), reserve);
            expect(state.currentPrice).toBe(expected.price);
            expect(state.leader?.userId).toBe(expected.leader);
            if (acceptedBids.length === order.length)
              finals.add(`${state.leader?.userId}@${state.currentPrice}`);
          }
          // Every order in which nobody was rejected ends in exactly the same state.
          expect(finals.size).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('equal maxes in any order: the earliest placed wins', () => {
    fc.assert(
      // ≥ start + step(100 ₴) = 110 ₴, so the second equal autobid is a valid bid (a lower one is just BID_TOO_LOW).
      fc.property(
        fc.integer({ min: UAH(110), max: UAH(20_000) }),
        fc.integer({ min: 2, max: 5 }),
        (amount, n) => {
          const users = Array.from({ length: n }, (_, i) => `u${i}`);
          for (const order of permutations(users)) {
            const { state } = run(
              lot(),
              order.map((userId) => ({ userId, kind: 'auto' as const, amount })),
            );
            expect(state.leader?.userId).toBe(order[0]);
            expect(state.currentPrice).toBe(n > 1 ? amount : UAH(100));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  const stepArb = fc.record({
    user: fc.integer({ min: 0, max: 5 }),
    kind: fc.constantFrom<BidKind>('manual', 'auto'),
    // Offsets around the current minimum, including below it, to exercise rejections.
    delta: fc.integer({ min: -UAH(200), max: UAH(5_000) }),
    dt: fc.integer({ min: 0, max: 30 * 60_000 }),
  });

  it('random mixed bidding never breaks the core invariants', () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { minLength: 1, maxLength: 80 }),
        fc.option(fc.integer({ min: UAH(100), max: UAH(10_000) }), { nil: null }),
        fc.integer({ min: 60_000, max: 3 * 3600_000 }),
        (steps, reserve, lifetime) => {
          let state = lot({ reservePrice: reserve, endsAt: T0 + lifetime });
          let now = T0;
          // Model: each participant's highest committed amount.
          const committed = new Map<string, number>();
          for (const s of steps) {
            now += s.dt;
            const userId = `u${s.user}`;
            const amount = Math.max(1, minNextBid(state) + s.delta);
            const before = state;
            const r = placeBid(state, { userId, kind: s.kind, amount, now }, OPTS);
            if (!r.ok) {
              // Rejection tells the truth.
              if (now >= before.endsAt) expect(r.reason).toBe('LOT_ENDED');
              else if (r.reason === 'BID_TOO_LOW') expect(amount).toBeLessThan(r.minNextBid);
              continue;
            }
            state = r.state;
            committed.set(userId, Math.max(committed.get(userId) ?? 0, amount));

            // The price never goes down; it strictly rises unless it was a silent max raise.
            if (r.raisedOwnMax)
              expect(state.currentPrice).toBeGreaterThanOrEqual(before.currentPrice);
            else if (before.bidCount > 0)
              expect(state.currentPrice).toBeGreaterThan(before.currentPrice);
            // Exactly one leader, and the price never exceeds the leader's max.
            expect(state.leader).not.toBeNull();
            expect(state.currentPrice).toBeLessThanOrEqual(state.leader!.maxBid);
            // Nobody but the leader has committed more than the current price.
            for (const [u, max] of committed) {
              if (u !== state.leader!.userId) expect(max).toBeLessThanOrEqual(state.currentPrice);
            }
            // History is consistent with the price and the counter.
            expect(state.bidCount).toBe(before.bidCount + r.history.length);
            const amounts = r.history.map((h) => h.amount);
            expect(amounts).toEqual([...amounts].sort((x, y) => x - y));
            if (r.history.length > 0) expect(r.history.at(-1)!.amount).toBe(state.currentPrice);
            // The end only moves forward, and only to now + antiSnipe.
            expect(state.endsAt).toBeGreaterThanOrEqual(before.endsAt);
            if (r.extended) expect(state.endsAt).toBe(now + OPTS.antiSnipeMs);
            // Reserve: if the leader can afford it, the price is at least the reserve.
            if (reserve !== null && state.leader!.maxBid >= reserve) {
              expect(state.currentPrice).toBeGreaterThanOrEqual(reserve);
            }
            // The seller never appears.
            expect(r.history.every((h) => h.userId !== 'seller')).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
