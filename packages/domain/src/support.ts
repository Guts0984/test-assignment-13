import { appError, maskName, type AuctionState, type LotStatus } from '@auction/shared';
import type { DomainEvent, Notification, Tx } from './types.js';

export type LotRow = {
  id: string;
  seller_id: string;
  title: string;
  description: string;
  category_id: number;
  city_id: number;
  condition: string;
  status: LotStatus;
  start_price: number;
  reserve_price: number | null;
  buy_now_price: number | null;
  duration_days: number;
  current_price: number;
  bid_count: number;
  leader_id: string | null;
  leader_max: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  buyer_id: string | null;
  final_price: number | null;
  commission: number | null;
  sold_at: Date | null;
  payment_due_at: Date | null;
  paid_at: Date | null;
  shipped_at: Date | null;
  tracking_number: string | null;
  completed_at: Date | null;
  claimed_by: string | null;
  claim_expires_at: Date | null;
  event_seq: number;
  version: number;
};

/** Takes the lot's row lock. Every use case that changes a lot starts here, so changes are serial. */
export const lockLot = async (tx: Tx, lotId: string): Promise<LotRow> => {
  const { rows } = await tx.query<LotRow>('SELECT * FROM lots WHERE id = $1 FOR UPDATE', [lotId]);
  const lot = rows[0];
  if (!lot) throw appError('NOT_FOUND', 'lot not found');
  return lot;
};

export const toAuctionState = (lot: LotRow): AuctionState => ({
  status: lot.status,
  sellerId: lot.seller_id,
  startPrice: lot.start_price,
  reservePrice: lot.reserve_price,
  currentPrice: lot.current_price,
  bidCount: lot.bid_count,
  leader:
    lot.leader_id !== null && lot.leader_max !== null
      ? { userId: lot.leader_id, maxBid: lot.leader_max }
      : null,
  endsAt: lot.ends_at?.getTime() ?? 0,
});

export type UserRow = { id: string; role: 'user' | 'moderator' | 'finance'; display_name: string };

export const getUser = async (tx: Tx, userId: string): Promise<UserRow | undefined> =>
  (await tx.query<UserRow>('SELECT id, role, display_name FROM users WHERE id = $1', [userId]))
    .rows[0];

/** Requires an ordinary user (staff never trade). */
export const requireTrader = async (tx: Tx, userId: string): Promise<UserRow> => {
  const user = await getUser(tx, userId);
  if (!user) throw appError('UNAUTHENTICATED', 'unknown user');
  if (user.role !== 'user')
    throw appError('STAFF_CANNOT_TRADE', 'moderators and finance cannot trade');
  return user;
};

export const maskedNames = async (
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, string>> => {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();
  const { rows } = await tx.query<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])',
    [unique],
  );
  return new Map(rows.map((r) => [r.id, maskName(r.display_name)]));
};

/** Appends the next numbered event for the lot. Call with the lot row lock held. */
export const appendEvent = async (
  tx: Tx,
  lot: Pick<LotRow, 'id' | 'event_seq'>,
  seqOffset: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  at: Date,
): Promise<DomainEvent> => {
  const seq = lot.event_seq + seqOffset;
  await tx.query(
    `INSERT INTO lot_events (lot_id, seq, type, payload, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [lot.id, seq, type, JSON.stringify(payload), at],
  );
  return { lotId: lot.id, seq, type, payload };
};

export const audit = async (
  tx: Tx,
  lotId: string,
  actorId: string | null,
  action: string,
  at: Date,
  detail: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await tx.query(
    `INSERT INTO lot_audit (lot_id, actor_id, action, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [lotId, actorId, action, JSON.stringify(detail), at],
  );
};

/** Tells the search sync that this lot changed (the worker decides what to index). */
export const queueLotSync = async (tx: Tx, lotId: string, at: Date): Promise<void> => {
  await tx.query(
    `INSERT INTO outbox (topic, aggregate_id, payload, created_at) VALUES ('lot.upsert', $1, '{}', $2)`,
    [lotId, at],
  );
};

/** Stores an in-app notification. */
export const notify = async (tx: Tx, n: Notification, at: Date): Promise<Notification> => {
  await tx.query(
    `INSERT INTO notifications (user_id, kind, payload, created_at) VALUES ($1, $2, $3, $4)`,
    [n.userId, n.kind, JSON.stringify(n.payload), at],
  );
  return n;
};

/** Queues an email once per dedupe key, however many times this runs. */
export const queueEmail = async (
  tx: Tx,
  email: {
    userId: string;
    kind: string;
    dedupeKey: string;
    payload: Readonly<Record<string, unknown>>;
  },
  at: Date,
): Promise<boolean> => {
  const r = await tx.query(
    `INSERT INTO email_log (dedupe_key, user_id, kind, payload, created_at)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (dedupe_key) DO NOTHING`,
    [email.dedupeKey, email.userId, email.kind, JSON.stringify(email.payload), at],
  );
  return (r.rowCount ?? 0) > 0;
};

/** Public part of the lot's live state: nothing here may reveal the reserve price. */
export const publicState = (
  lot: Pick<LotRow, 'current_price' | 'bid_count' | 'ends_at' | 'reserve_price'>,
): {
  currentPrice: number;
  bidCount: number;
  endsAt: string | null;
  reserveMet: boolean | null;
} => ({
  currentPrice: lot.current_price,
  bidCount: lot.bid_count,
  endsAt: lot.ends_at?.toISOString() ?? null,
  // `null` = the lot has no reserve at all. Otherwise only "met / not met", never the amount.
  reserveMet:
    lot.reserve_price === null ? null : lot.current_price >= lot.reserve_price && lot.bid_count > 0,
});
