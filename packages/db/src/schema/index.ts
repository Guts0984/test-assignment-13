import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle mirror of the SQL migrations. The migrations are the source of truth (they carry the
 * triggers and CHECKs); a test compares this file with the live database column by column, so a
 * change in one without the other fails CI.
 */

const kop = (name: string) => bigint(name, { mode: 'number' });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['user', 'moderator', 'finance'] })
    .notNull()
    .default('user'),
  locale: text('locale', { enum: ['uk', 'en', 'pl'] })
    .notNull()
    .default('uk'),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: at('locked_until'),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
});

export const categories = pgTable('categories', {
  id: smallint('id').primaryKey(),
  slug: text('slug').notNull(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en').notNull(),
  namePl: text('name_pl').notNull(),
});

export const cities = pgTable('cities', {
  id: smallint('id').primaryKey(),
  slug: text('slug').notNull(),
  nameUk: text('name_uk').notNull(),
  nameEn: text('name_en').notNull(),
  namePl: text('name_pl').notNull(),
});

export const LOT_STATUS_VALUES = [
  'draft',
  'in_review',
  'rejected',
  'active',
  'ended_unsold',
  'awaiting_payment',
  'paid',
  'shipped',
  'completed',
  'removed',
] as const;

export const lots = pgTable(
  'lots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sellerId: uuid('seller_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    categoryId: smallint('category_id')
      .notNull()
      .references(() => categories.id),
    cityId: smallint('city_id')
      .notNull()
      .references(() => cities.id),
    condition: text('condition', {
      enum: ['new', 'like_new', 'good', 'fair', 'for_parts'],
    }).notNull(),
    startPrice: kop('start_price').notNull(),
    reservePrice: kop('reserve_price'),
    buyNowPrice: kop('buy_now_price'),
    durationDays: smallint('duration_days').notNull(),
    status: text('status', { enum: LOT_STATUS_VALUES }).notNull().default('draft'),
    currentPrice: kop('current_price').notNull(),
    bidCount: integer('bid_count').notNull().default(0),
    leaderId: uuid('leader_id').references(() => users.id),
    leaderMax: kop('leader_max'),
    startsAt: at('starts_at'),
    endsAt: at('ends_at'),
    buyerId: uuid('buyer_id').references(() => users.id),
    finalPrice: kop('final_price'),
    commission: kop('commission'),
    soldAt: at('sold_at'),
    paymentDueAt: at('payment_due_at'),
    paidAt: at('paid_at'),
    shippedAt: at('shipped_at'),
    trackingNumber: text('tracking_number'),
    completedAt: at('completed_at'),
    claimedBy: uuid('claimed_by').references(() => users.id),
    claimExpiresAt: at('claim_expires_at'),
    rejectReason: text('reject_reason'),
    removedReason: text('removed_reason'),
    eventSeq: kop('event_seq').notNull().default(0),
    version: integer('version').notNull().default(0),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('lots_active_ends_idx')
      .on(t.endsAt)
      .where(sql`${t.status} = 'active'`),
    index('lots_seller_idx').on(t.sellerId, t.status, t.createdAt),
  ],
);

export const lotPhotos = pgTable(
  'lot_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    position: smallint('position').notNull(),
    key: text('key').notNull(),
    previewKey: text('preview_key'),
    contentType: text('content_type', {
      enum: ['image/jpeg', 'image/png', 'image/webp'],
    }).notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ['pending', 'ready', 'rejected'] })
      .notNull()
      .default('pending'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('lot_photos_position_key').on(t.lotId, t.position)],
);

export const bids = pgTable('bids', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  lotId: uuid('lot_id')
    .notNull()
    .references(() => lots.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  amount: kop('amount').notNull(),
  isAuto: boolean('is_auto').notNull().default(false),
  createdAt: at('created_at').notNull().defaultNow(),
  annulledAt: at('annulled_at'),
});

export const deposits = pgTable('deposits', {
  id: uuid('id').primaryKey().defaultRandom(),
  lotId: uuid('lot_id')
    .notNull()
    .references(() => lots.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  amount: kop('amount').notNull(),
  status: text('status', { enum: ['held', 'released', 'applied', 'forfeited'] })
    .notNull()
    .default('held'),
  createdAt: at('created_at').notNull().defaultNow(),
  resolvedAt: at('resolved_at'),
});

export const secondChanceOffers = pgTable('second_chance_offers', {
  id: uuid('id').primaryKey().defaultRandom(),
  lotId: uuid('lot_id')
    .notNull()
    .references(() => lots.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  amount: kop('amount').notNull(),
  status: text('status', { enum: ['pending', 'accepted', 'expired'] })
    .notNull()
    .default('pending'),
  createdAt: at('created_at').notNull().defaultNow(),
  expiresAt: at('expires_at').notNull(),
  resolvedAt: at('resolved_at'),
});

export const paymentDefaults = pgTable('payment_defaults', {
  id: uuid('id').primaryKey().defaultRandom(),
  lotId: uuid('lot_id')
    .notNull()
    .references(() => lots.id),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  amount: kop('amount').notNull(),
  forfeited: kop('forfeited').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const topups = pgTable('topups', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  amount: kop('amount').notNull(),
  status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
    .notNull()
    .default('pending'),
  providerPaymentId: uuid('provider_payment_id'),
  createdAt: at('created_at').notNull().defaultNow(),
  settledAt: at('settled_at'),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    response: jsonb('response').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scope, t.key] })],
);

export const lotEvents = pgTable(
  'lot_events',
  {
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    seq: kop('seq').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.lotId, t.seq] })],
);

export const lotAudit = pgTable('lot_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  lotId: uuid('lot_id')
    .notNull()
    .references(() => lots.id),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  detail: jsonb('detail').notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  topic: text('topic').notNull(),
  aggregateId: uuid('aggregate_id'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
  processedAt: at('processed_at'),
});

export const emailLog = pgTable('email_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  dedupeKey: text('dedupe_key').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull().default({}),
  status: text('status', { enum: ['pending', 'sent', 'failed'] })
    .notNull()
    .default('pending'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: at('created_at').notNull().defaultNow(),
  sentAt: at('sent_at'),
});

export const outbidEmailState = pgTable(
  'outbid_email_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    lastEmailedAt: at('last_emailed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.lotId] })],
);

export const favorites = pgTable(
  'favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    lotId: uuid('lot_id')
      .notNull()
      .references(() => lots.id),
    createdAt: at('created_at').notNull().defaultNow(),
    remindedAt: at('reminded_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.lotId] })],
);

export const notifications = pgTable('notifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
  readAt: at('read_at'),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull(),
  kind: text('kind', {
    enum: ['external', 'user_available', 'user_held', 'escrow', 'platform_commission'],
  }).notNull(),
  ownerId: uuid('owner_id').references(() => users.id),
  lotId: uuid('lot_id').references(() => lots.id),
  balance: kop('balance').notNull().default(0),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  lotId: uuid('lot_id').references(() => lots.id),
  userId: uuid('user_id').references(() => users.id),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const ledgerEntries = pgTable('ledger_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  txId: uuid('tx_id')
    .notNull()
    .references(() => ledgerTransactions.id),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  amount: kop('amount').notNull(),
});

/** The payment stub lives in its own Postgres schema: it plays an outside company. */
export const providerSchema = pgSchema('provider');

export const providerPayments = providerSchema.table('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  amount: kop('amount').notNull(),
  reference: text('reference').notNull(),
  status: text('status', { enum: ['pending', 'succeeded', 'failed'] })
    .notNull()
    .default('pending'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
});
