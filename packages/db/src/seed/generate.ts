import {
  type AuctionState,
  bidStep,
  commissionFor,
  depositFor,
  minNextBid,
  placeBid,
  type LotStatus,
  UAH,
} from '@auction/shared';
import {
  availableAccountId,
  COMMISSION_ACCOUNT_ID,
  escrowAccountId,
  EXTERNAL_ACCOUNT_ID,
  heldAccountId,
  NS,
  seedId,
} from './ids.js';
import { createRng, type Rng } from './rng.js';
import { CATEGORIES, CITIES, FIRST_NAMES, ITEM_ADJECTIVES, ITEM_NOUNS } from './reference.js';

/**
 * Builds the whole seed in memory as plain rows (snake_case = column names). It is pure: the
 * same config gives the same rows. Bid history is produced by running the real bid engine from
 * @auction/shared, so every seeded lot is a state the engine could actually have reached, and
 * the ledger is built to reconcile exactly (see `generateLedger`).
 */

export type SeedConfig = {
  readonly users: number;
  readonly lots: number;
  readonly bids: number;
  readonly rng: number;
  /** Epoch ms; every timestamp is relative to it. */
  readonly now: number;
  readonly passwordHash: string;
};

type Row = Record<string, unknown>;

export type SeedData = {
  readonly categories: Row[];
  readonly cities: Row[];
  readonly users: Row[];
  readonly accounts: Row[];
  readonly escrowAccounts: Row[];
  readonly providerPayments: Row[];
  readonly topups: Row[];
  readonly lots: Row[];
  readonly bids: Row[];
  readonly deposits: Row[];
  readonly offers: Row[];
  readonly defaults: Row[];
  readonly photos: Row[];
  readonly favorites: Row[];
  readonly audit: Row[];
  /** Top-up transactions (must be inserted before anything that spends). */
  readonly topupLedger: { transactions: Row[]; entries: Row[] };
  /** Everything else that moves money. */
  readonly saleLedger: { transactions: Row[]; entries: Row[] };
  readonly summary: SeedSummary;
};

export type SeedSummary = {
  users: number;
  categories: number;
  cities: number;
  lots: number;
  bids: number;
  byStatus: Record<string, number>;
  endingWithinHour: number;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const SEED_LOGINS = {
  buyers: [1, 2, 3, 4, 5].map((n) => `buyer${n}@seed.test`),
  sellers: [1, 2, 3, 4, 5].map((n) => `seller${n}@seed.test`),
  moderators: ['moderator1@seed.test', 'moderator2@seed.test'],
  finance: ['finance1@seed.test'],
} as const;

/** User index layout: 1-5 buyers, 6-10 sellers, 11-12 moderators, 13 finance, rest ordinary. */
const FIRST_ORDINARY = 14;
const roleOf = (idx: number): 'user' | 'moderator' | 'finance' =>
  idx === 11 || idx === 12 ? 'moderator' : idx === 13 ? 'finance' : 'user';

const emailOf = (idx: number): string =>
  idx <= 5
    ? `buyer${idx}@seed.test`
    : idx <= 10
      ? `seller${idx - 5}@seed.test`
      : idx <= 12
        ? `moderator${idx - 10}@seed.test`
        : idx === 13
          ? 'finance1@seed.test'
          : `user${idx}@seed.test`;

const nameOf = (idx: number, rng: Rng): string =>
  idx <= 5
    ? `buyer${idx}`
    : idx <= 10
      ? `seller${idx - 5}`
      : idx <= 12
        ? `moderator${idx - 10}`
        : idx === 13
          ? 'finance1'
          : `${rng.pick(FIRST_NAMES)}${idx % 97}`;

/** Share of lots per status (the remainder goes to `completed`). */
const STATUS_SHARE: readonly [LotStatus, number][] = [
  ['active', 0.1],
  ['ended_unsold', 0.16],
  ['awaiting_payment', 0.02],
  ['paid', 0.02],
  ['shipped', 0.02],
  ['draft', 0.04],
  ['in_review', 0.01],
  ['rejected', 0.01],
  ['removed', 0.02],
];

type LotPlan = {
  idx: number;
  status: LotStatus;
  sellerIdx: number;
  categoryId: number;
  cityId: number;
  durationDays: number;
  startPrice: number;
  /** Target number of public bid rows. */
  target: number;
  manualOnly: boolean;
};

type HistoryRow = { userIdx: number; amount: number; isAuto: boolean };

type Simulated = {
  state: AuctionState;
  history: HistoryRow[];
  leaderIdx: number | null;
};

const FAR_FUTURE = 4_000_000_000_000;
const ENGINE = { antiSnipeMs: 2 * MIN };

const initialState = (plan: LotPlan): AuctionState => ({
  status: 'active',
  sellerId: String(plan.sellerIdx),
  startPrice: plan.startPrice,
  reservePrice: null,
  currentPrice: plan.startPrice,
  bidCount: 0,
  leader: null,
  endsAt: FAR_FUTURE,
});

/** Runs real bids through the engine until `target` history rows exist. */
const simulateBids = (
  plan: LotPlan,
  rng: Rng,
  buyers: readonly number[],
  from: Simulated | null,
  target: number,
): Simulated => {
  let state = from?.state ?? initialState(plan);
  const history = from ? [...from.history] : [];
  let guard = 0;
  while (state.bidCount < target && guard++ < target * 20 + 50) {
    const leaderIdx = state.leader ? Number(state.leader.userId) : null;
    const user = rng.pick(buyers);
    if (user === plan.sellerIdx || user === leaderIdx) continue;
    const min = minNextBid(state);
    const auto = !plan.manualOnly && rng.chance(0.4);
    const amount = auto
      ? min + bidStep(min) * rng.int(0, 30)
      : plan.manualOnly
        ? min
        : min + (rng.chance(0.3) ? bidStep(min) * rng.int(1, 3) : 0);
    const result = placeBid(
      state,
      { userId: String(user), kind: auto ? 'auto' : 'manual', amount, now: 1 },
      ENGINE,
    );
    if (!result.ok) continue;
    state = result.state;
    for (const h of result.history) {
      history.push({ userIdx: Number(h.userId), amount: h.amount, isAuto: h.isAuto });
    }
  }
  return {
    state,
    history,
    leaderIdx: state.leader ? Number(state.leader.userId) : null,
  };
};

const BID_WEIGHT: Partial<Record<LotStatus, number>> = {
  active: 40,
  awaiting_payment: 9,
  paid: 9,
  shipped: 9,
  completed: 7,
  removed: 4,
};

const MUST_HAVE_BIDS: ReadonlySet<LotStatus> = new Set([
  'awaiting_payment',
  'paid',
  'shipped',
  'completed',
]);

const planLots = (cfg: SeedConfig, rng: Rng, sellers: readonly number[]): LotPlan[] => {
  const counts = new Map<LotStatus, number>();
  let assigned = 0;
  for (const [status, share] of STATUS_SHARE) {
    const n = Math.round(cfg.lots * share);
    counts.set(status, n);
    assigned += n;
  }
  counts.set('completed', Math.max(0, cfg.lots - assigned));
  const statuses = rng.shuffle(
    [...counts.entries()].flatMap(([s, n]) => Array<LotStatus>(n).fill(s)),
  );

  let firstManualActive = true;
  return statuses.map((status, i): LotPlan => {
    const idx = i + 1;
    const start = 5_00 * (1 + Math.floor(Math.exp(rng.next() * Math.log(600))));
    // About one live lot in six has no bids yet (so "no bids" and "buy now" have something to find).
    const weight =
      status === 'active' && rng.chance(0.17)
        ? 0
        : (BID_WEIGHT[status] ?? (status === 'ended_unsold' && rng.chance(0.4) ? 3 : 0));
    const mult = 0.4 + rng.next() * 1.2;
    const manualOnly = status === 'active' && (firstManualActive || rng.chance(0.3));
    if (status === 'active') firstManualActive = false;
    return {
      idx,
      status,
      sellerIdx: rng.pick(sellers),
      categoryId: rng.int(1, CATEGORIES.length),
      cityId: rng.int(1, CITIES.length),
      durationDays: rng.int(1, 10),
      startPrice: start,
      target:
        weight === 0 ? 0 : Math.max(MUST_HAVE_BIDS.has(status) ? 1 : 0, Math.round(weight * mult)),
      manualOnly,
    };
  });
};

type LotTimes = {
  createdAt: number;
  startsAt: number | null;
  endsAt: number | null;
  soldAt: number | null;
  paymentDueAt: number | null;
  paidAt: number | null;
  shippedAt: number | null;
  completedAt: number | null;
  /** Upper bound for bid timestamps. */
  bidsUntil: number;
};

const planTimes = (plan: LotPlan, now: number, rng: Rng): LotTimes => {
  const dur = plan.durationDays * DAY;
  const none: LotTimes = {
    createdAt: now,
    startsAt: null,
    endsAt: null,
    soldAt: null,
    paymentDueAt: null,
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    bidsUntil: now,
  };
  const published = (endsAt: number, bidsUntil: number): LotTimes => {
    const startsAt = endsAt - dur;
    return { ...none, startsAt, endsAt, createdAt: startsAt - rng.int(HOUR, 30 * HOUR), bidsUntil };
  };
  switch (plan.status) {
    case 'draft':
      return { ...none, createdAt: now - rng.int(HOUR, 30 * DAY) };
    case 'in_review':
      return { ...none, createdAt: now - rng.int(MIN, 2 * DAY) };
    case 'rejected':
      return { ...none, createdAt: now - rng.int(DAY, 30 * DAY) };
    case 'active': {
      const remaining = rng.chance(0.06)
        ? rng.int(2 * MIN, 59 * MIN)
        : rng.int(HOUR, Math.max(HOUR + 1, Math.floor(dur * 0.9)));
      return published(now + remaining, now);
    }
    case 'removed': {
      const remaining = rng.int(HOUR, Math.max(HOUR + 1, dur - 2 * HOUR));
      return published(now + remaining, now - HOUR);
    }
    case 'ended_unsold': {
      const endsAt = now - rng.int(HOUR, 100 * DAY);
      return published(endsAt, endsAt - 3 * MIN);
    }
    case 'awaiting_payment': {
      const endsAt = now - rng.int(HOUR, 40 * HOUR);
      return {
        ...published(endsAt, endsAt - 3 * MIN),
        soldAt: endsAt,
        paymentDueAt: endsAt + 48 * HOUR,
      };
    }
    case 'paid': {
      const endsAt = now - rng.int(2 * HOUR, 47 * HOUR);
      const paidAt = endsAt + rng.int(10 * MIN, Math.max(10 * MIN + 1, now - endsAt - MIN));
      return { ...published(endsAt, endsAt - 3 * MIN), soldAt: endsAt, paidAt };
    }
    case 'shipped': {
      const endsAt = now - rng.int(2 * DAY, 6 * DAY);
      const paidAt = endsAt + rng.int(HOUR, 20 * HOUR);
      const shippedAt = paidAt + rng.int(HOUR, 20 * HOUR);
      return { ...published(endsAt, endsAt - 3 * MIN), soldAt: endsAt, paidAt, shippedAt };
    }
    case 'completed': {
      const endsAt = now - rng.int(9 * DAY, 110 * DAY);
      const paidAt = endsAt + rng.int(HOUR, 30 * HOUR);
      const shippedAt = paidAt + rng.int(HOUR, 24 * HOUR);
      const completedAt = shippedAt + rng.int(DAY, 6 * DAY);
      return {
        ...published(endsAt, endsAt - 3 * MIN),
        soldAt: endsAt,
        paidAt,
        shippedAt,
        completedAt,
      };
    }
  }
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const sortedTimes = (rng: Rng, n: number, from: number, to: number): number[] => {
  const lo = Math.min(from, to - 1);
  const times = Array.from({ length: n }, () => rng.int(lo, to));
  return times.sort((a, b) => a - b);
};

export const generateSeed = (cfg: SeedConfig): SeedData => {
  if (cfg.users < 50) throw new Error('SEED_USERS must be at least 50');
  if (cfg.lots < 20) throw new Error('SEED_LOTS must be at least 20');
  const rng = createRng(cfg.rng);
  const now = cfg.now;

  // ---- people -------------------------------------------------------------------------------
  const users: Row[] = Array.from({ length: cfg.users }, (_, i) => {
    const idx = i + 1;
    return {
      id: seedId(NS.user, idx),
      email: emailOf(idx),
      password_hash: cfg.passwordHash,
      display_name: nameOf(idx, rng),
      role: roleOf(idx),
      locale: rng.pick(['uk', 'uk', 'uk', 'en', 'pl']),
      created_at: iso(now - rng.int(200 * DAY, 400 * DAY)),
    };
  });
  const ordinary = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    ...Array.from({ length: cfg.users - FIRST_ORDINARY + 1 }, (_, i) => FIRST_ORDINARY + i),
  ];
  const sellers = [
    6,
    7,
    8,
    9,
    10,
    ...Array.from(
      { length: Math.min(cfg.users - FIRST_ORDINARY + 1, 2000) },
      (_, i) => FIRST_ORDINARY + i,
    ),
  ];

  // ---- lots and bids ------------------------------------------------------------------------
  const plans = planLots(cfg, rng, sellers);
  const rawTotal = plans.reduce((a, p) => a + p.target, 0);
  const wanted = Math.floor(cfg.bids * 0.9);
  let factor = rawTotal === 0 ? 0 : wanted / rawTotal;

  let sims: Simulated[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const sized = plans.map((p) => ({
      ...p,
      target:
        p.target === 0
          ? 0
          : Math.max(MUST_HAVE_BIDS.has(p.status) ? 1 : 0, Math.round(p.target * factor)),
    }));
    sims = sized.map((p) => simulateBids(p, rng, ordinary, null, p.target));
    const total = sims.reduce((a, s) => a + s.history.length, 0);
    if (total <= cfg.bids) break;
    factor *= 0.9;
    if (attempt === 7) throw new Error('cannot fit the requested number of bids; raise SEED_BIDS');
  }

  // Top up to exactly `bids` using manual-only live lots: each manual bid is exactly one row.
  let total = sims.reduce((a, s) => a + s.history.length, 0);
  const extendable = plans
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.status === 'active' && p.manualOnly);
  if (total < cfg.bids) {
    if (extendable.length === 0) throw new Error('no manual-only live lot to extend');
    const missing = cfg.bids - total;
    const each = Math.floor(missing / extendable.length);
    const extra = missing % extendable.length;
    extendable.forEach(({ p, i }, k) => {
      const current = sims[i] as Simulated;
      sims[i] = simulateBids(
        p,
        rng,
        ordinary,
        current,
        current.history.length + each + (k < extra ? 1 : 0),
      );
    });
    total = sims.reduce((a, s) => a + s.history.length, 0);
  }
  if (total !== cfg.bids) throw new Error(`generated ${total} bids, wanted ${cfg.bids}`);

  const lots: Row[] = [];
  const bids: Row[] = [];
  const deposits: Row[] = [];
  const offers: Row[] = [];
  const defaults: Row[] = [];
  const audit: Row[] = [];
  const escrowAccounts: Row[] = [];
  const saleTx: Row[] = [];
  const saleEntries: Row[] = [];
  /** Per user: total kopecks that must leave their available balance. */
  const spend = new Map<number, number>();
  const addSpend = (idx: number, amount: number) => spend.set(idx, (spend.get(idx) ?? 0) + amount);
  let txCounter = 0;
  const book = (
    kind: string,
    ref: string,
    lotIdx: number | null,
    userIdx: number | null,
    at: number,
    entries: readonly (readonly [string, number])[],
  ) => {
    const id = seedId(NS.tx, ++txCounter);
    saleTx.push({
      id,
      kind,
      ref,
      lot_id: lotIdx === null ? null : seedId(NS.lot, lotIdx),
      user_id: userIdx === null ? null : seedId(NS.user, userIdx),
      created_at: iso(at),
    });
    for (const [account, amount] of entries)
      saleEntries.push({ tx_id: id, account_id: account, amount });
  };

  const byStatus: Record<string, number> = {};
  let endingWithinHour = 0;
  let depositCounter = 0;
  let offerCounter = 0;
  let defaultCounter = 0;

  plans.forEach((plan, i) => {
    const sim = sims[i] as Simulated;
    const state = sim.state;
    const times = planTimes(plan, now, rng);
    byStatus[plan.status] = (byStatus[plan.status] ?? 0) + 1;
    const lotId = seedId(NS.lot, plan.idx);
    const hasBids = state.bidCount > 0;
    const leaderIdx = sim.leaderIdx;
    const price = hasBids ? state.currentPrice : plan.startPrice;
    const leaderMax = state.leader?.maxBid ?? null;
    const sold = MUST_HAVE_BIDS.has(plan.status);

    // Reserve is consistent with what the engine would have produced: if the leader's max had
    // covered it, the price would already be at least the reserve.
    let reserve: number | null = null;
    if (sold) {
      if (rng.chance(0.3)) reserve = rng.int(plan.startPrice, price);
    } else if (plan.status === 'ended_unsold' && hasBids) {
      reserve = (leaderMax ?? price) + UAH(rng.int(10, 500)); // never met
    } else if (hasBids) {
      if (rng.chance(0.3))
        reserve = rng.chance(0.5)
          ? (leaderMax ?? price) + UAH(rng.int(1, 300))
          : rng.int(plan.startPrice, price);
    } else if (rng.chance(0.3)) {
      reserve = plan.startPrice + UAH(rng.int(1, 500));
    }
    const buyNow =
      !hasBids && rng.chance(0.2)
        ? Math.max(plan.startPrice, reserve ?? 0) * 2 + UAH(rng.int(1, 100))
        : null;

    const final = sold ? price : null;
    const commission = plan.status === 'completed' && final !== null ? commissionFor(final) : null;
    if (plan.status === 'active' && times.endsAt !== null && times.endsAt - now < HOUR)
      endingWithinHour++;

    lots.push({
      id: lotId,
      seller_id: seedId(NS.user, plan.sellerIdx),
      title: `${rng.pick(ITEM_ADJECTIVES)} ${rng.pick(ITEM_NOUNS)} #${plan.idx}`,
      description: `Seed lot ${plan.idx}. Used item in working condition, pickup or shipping across Ukraine.`,
      category_id: plan.categoryId,
      city_id: plan.cityId,
      condition: rng.pick(['new', 'like_new', 'good', 'good', 'fair', 'for_parts']),
      start_price: plan.startPrice,
      reserve_price: reserve,
      buy_now_price: buyNow,
      duration_days: plan.durationDays,
      status: plan.status,
      current_price: price,
      bid_count: state.bidCount,
      leader_id: leaderIdx === null ? null : seedId(NS.user, leaderIdx),
      leader_max: leaderMax,
      starts_at: iso(times.startsAt),
      ends_at: iso(times.endsAt),
      buyer_id: sold && leaderIdx !== null ? seedId(NS.user, leaderIdx) : null,
      final_price: final,
      commission,
      sold_at: iso(times.soldAt),
      payment_due_at: iso(times.paymentDueAt),
      paid_at: iso(times.paidAt),
      shipped_at: iso(times.shippedAt),
      tracking_number: times.shippedAt === null ? null : `NP ${String(20_000_000 + plan.idx)}`,
      completed_at: iso(times.completedAt),
      reject_reason:
        plan.status === 'rejected' ? 'Photos are blurry, please upload clearer ones' : null,
      removed_reason: plan.status === 'removed' ? 'Prohibited item' : null,
      created_at: iso(times.createdAt),
      updated_at: iso(now),
    });

    // Audit trail.
    const mod = seedId(NS.user, 11 + (plan.idx % 2));
    const seller = seedId(NS.user, plan.sellerIdx);
    const trail = (actor: string | null, action: string, at: number, detail: Row = {}) =>
      audit.push({ lot_id: lotId, actor_id: actor, action, detail, created_at: iso(at) });
    trail(seller, 'created', times.createdAt);
    if (plan.status !== 'draft') trail(seller, 'submitted', times.createdAt + MIN);
    if (times.startsAt !== null) trail(mod, 'approved', times.startsAt);
    if (plan.status === 'rejected')
      trail(mod, 'rejected', times.createdAt + 2 * HOUR, { reason: 'blurry photos' });
    if (plan.status === 'removed')
      trail(mod, 'removed', now - 30 * MIN, { reason: 'Prohibited item' });
    if (times.paidAt !== null && leaderIdx !== null)
      trail(seedId(NS.user, leaderIdx), 'paid', times.paidAt);
    if (times.shippedAt !== null) trail(seller, 'shipped', times.shippedAt);
    if (times.completedAt !== null && leaderIdx !== null)
      trail(seedId(NS.user, leaderIdx), 'confirmed', times.completedAt);

    // Bids with timestamps (sorted, so ids and times agree) and engine-consistent amounts.
    if (sim.history.length > 0) {
      const from = times.startsAt ?? times.createdAt;
      const at = sortedTimes(rng, sim.history.length, from, times.bidsUntil);
      sim.history.forEach((h, k) => {
        bids.push({
          lot_id: lotId,
          user_id: seedId(NS.user, h.userIdx),
          amount: h.amount,
          is_auto: h.isAuto,
          created_at: iso(at[k] as number),
          annulled_at: plan.status === 'removed' ? iso(now - 30 * MIN) : null,
        });
      });

      // Money.
      if (leaderIdx !== null && leaderMax !== null) {
        const held = depositFor(leaderMax);
        const lastLeaderBid = sim.history
          .map((h, k) => ({ h, k }))
          .filter(({ h }) => h.userIdx === leaderIdx)
          .at(-1);
        const holdAt = at[lastLeaderBid?.k ?? 0] as number;
        const buyer = availableAccountId(leaderIdx);
        const sellerAcc = availableAccountId(plan.sellerIdx);
        if (plan.status === 'active' || plan.status === 'awaiting_payment') {
          deposits.push({
            id: seedId(NS.deposit, ++depositCounter),
            lot_id: lotId,
            user_id: seedId(NS.user, leaderIdx),
            amount: held,
            status: 'held',
            created_at: iso(holdAt),
          });
          book('hold', `seed:hold:${plan.idx}`, plan.idx, leaderIdx, holdAt, [
            [buyer, -held],
            [heldAccountId(leaderIdx), held],
          ]);
          addSpend(leaderIdx, held);
        } else if (sold && final !== null) {
          deposits.push({
            id: seedId(NS.deposit, ++depositCounter),
            lot_id: lotId,
            user_id: seedId(NS.user, leaderIdx),
            amount: held,
            status: 'applied',
            created_at: iso(holdAt),
            resolved_at: iso(times.paidAt),
          });
          if (plan.status === 'completed' && commission !== null) {
            book('sale', `seed:sale:${plan.idx}`, plan.idx, leaderIdx, times.completedAt ?? now, [
              [buyer, -final],
              [sellerAcc, final - commission],
              [COMMISSION_ACCOUNT_ID, commission],
            ]);
          } else {
            escrowAccounts.push({
              id: escrowAccountId(plan.idx),
              key: `escrow:${lotId}`,
              kind: 'escrow',
              lot_id: lotId,
            });
            book('pay', `seed:pay:${plan.idx}`, plan.idx, leaderIdx, times.paidAt ?? now, [
              [buyer, -final],
              [escrowAccountId(plan.idx), final],
            ]);
          }
          addSpend(leaderIdx, final);

          // Some completed lots were first won by someone who never paid.
          if (plan.status === 'completed' && rng.chance(0.03)) {
            const candidates = [...new Set(sim.history.map((h) => h.userIdx))].filter(
              (u) => u !== leaderIdx,
            );
            const defaulter = candidates.length > 0 ? rng.pick(candidates) : null;
            if (defaulter !== null) {
              const forfeited = depositFor(final);
              const when = (times.soldAt ?? now) + 48 * HOUR;
              defaults.push({
                id: seedId(NS.default, ++defaultCounter),
                lot_id: lotId,
                user_id: seedId(NS.user, defaulter),
                amount: final,
                forfeited,
                created_at: iso(when),
              });
              deposits.push({
                id: seedId(NS.deposit, ++depositCounter),
                lot_id: lotId,
                user_id: seedId(NS.user, defaulter),
                amount: forfeited,
                status: 'forfeited',
                created_at: iso(holdAt),
                resolved_at: iso(when),
              });
              offers.push({
                id: seedId(NS.offer, ++offerCounter),
                lot_id: lotId,
                user_id: seedId(NS.user, leaderIdx),
                amount: final,
                status: 'accepted',
                created_at: iso(when),
                expires_at: iso(when + 24 * HOUR),
                resolved_at: iso(times.paidAt ?? when),
              });
              book('forfeit', `seed:forfeit:${plan.idx}`, plan.idx, defaulter, when, [
                [availableAccountId(defaulter), -forfeited],
                [sellerAcc, forfeited],
              ]);
              addSpend(defaulter, forfeited);
            }
          }
        }
      }
    }
  });

  // ---- top-ups: every wallet is funded by a succeeded payment that also exists at the provider
  const topups: Row[] = [];
  const providerPayments: Row[] = [];
  const topupTx: Row[] = [];
  const topupEntries: Row[] = [];
  ordinary.forEach((idx, k) => {
    const need = spend.get(idx) ?? 0;
    const bonus = idx <= 5 ? UAH(500_000) : rng.chance(0.8) ? UAH(rng.int(0, 50_000)) : 0;
    const amount = need + bonus;
    if (amount === 0) return;
    const at = now - rng.int(150 * DAY, 200 * DAY);
    const topupId = seedId(NS.topup, k + 1);
    const paymentId = seedId(NS.payment, k + 1);
    const txId = seedId(NS.tx, 50_000_000 + k + 1);
    providerPayments.push({
      id: paymentId,
      amount,
      reference: topupId,
      status: 'succeeded',
      created_at: iso(at),
      updated_at: iso(at + MIN),
    });
    topups.push({
      id: topupId,
      user_id: seedId(NS.user, idx),
      amount,
      status: 'succeeded',
      provider_payment_id: paymentId,
      created_at: iso(at),
      settled_at: iso(at + MIN),
    });
    topupTx.push({
      id: txId,
      kind: 'topup',
      ref: `topup:${topupId}`,
      lot_id: null,
      user_id: seedId(NS.user, idx),
      created_at: iso(at + MIN),
    });
    topupEntries.push(
      { tx_id: txId, account_id: EXTERNAL_ACCOUNT_ID, amount: -amount },
      { tx_id: txId, account_id: availableAccountId(idx), amount },
    );
  });

  // ---- accounts ---------------------------------------------------------------------------
  const accounts: Row[] = [
    { id: EXTERNAL_ACCOUNT_ID, key: 'external:payment_provider', kind: 'external' },
    { id: COMMISSION_ACCOUNT_ID, key: 'platform:commission', kind: 'platform_commission' },
    ...ordinary.flatMap((idx) => {
      const owner = seedId(NS.user, idx);
      return [
        {
          id: availableAccountId(idx),
          key: `user:${owner}:available`,
          kind: 'user_available',
          owner_id: owner,
        },
        { id: heldAccountId(idx), key: `user:${owner}:held`, kind: 'user_held', owner_id: owner },
      ];
    }),
  ];

  // ---- photos (placeholder objects are uploaded to MinIO by the worker at start-up) ------------
  const photos: Row[] = [];
  let photoCounter = 0;
  // Photos of lots the public can see are already published; the rest stay private.
  const PUBLIC = new Set<LotStatus>([
    'active',
    'ended_unsold',
    'awaiting_payment',
    'paid',
    'shipped',
    'completed',
  ]);
  for (const plan of plans) {
    const n = rng.int(1, 4);
    for (let pos = 0; pos < n; pos++) {
      const p = (plan.idx + pos * 7) % 60;
      photos.push({
        id: seedId(NS.photo, ++photoCounter),
        lot_id: seedId(NS.lot, plan.idx),
        position: pos,
        key: `seed/p${p}/full.jpg`,
        preview_key: `seed/p${p}/preview.jpg`,
        content_type: 'image/jpeg',
        size_bytes: 24_000,
        status: 'ready',
        published_at: PUBLIC.has(plan.status) ? iso(now) : null,
      });
    }
  }

  // ---- favourites on live lots ------------------------------------------------------------
  const favorites: Row[] = [];
  const seen = new Set<string>();
  const live = plans.filter((p) => p.status === 'active');
  for (let n = 0; n < Math.min(20_000, live.length * 4) && live.length > 0; n++) {
    const lot = rng.pick(live);
    const user = rng.pick(ordinary);
    const key = `${user}:${lot.idx}`;
    if (seen.has(key) || user === lot.sellerIdx) continue;
    seen.add(key);
    favorites.push({
      user_id: seedId(NS.user, user),
      lot_id: seedId(NS.lot, lot.idx),
      created_at: iso(now - rng.int(HOUR, 5 * DAY)),
    });
  }

  return {
    categories: CATEGORIES.map((c, i) => ({
      id: i + 1,
      slug: c.slug,
      name_uk: c.uk,
      name_en: c.en,
      name_pl: c.pl,
    })),
    cities: CITIES.map((c, i) => ({
      id: i + 1,
      slug: c.slug,
      name_uk: c.uk,
      name_en: c.en,
      name_pl: c.pl,
    })),
    users,
    accounts,
    escrowAccounts,
    providerPayments,
    topups,
    lots,
    bids,
    deposits,
    offers,
    defaults,
    photos,
    favorites,
    audit,
    topupLedger: { transactions: topupTx, entries: topupEntries },
    saleLedger: { transactions: saleTx, entries: saleEntries },
    summary: {
      users: users.length,
      categories: CATEGORIES.length,
      cities: CITIES.length,
      lots: lots.length,
      bids: bids.length,
      byStatus,
      endingWithinHour,
    },
  };
};
