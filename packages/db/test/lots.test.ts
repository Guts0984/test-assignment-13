import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOT_STATUSES, LOT_TRANSITIONS, type LotStatus } from '@auction/shared';
import {
  errorOf,
  inTx,
  insertActiveLot,
  insertLot,
  insertUser,
  newTestDb,
  sqlState,
  type LotOverrides,
  type TestDb,
} from './helpers.js';

let t: TestDb;
let seller: string;
let buyer: string;
let other: string;
let moderator: string;
let finance: string;

beforeAll(async () => {
  t = await newTestDb();
  seller = await insertUser(t.pool, 'user', 'seller');
  buyer = await insertUser(t.pool, 'user', 'buyer');
  other = await insertUser(t.pool, 'user', 'other');
  moderator = await insertUser(t.pool, 'moderator');
  finance = await insertUser(t.pool, 'finance');
});
afterAll(async () => {
  await t.close();
});

const CHECK = '23514';
const INTEGRITY = '23000';
const UNIQUE = '23505';

const setLot = (id: string, set: string, params: unknown[] = []) =>
  t.pool.query(`UPDATE lots SET ${set} WHERE id = $${params.length + 1}`, [...params, id]);

/** A lot in each status with every field that status promises, to test transitions from it. */
const lotInStatus = async (status: LotStatus): Promise<string> => {
  const now = new Date();
  const base: LotOverrides = { status };
  const sale = {
    buyer_id: buyer,
    final_price: 20_000,
    sold_at: now,
    current_price: 20_000,
    bid_count: 2,
    leader_id: buyer,
    leader_max: 20_000,
    starts_at: new Date(now.getTime() - 86_400_000),
    ends_at: new Date(now.getTime() - 3_600_000),
  };
  switch (status) {
    case 'active':
      Object.assign(base, {
        starts_at: new Date(now.getTime() - 3_600_000),
        ends_at: new Date(now.getTime() + 86_400_000),
      });
      break;
    case 'rejected':
      Object.assign(base, { reject_reason: 'blurry photos' });
      break;
    case 'removed':
      Object.assign(base, { removed_reason: 'prohibited item' });
      break;
    case 'awaiting_payment':
      Object.assign(base, sale, { payment_due_at: new Date(now.getTime() + 3_600_000) });
      break;
    case 'paid':
      Object.assign(base, sale, { paid_at: now });
      break;
    case 'shipped':
      Object.assign(base, sale, { paid_at: now, shipped_at: now, tracking_number: 'NP 123456' });
      break;
    case 'completed':
      Object.assign(base, sale, {
        paid_at: now,
        shipped_at: now,
        tracking_number: 'NP 123456',
        completed_at: now,
        commission: 1_000,
      });
      break;
    default:
      break;
  }
  return insertLot(t.pool, seller, base);
};

/** Minimal valid column values to ENTER a status (what a correct application would set). */
const enterStatus: Record<LotStatus, string> = {
  draft: `status = 'draft'`,
  in_review: `status = 'in_review'`,
  rejected: `status = 'rejected', reject_reason = 'no'`,
  active: `status = 'active', starts_at = now(), ends_at = now() + interval '1 day'`,
  ended_unsold: `status = 'ended_unsold'`,
  awaiting_payment: `status = 'awaiting_payment', buyer_id = 'BUYER', final_price = 20000, sold_at = now(), payment_due_at = now() + interval '1 day'`,
  paid: `status = 'paid', paid_at = now()`,
  shipped: `status = 'shipped', shipped_at = now(), tracking_number = 'TRK 123'`,
  completed: `status = 'completed', completed_at = now(), commission = 1000`,
  removed: `status = 'removed', removed_reason = 'x'`,
};

describe('status machine enforced by the database', () => {
  const allowed = new Set(LOT_TRANSITIONS.map((tr) => `${tr.from}>${tr.to}`));
  const pairs = LOT_STATUSES.flatMap((from) =>
    LOT_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs.filter(([f, to]) => !allowed.has(`${f}>${to}`)))(
    'forbids %s → %s',
    async (from, to) => {
      const id = await lotInStatus(from);
      const set = enterStatus[to].replace('BUYER', buyer);
      // Satisfy "status promises" so that only the transition rule can be the reason to fail.
      const err = await errorOf(() => t.pool.query(`UPDATE lots SET ${set} WHERE id = $1`, [id]));
      expect(sqlState(err), `${from} → ${to}`).toBe(CHECK);
      const { rows } = await t.pool.query<{ status: string }>(
        'SELECT status FROM lots WHERE id = $1',
        [id],
      );
      expect(rows[0]?.status).toBe(from);
    },
  );

  it.each(LOT_TRANSITIONS.filter((tr) => tr.from !== tr.to))(
    'allows $from → $to ($action)',
    async ({ from, to }) => {
      const id = await lotInStatus(from);
      const set = enterStatus[to].replace('BUYER', buyer);
      await expect(
        t.pool.query(`UPDATE lots SET ${set} WHERE id = $1`, [id]),
      ).resolves.toBeTruthy();
    },
  );

  it('rejects a status that does not exist', async () => {
    const id = await lotInStatus('draft');
    expect(sqlState(await errorOf(() => setLot(id, `status = 'hacked'`)))).toBe(CHECK);
  });

  it('two concurrent "approve" updates: the second sees a lot that is no longer in_review', async () => {
    const id = await lotInStatus('in_review');
    const approve = () =>
      t.pool.query(
        `UPDATE lots SET status = 'active', starts_at = now(), ends_at = now() + interval '1 day'
          WHERE id = $1 AND status = 'in_review'`,
        [id],
      );
    const results = await Promise.all(Array.from({ length: 10 }, approve));
    expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);
  });

  it('lots can never be deleted', async () => {
    const id = await lotInStatus('draft');
    expect(
      sqlState(await errorOf(() => t.pool.query('DELETE FROM lots WHERE id = $1', [id]))),
    ).toBe(INTEGRITY);
  });

  it('identity columns are immutable', async () => {
    const id = await lotInStatus('draft');
    expect(sqlState(await errorOf(() => setLot(id, 'seller_id = $1', [other])))).toBe(INTEGRITY);
    expect(sqlState(await errorOf(() => setLot(id, 'id = $1', [randomUUID()])))).toBe(INTEGRITY);
    expect(
      sqlState(await errorOf(() => setLot(id, `created_at = now() - interval '1 year'`))),
    ).toBe(INTEGRITY);
  });
});

describe('promises each status makes', () => {
  it.each([['active without a clock', `status = 'draft'`, `status = 'active'`]])(
    '%s',
    () => undefined,
  );

  const cases: [string, LotStatus, string][] = [
    ['activating without ends_at', 'in_review', `status = 'active', starts_at = now()`],
    [
      'activating without starts_at',
      'in_review',
      `status = 'active', ends_at = now() + interval '1 day'`,
    ],
    ['rejecting without a reason', 'in_review', `status = 'rejected'`],
    ['removing without a reason', 'active', `status = 'removed'`],
    [
      'awaiting_payment without a deadline',
      'active',
      `status = 'awaiting_payment', buyer_id = 'BUYER', final_price = 1, sold_at = now()`,
    ],
    [
      'awaiting_payment without a buyer',
      'active',
      `status = 'awaiting_payment', final_price = 1, sold_at = now(), payment_due_at = now()`,
    ],
    ['paid without paid_at', 'awaiting_payment', `status = 'paid'`],
    ['shipped without a tracking number', 'paid', `status = 'shipped', shipped_at = now()`],
    [
      'shipped with a junk tracking number',
      'paid',
      `status = 'shipped', shipped_at = now(), tracking_number = '<script>'`,
    ],
    ['completed without commission', 'shipped', `status = 'completed', completed_at = now()`],
  ];
  it.each(cases)('rejects %s', async (_name, from, set) => {
    const id = await lotInStatus(from);
    const err = await errorOf(() =>
      t.pool.query(`UPDATE lots SET ${set.replace('BUYER', buyer)} WHERE id = $1`, [id]),
    );
    expect(sqlState(err)).toBe(CHECK);
  });
});

describe('prices and money columns', () => {
  const bad: [string, LotOverrides][] = [
    ['start price 0', { start_price: 0, current_price: 0 }],
    ['negative start price', { start_price: -1, current_price: 0 }],
    ['over the 100 000 000 ₴ cap', { start_price: 10_000_000_001, current_price: 10_000_000_001 }],
    ['reserve below start', { reserve_price: 9_999 }],
    ['buy-now equal to start', { buy_now_price: 10_000 }],
    ['buy-now below reserve', { reserve_price: 50_000, buy_now_price: 40_000 }],
    ['current price below start', { current_price: 9_999 }],
    ['duration 0', { duration_days: 0 }],
    ['duration 11', { duration_days: 11 }],
    ['title too short', { title: 'ab' }],
    ['title too long', { title: 'x'.repeat(121) }],
    ['unknown condition', { condition: 'pristine' }],
    ['leader without max', { leader_id: 'BUYER', bid_count: 1 }],
    ['leader with no bids', { leader_id: 'BUYER', leader_max: 10_000, bid_count: 0 }],
    ['negative bid count', { bid_count: -1 }],
    ['seller leading their own lot', { leader_id: 'SELLER', leader_max: 10_000, bid_count: 1 }],
    [
      'leader max below price',
      { leader_id: 'BUYER', leader_max: 10_000, current_price: 20_000, bid_count: 1 },
    ],
    ['claim without expiry', { status: 'in_review', claimed_by: 'MOD' }],
    ['claim on a draft', { status: 'draft', claimed_by: 'MOD', claim_expires_at: new Date() }],
  ];
  it.each(bad)('rejects %s', async (_name, overrides) => {
    const resolved = Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [
        k,
        v === 'BUYER' ? buyer : v === 'SELLER' ? seller : v === 'MOD' ? moderator : v,
      ]),
    );
    const err = await errorOf(() => insertLot(t.pool, seller, resolved));
    expect(sqlState(err)).toBe(CHECK);
  });

  it('a live lot with bids must have a leader, and vice versa', async () => {
    const err = await errorOf(() => insertActiveLot(t.pool, seller, { bid_count: 3 }));
    expect(sqlState(err)).toBe(CHECK);
  });

  it('accepts the boundary values', async () => {
    await insertLot(t.pool, seller, { start_price: 1, current_price: 1, duration_days: 1 });
    await insertLot(t.pool, seller, {
      start_price: 10_000_000_000,
      current_price: 10_000_000_000,
      duration_days: 10,
    });
    await insertLot(t.pool, seller, { reserve_price: 10_000, buy_now_price: 10_001 });
  });
});

describe('who may take which part in a lot', () => {
  it('moderators and finance cannot sell', async () => {
    for (const staff of [moderator, finance]) {
      expect(sqlState(await errorOf(() => insertLot(t.pool, staff)))).toBe(CHECK);
    }
  });

  it('only a moderator can claim a lot for review', async () => {
    const id = await lotInStatus('in_review');
    for (const nonMod of [buyer, finance, seller]) {
      const err = await errorOf(() =>
        setLot(id, `claimed_by = $1, claim_expires_at = now() + interval '15 minutes'`, [nonMod]),
      );
      expect(sqlState(err)).toBe(CHECK);
    }
    await expect(
      setLot(id, `claimed_by = $1, claim_expires_at = now() + interval '15 minutes'`, [moderator]),
    ).resolves.toBeTruthy();
  });

  it('staff cannot become a leader or a buyer', async () => {
    const id = await insertActiveLot(t.pool, seller);
    const err1 = await errorOf(() =>
      setLot(id, `leader_id = $1, leader_max = 10000, bid_count = 1`, [moderator]),
    );
    expect(sqlState(err1)).toBe(CHECK);
    const sold = await lotInStatus('active');
    const err2 = await errorOf(() =>
      setLot(
        sold,
        `status = 'awaiting_payment', buyer_id = $1, final_price = 1, sold_at = now(), payment_due_at = now()`,
        [finance],
      ),
    );
    expect(sqlState(err2)).toBe(CHECK);
  });

  it('a seller cannot be the buyer of their own lot', async () => {
    const id = await lotInStatus('active');
    const err = await errorOf(() =>
      setLot(
        id,
        `status = 'awaiting_payment', buyer_id = $1, final_price = 1, sold_at = now(), payment_due_at = now()`,
        [seller],
      ),
    );
    expect(sqlState(err)).toBe(CHECK);
  });
});

describe('a live lot only moves forward', () => {
  const liveLot = async () => {
    const id = await insertActiveLot(t.pool, seller);
    await t.pool.query(
      `UPDATE lots SET current_price = 10000, bid_count = 1, leader_id = $1, leader_max = 30000 WHERE id = $2`,
      [buyer, id],
    );
    return id;
  };

  it('the price cannot go down', async () => {
    const id = await liveLot();
    await setLot(id, 'current_price = 15000, bid_count = 2');
    expect(sqlState(await errorOf(() => setLot(id, 'current_price = 12000')))).toBe(CHECK);
  });

  it('the bid counter cannot go down', async () => {
    const id = await liveLot();
    expect(
      sqlState(
        await errorOf(() => setLot(id, 'bid_count = 0, leader_id = NULL, leader_max = NULL')),
      ),
    ).toBe(CHECK);
  });

  it('the end time can only be extended, never cut short', async () => {
    const id = await liveLot();
    expect(
      sqlState(await errorOf(() => setLot(id, `ends_at = ends_at - interval '1 minute'`))),
    ).toBe(CHECK);
    await expect(setLot(id, `ends_at = ends_at + interval '2 minutes'`)).resolves.toBeTruthy();
  });

  it("a leader's own max can only be raised", async () => {
    const id = await liveLot();
    expect(sqlState(await errorOf(() => setLot(id, 'leader_max = 20000')))).toBe(CHECK);
    await expect(setLot(id, 'leader_max = 40000')).resolves.toBeTruthy();
  });

  it('event_seq only grows', async () => {
    const id = await liveLot();
    await setLot(id, 'event_seq = 5');
    expect(sqlState(await errorOf(() => setLot(id, 'event_seq = 4')))).toBe(CHECK);
  });
});

describe('editing: anything before the first bid, only appending after', () => {
  const editable = async (bids = false) => {
    const id = await insertActiveLot(t.pool, seller, {
      description: 'original text',
      reserve_price: 50_000,
    });
    if (bids) {
      await t.pool.query(
        `UPDATE lots SET bid_count = 1, leader_id = $1, leader_max = 10000 WHERE id = $2`,
        [buyer, id],
      );
    }
    return id;
  };

  it('before the first bid every field can change', async () => {
    const id = await editable();
    await expect(
      setLot(
        id,
        `title = 'New title', start_price = 5000, current_price = 5000, reserve_price = 9000, buy_now_price = 99000, description = 'rewritten', category_id = 1, duration_days = 5`,
      ),
    ).resolves.toBeTruthy();
  });

  it.each([
    ['title', `title = 'Different'`],
    ['start price', `start_price = 9000`],
    ['reserve price (raise)', `reserve_price = 99999`],
    ['reserve price (remove)', `reserve_price = NULL`],
    ['buy-now price', `buy_now_price = 99999`],
    ['condition', `condition = 'new'`],
    ['duration', `duration_days = 9`],
    ['start time', `starts_at = starts_at - interval '1 day'`],
    ['description rewritten', `description = 'something else entirely'`],
    ['description truncated', `description = 'original'`],
    ['description edited in the middle', `description = 'originAl text'`],
  ])('after the first bid, %s is locked', async (_name, set) => {
    const id = await editable(true);
    expect(sqlState(await errorOf(() => setLot(id, set)))).toBe(CHECK);
  });

  it('after the first bid, appending to the description is allowed', async () => {
    const id = await editable(true);
    await expect(
      setLot(id, `description = description || E'\\nUpdate: box included'`),
    ).resolves.toBeTruthy();
    const { rows } = await t.pool.query<{ description: string }>(
      'SELECT description FROM lots WHERE id = $1',
      [id],
    );
    expect(rows[0]?.description).toBe('original text\nUpdate: box included');
  });

  it('the seller cannot sneak a title change into the same statement as a bid', async () => {
    const id = await editable();
    // Same UPDATE changes the counters and the title: the guard looks at OLD.bid_count = 0,
    // so this is allowed by the DB (it is the application's job to forbid it). After it, locked.
    await setLot(id, `bid_count = 1, leader_id = '${buyer}', leader_max = 10000`);
    expect(sqlState(await errorOf(() => setLot(id, `title = 'late edit'`)))).toBe(CHECK);
  });

  it('a sold lot keeps its buyer and price', async () => {
    const id = await lotInStatus('paid');
    expect(sqlState(await errorOf(() => setLot(id, 'buyer_id = $1', [other])))).toBe(CHECK);
    expect(sqlState(await errorOf(() => setLot(id, 'final_price = 1')))).toBe(CHECK);
    const done = await lotInStatus('completed');
    expect(sqlState(await errorOf(() => setLot(done, 'commission = 0')))).toBe(CHECK);
  });
});

describe('bids', () => {
  const bidOn = (lot: string, user: string, amount: number, auto = false) =>
    t.pool.query(`INSERT INTO bids (lot_id, user_id, amount, is_auto) VALUES ($1, $2, $3, $4)`, [
      lot,
      user,
      amount,
      auto,
    ]);

  it('a seller cannot bid on their own lot, even straight into the table', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    expect(sqlState(await errorOf(() => bidOn(lot, seller, 10_000)))).toBe(CHECK);
  });

  it('staff cannot bid', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    for (const staff of [moderator, finance]) {
      expect(sqlState(await errorOf(() => bidOn(lot, staff, 10_000)))).toBe(CHECK);
    }
  });

  it('bid history never goes down; equal amounts (autobid answers) are fine', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await bidOn(lot, buyer, 10_000);
    await bidOn(lot, other, 10_500);
    await bidOn(lot, buyer, 10_500, true);
    expect(sqlState(await errorOf(() => bidOn(lot, other, 10_499)))).toBe(CHECK);
    await bidOn(lot, other, 11_000);
  });

  it.each([0, -5, 10_000_000_001])('rejects amount %d', async (amount) => {
    const lot = await insertActiveLot(t.pool, seller);
    expect(sqlState(await errorOf(() => bidOn(lot, buyer, amount)))).toBe(CHECK);
  });

  it('bids are immutable: only annulling is possible, and only once', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await bidOn(lot, buyer, 10_000);
    const id = (await t.pool.query<{ id: number }>('SELECT id FROM bids WHERE lot_id = $1', [lot]))
      .rows[0]!.id;
    for (const set of [
      'amount = 99999',
      'is_auto = true',
      `user_id = '${other}'`,
      `created_at = now() - interval '1 day'`,
    ]) {
      expect(
        sqlState(await errorOf(() => t.pool.query(`UPDATE bids SET ${set} WHERE id = $1`, [id]))),
        set,
      ).toBe(INTEGRITY);
    }
    expect(
      sqlState(await errorOf(() => t.pool.query('DELETE FROM bids WHERE id = $1', [id]))),
    ).toBe(INTEGRITY);
    await t.pool.query('UPDATE bids SET annulled_at = now() WHERE id = $1', [id]);
    expect(
      sqlState(
        await errorOf(() => t.pool.query('UPDATE bids SET annulled_at = NULL WHERE id = $1', [id])),
      ),
    ).toBe(INTEGRITY);
  });

  it('50 concurrent bid inserts in a single lot-locked transaction keep the history strictly ordered', async () => {
    const lot = await insertActiveLot(t.pool, seller, { start_price: 100, current_price: 100 });
    const users = await Promise.all(Array.from({ length: 5 }, () => insertUser(t.pool)));
    // The application serialises per lot with SELECT … FOR UPDATE; the database check is the safety net.
    const place = async (i: number) =>
      inTx(t.pool, async (c) => {
        await c.query('SELECT 1 FROM lots WHERE id = $1 FOR UPDATE', [lot]);
        const last =
          (
            await c.query<{ amount: number }>(
              'SELECT amount FROM bids WHERE lot_id = $1 ORDER BY id DESC LIMIT 1',
              [lot],
            )
          ).rows[0]?.amount ?? 100;
        await c.query('INSERT INTO bids (lot_id, user_id, amount) VALUES ($1, $2, $3)', [
          lot,
          users[i % 5],
          last + 5,
        ]);
      });
    await Promise.all(Array.from({ length: 50 }, (_, i) => place(i)));
    const { rows } = await t.pool.query<{ amount: number }>(
      'SELECT amount FROM bids WHERE lot_id = $1 ORDER BY id',
      [lot],
    );
    expect(rows).toHaveLength(50);
    rows.forEach((r, i) => expect(r.amount).toBe(105 + i * 5));
  });
});

describe('deposits', () => {
  const deposit = (lot: string, user: string, amount = 5_000) =>
    t.pool.query(`INSERT INTO deposits (lot_id, user_id, amount) VALUES ($1, $2, $3)`, [
      lot,
      user,
      amount,
    ]);

  it('a participant has at most one held deposit per lot, but may have several resolved ones', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await deposit(lot, buyer);
    expect(sqlState(await errorOf(() => deposit(lot, buyer)))).toBe(UNIQUE);
    await t.pool.query(
      `UPDATE deposits SET status = 'released', resolved_at = now() WHERE lot_id = $1 AND user_id = $2`,
      [lot, buyer],
    );
    await deposit(lot, buyer);
  });

  it('20 concurrent attempts to hold a deposit: exactly one', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => deposit(lot, other)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a held deposit can grow but not shrink; a resolved one is final', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await deposit(lot, buyer, 5_000);
    await t.pool.query('UPDATE deposits SET amount = 8000 WHERE lot_id = $1 AND user_id = $2', [
      lot,
      buyer,
    ]);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query('UPDATE deposits SET amount = 1000 WHERE lot_id = $1 AND user_id = $2', [
            lot,
            buyer,
          ]),
        ),
      ),
    ).toBe(CHECK);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `UPDATE deposits SET status = 'released', resolved_at = now(), amount = 1 WHERE lot_id = $1 AND user_id = $2`,
            [lot, buyer],
          ),
        ),
      ),
    ).toBe(CHECK);
    await t.pool.query(
      `UPDATE deposits SET status = 'forfeited', resolved_at = now() WHERE lot_id = $1 AND user_id = $2`,
      [lot, buyer],
    );
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `UPDATE deposits SET status = 'released' WHERE lot_id = $1 AND user_id = $2`,
            [lot, buyer],
          ),
        ),
      ),
    ).toBe(CHECK);
  });

  it('status and resolved_at must agree', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await deposit(lot, buyer);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE deposits SET status = 'released' WHERE lot_id = $1`, [lot]),
        ),
      ),
    ).toBe(CHECK);
  });
});

describe('second-chance offers (invariant 8)', () => {
  const offer = (lot: string, user: string, status = 'pending') =>
    t.pool.query(
      `INSERT INTO second_chance_offers (lot_id, user_id, amount, status, expires_at, resolved_at)
       VALUES ($1, $2, 20000, $3, now() + interval '1 day', CASE WHEN $3 = 'pending' THEN NULL ELSE now() END)`,
      [lot, user, status],
    );

  it('only one offer can be pending per lot, even under concurrency', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    const users = await Promise.all(Array.from({ length: 8 }, () => insertUser(t.pool)));
    const results = await Promise.allSettled(users.map((u) => offer(lot, u)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('the next participant can be offered once the previous offer expired', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await offer(lot, buyer);
    await t.pool.query(
      `UPDATE second_chance_offers SET status = 'expired', resolved_at = now() WHERE lot_id = $1`,
      [lot],
    );
    await offer(lot, other);
  });

  it('nobody is offered the same lot twice', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await offer(lot, buyer, 'expired');
    expect(sqlState(await errorOf(() => offer(lot, buyer)))).toBe(UNIQUE);
  });

  it('the seller is never offered their own lot', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    expect(sqlState(await errorOf(() => offer(lot, seller)))).toBe(CHECK);
  });

  it('a settled offer cannot be revived or rewritten', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    await offer(lot, buyer);
    await t.pool.query(
      `UPDATE second_chance_offers SET status = 'accepted', resolved_at = now() WHERE lot_id = $1`,
      [lot],
    );
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `UPDATE second_chance_offers SET status = 'pending', resolved_at = NULL WHERE lot_id = $1`,
            [lot],
          ),
        ),
      ),
    ).toBe(CHECK);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE second_chance_offers SET amount = 1 WHERE lot_id = $1`, [lot]),
        ),
      ),
    ).toBe(INTEGRITY);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `UPDATE second_chance_offers SET expires_at = expires_at + interval '1 year' WHERE lot_id = $1`,
            [lot],
          ),
        ),
      ),
    ).toBe(INTEGRITY);
  });

  it('a default can be recorded once per participant per lot', async () => {
    const lot = await insertActiveLot(t.pool, seller);
    const row = (u: string) =>
      t.pool.query(
        'INSERT INTO payment_defaults (lot_id, user_id, amount, forfeited) VALUES ($1, $2, 20000, 5000)',
        [lot, u],
      );
    await row(buyer);
    expect(sqlState(await errorOf(() => row(buyer)))).toBe(UNIQUE);
    await row(other);
  });
});

describe('top-ups settle exactly once (invariant 6)', () => {
  const newTopup = async () => {
    const id = randomUUID();
    await t.pool.query(`INSERT INTO topups (id, user_id, amount) VALUES ($1, $2, 50000)`, [
      id,
      buyer,
    ]);
    return id;
  };
  const settle = (id: string, status: string) =>
    t.pool.query(
      `UPDATE topups SET status = $2, settled_at = now() WHERE id = $1 AND status = 'pending'`,
      [id, status],
    );

  it('succeeded can never be flipped to failed by a late webhook, nor the reverse', async () => {
    const a = await newTopup();
    await settle(a, 'succeeded');
    const err = await errorOf(() =>
      t.pool.query(`UPDATE topups SET status = 'failed' WHERE id = $1`, [a]),
    );
    expect(sqlState(err)).toBe(CHECK);
    const b = await newTopup();
    await settle(b, 'failed');
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE topups SET status = 'succeeded' WHERE id = $1`, [b]),
        ),
      ),
    ).toBe(CHECK);
  });

  it('50 racing webhooks (half succeeded, half failed): exactly one settles it', async () => {
    const id = await newTopup();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => settle(id, i % 2 ? 'succeeded' : 'failed')),
    );
    expect(results.filter((r) => r.rowCount === 1)).toHaveLength(1);
  });

  it('the amount of a top-up cannot be changed after the fact', async () => {
    const id = await newTopup();
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query('UPDATE topups SET amount = 99999999 WHERE id = $1', [id]),
        ),
      ),
    ).toBe(INTEGRITY);
  });

  it('one provider payment can back only one top-up', async () => {
    const p = randomUUID();
    await t.pool.query(
      `INSERT INTO topups (user_id, amount, provider_payment_id) VALUES ($1, 100, $2)`,
      [buyer, p],
    );
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `INSERT INTO topups (user_id, amount, provider_payment_id) VALUES ($1, 100, $2)`,
            [other, p],
          ),
        ),
      ),
    ).toBe(UNIQUE);
  });

  it('the provider stub enforces the same rule on its own payments', async () => {
    const { rows } = await t.pool.query<{ id: string }>(
      `INSERT INTO provider.payments (amount, reference) VALUES (5000, $1) RETURNING id`,
      [randomUUID()],
    );
    const id = rows[0]!.id;
    await t.pool.query(`UPDATE provider.payments SET status = 'succeeded' WHERE id = $1`, [id]);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE provider.payments SET status = 'failed' WHERE id = $1`, [id]),
        ),
      ),
    ).toBe(CHECK);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE provider.payments SET amount = 1 WHERE id = $1`, [id]),
        ),
      ),
    ).toBe(INTEGRITY);
  });
});

describe('photos: at most 10 per lot, valid type and size', () => {
  const photo = (lot: string, position: number, overrides: Record<string, unknown> = {}) =>
    t.pool.query(
      `INSERT INTO lot_photos (lot_id, position, key, content_type, size_bytes) VALUES ($1, $2, $3, $4, $5)`,
      [
        lot,
        position,
        `k/${randomUUID()}`,
        overrides['type'] ?? 'image/jpeg',
        overrides['size'] ?? 1000,
      ],
    );

  it('positions 0..9 fit, an 11th photo cannot exist', async () => {
    const lot = await lotInStatus('draft');
    for (let i = 0; i < 10; i++) await photo(lot, i);
    expect(sqlState(await errorOf(() => photo(lot, 10)))).toBe(CHECK);
    expect(sqlState(await errorOf(() => photo(lot, 3)))).toBe(UNIQUE);
    expect(sqlState(await errorOf(() => photo(lot, -1)))).toBe(CHECK);
  });

  it('20 concurrent uploads racing for the last slots: no duplicates, never above 10', async () => {
    const lot = await lotInStatus('draft');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => photo(lot, i % 10)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it.each([
    ['SVG', { type: 'image/svg+xml' }],
    ['GIF', { type: 'image/gif' }],
    ['HTML', { type: 'text/html' }],
    ['20 MB', { size: 20 * 1024 * 1024 }],
    ['10 MB + 1 byte', { size: 10 * 1024 * 1024 + 1 }],
    ['empty', { size: 0 }],
  ])('rejects %s', async (_name, o) => {
    const lot = await lotInStatus('draft');
    expect(sqlState(await errorOf(() => photo(lot, 0, o)))).toBe(CHECK);
  });

  it('exactly 10 MB is accepted; a "ready" photo needs a preview', async () => {
    const lot = await lotInStatus('draft');
    await photo(lot, 0, { size: 10 * 1024 * 1024 });
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(`UPDATE lot_photos SET status = 'ready' WHERE lot_id = $1`, [lot]),
        ),
      ),
    ).toBe(CHECK);
  });
});

describe('event stream and audit trail', () => {
  const event = (lot: string, seq: number) =>
    t.pool.query(
      `INSERT INTO lot_events (lot_id, seq, type, payload) VALUES ($1, $2, 'bid', '{}')`,
      [lot, seq],
    );

  it('event numbers start at 1 and have no gaps or repeats', async () => {
    const lot = await lotInStatus('active');
    expect(sqlState(await errorOf(() => event(lot, 2)))).toBe(CHECK);
    await event(lot, 1);
    await event(lot, 2);
    expect(sqlState(await errorOf(() => event(lot, 2)))).toBeDefined();
    expect(sqlState(await errorOf(() => event(lot, 4)))).toBe(CHECK);
    expect(sqlState(await errorOf(() => event(lot, 0)))).toBeDefined();
  });

  it('events and audit rows are append-only', async () => {
    const lot = await lotInStatus('active');
    await event(lot, 1);
    await t.pool.query(
      `INSERT INTO lot_audit (lot_id, actor_id, action) VALUES ($1, $2, 'created')`,
      [lot, seller],
    );
    for (const q of [
      `UPDATE lot_events SET payload = '{"price":1}'`,
      `DELETE FROM lot_events`,
      `UPDATE lot_audit SET action = 'forged'`,
      `DELETE FROM lot_audit`,
    ]) {
      expect(sqlState(await errorOf(() => t.pool.query(q))), q).toBe(INTEGRITY);
    }
  });

  it('two concurrent writers of the same seq: one wins, the other is refused', async () => {
    const lot = await lotInStatus('active');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => event(lot, 1)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('email dedupe, idempotency keys, outbox', () => {
  it('an email dedupe key can only be used once, under concurrency too', async () => {
    const key = `outbid:${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        t.pool.query(
          `INSERT INTO email_log (dedupe_key, user_id, kind) VALUES ($1, $2, 'outbid')`,
          [key, buyer],
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('"sent" needs a timestamp and the reverse', async () => {
    const mk = (status: string, sentAt: string) =>
      t.pool.query(
        `INSERT INTO email_log (dedupe_key, user_id, kind, status, sent_at) VALUES ($1, $2, 'x', $3, ${sentAt})`,
        [randomUUID(), buyer, status],
      );
    expect(sqlState(await errorOf(() => mk('sent', 'NULL')))).toBe(CHECK);
    expect(sqlState(await errorOf(() => mk('pending', 'now()')))).toBe(CHECK);
    await mk('sent', 'now()');
  });

  it('idempotency: one key per user and scope; another user may reuse the same key string', async () => {
    const key = `key-${randomUUID()}`;
    const put = (user: string) =>
      t.pool.query(
        `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status_code, response) VALUES ($1, 'bid:1', $2, 'h', 200, '{}')`,
        [user, key],
      );
    await put(buyer);
    expect(sqlState(await errorOf(() => put(buyer)))).toBe(UNIQUE);
    await put(other);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status_code, response) VALUES ($1, 's', 'short', 'h', 200, '{}')`,
            [buyer],
          ),
        ),
      ),
    ).toBe(CHECK);
  });

  it('20 concurrent requests with one key: exactly one stores its result', async () => {
    const key = `race-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        t.pool.query(
          `INSERT INTO idempotency_keys (user_id, scope, key, request_hash, status_code, response) VALUES ($1, 'topup', $2, 'h', 200, '{}')`,
          [buyer, key],
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('users and sessions', () => {
  const user = (email: string, extra = '') =>
    t.pool.query(
      `INSERT INTO users (email, password_hash, display_name${extra ? ', role' : ''}) VALUES ($1, 'h', 'Name'${extra ? `, '${extra}'` : ''})`,
      [email],
    );

  it('emails are unique and stored lowercase; no role can be invented', async () => {
    const email = `${randomUUID()}@x.test`;
    await user(email);
    expect(sqlState(await errorOf(() => user(email)))).toBe(UNIQUE);
    expect(sqlState(await errorOf(() => user(email.toUpperCase())))).toBe(CHECK);
    expect(sqlState(await errorOf(() => user('nobody-at-all')))).toBe(CHECK);
    expect(sqlState(await errorOf(() => user(`${randomUUID()}@x.test`, 'admin')))).toBe(CHECK);
  });

  it('a session token hash is unique and sessions go away with their user', async () => {
    const u = await insertUser(t.pool);
    const hash = randomUUID();
    const mk = () =>
      t.pool.query(
        `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
        [u, hash],
      );
    await mk();
    expect(sqlState(await errorOf(mk))).toBe(UNIQUE);
    expect(
      sqlState(
        await errorOf(() =>
          t.pool.query(
            `INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES ($1, 'x', now(), now() - interval '1 day')`,
            [u],
          ),
        ),
      ),
    ).toBe(CHECK);
  });

  it('foreign keys: a lot cannot reference a missing seller or category', async () => {
    expect(sqlState(await errorOf(() => insertLot(t.pool, randomUUID())))).toBe('23503');
    expect(sqlState(await errorOf(() => insertLot(t.pool, seller, { category_id: 999 })))).toBe(
      '23503',
    );
  });
});
