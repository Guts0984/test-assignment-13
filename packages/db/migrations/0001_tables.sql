-- 0001: core tables. Constraints that guard data live next to the columns they protect;
-- cross-row rules (ledger, status machine) are triggers in 0002 / 0003.
-- Money is bigint kopecks, never a float. 10 000 000 000 kopecks = 100 000 000 UAH is the cap.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  display_name  text        NOT NULL,
  role          text        NOT NULL DEFAULT 'user',
  locale        text        NOT NULL DEFAULT 'uk',
  failed_logins integer     NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_valid CHECK (role IN ('user', 'moderator', 'finance')),
  CONSTRAINT users_locale_valid CHECK (locale IN ('uk', 'en', 'pl')),
  CONSTRAINT users_email_format CHECK (
    email = lower(email) AND length(email) <= 254 AND position('@' IN email) > 1
  ),
  CONSTRAINT users_display_name_len CHECK (char_length(display_name) BETWEEN 2 AND 40),
  CONSTRAINT users_failed_logins_nonneg CHECK (failed_logins >= 0)
);
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE categories (
  id      smallint PRIMARY KEY,
  slug    text NOT NULL UNIQUE,
  name_uk text NOT NULL,
  name_en text NOT NULL,
  name_pl text NOT NULL
);

CREATE TABLE cities (
  id      smallint PRIMARY KEY,
  slug    text NOT NULL UNIQUE,
  name_uk text NOT NULL,
  name_en text NOT NULL,
  name_pl text NOT NULL
);

CREATE TABLE lots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        uuid        NOT NULL REFERENCES users (id),
  title            text        NOT NULL,
  description      text        NOT NULL DEFAULT '',
  category_id      smallint    NOT NULL REFERENCES categories (id),
  city_id          smallint    NOT NULL REFERENCES cities (id),
  condition        text        NOT NULL,
  start_price      bigint      NOT NULL,
  reserve_price    bigint,                       -- hidden from everyone but the seller
  buy_now_price    bigint,
  duration_days    smallint    NOT NULL,
  status           text        NOT NULL DEFAULT 'draft',
  -- live auction state
  current_price    bigint      NOT NULL,
  bid_count        integer     NOT NULL DEFAULT 0,
  leader_id        uuid REFERENCES users (id),
  leader_max       bigint,
  starts_at        timestamptz,                  -- set on approval
  ends_at          timestamptz,                  -- server clock; moved by anti-sniping
  -- sale
  buyer_id         uuid REFERENCES users (id),   -- winner, or the current second-chance offeree
  final_price      bigint,
  commission       bigint,
  sold_at          timestamptz,                  -- first time the lot got a winner
  payment_due_at   timestamptz,
  paid_at          timestamptz,
  shipped_at       timestamptz,
  tracking_number  text,
  completed_at     timestamptz,
  -- moderation
  claimed_by       uuid REFERENCES users (id),
  claim_expires_at timestamptz,
  reject_reason    text,
  removed_reason   text,
  -- bookkeeping
  event_seq        bigint      NOT NULL DEFAULT 0, -- last lot_events.seq
  version          integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lots_status_valid CHECK (status IN (
    'draft', 'in_review', 'rejected', 'active', 'ended_unsold',
    'awaiting_payment', 'paid', 'shipped', 'completed', 'removed')),
  CONSTRAINT lots_condition_valid CHECK (condition IN ('new', 'like_new', 'good', 'fair', 'for_parts')),
  CONSTRAINT lots_title_len CHECK (char_length(title) BETWEEN 3 AND 120),
  CONSTRAINT lots_description_len CHECK (char_length(description) <= 7000),
  CONSTRAINT lots_duration_valid CHECK (duration_days BETWEEN 1 AND 10),

  CONSTRAINT lots_money_range CHECK (
    start_price BETWEEN 1 AND 10000000000
    AND current_price BETWEEN 0 AND 10000000000
    AND (reserve_price IS NULL OR reserve_price BETWEEN 0 AND 10000000000)
    AND (buy_now_price IS NULL OR buy_now_price BETWEEN 1 AND 10000000000)
    AND (leader_max IS NULL OR leader_max BETWEEN 1 AND 10000000000)
    AND (final_price IS NULL OR final_price BETWEEN 1 AND 10000000000)
    AND (commission IS NULL OR commission >= 0)
  ),
  CONSTRAINT lots_reserve_not_below_start CHECK (reserve_price IS NULL OR reserve_price >= start_price),
  CONSTRAINT lots_buy_now_above_start CHECK (buy_now_price IS NULL OR buy_now_price > start_price),
  CONSTRAINT lots_buy_now_not_below_reserve CHECK (
    buy_now_price IS NULL OR reserve_price IS NULL OR buy_now_price >= reserve_price),
  CONSTRAINT lots_price_not_below_start CHECK (current_price >= start_price),
  CONSTRAINT lots_commission_within_price CHECK (commission IS NULL OR commission <= final_price),

  CONSTRAINT lots_bid_count_nonneg CHECK (bid_count >= 0),
  -- A leader and their max always come together, and only exist once someone has bid.
  CONSTRAINT lots_leader_pair CHECK ((leader_id IS NULL) = (leader_max IS NULL)),
  CONSTRAINT lots_leader_needs_bids CHECK (leader_id IS NULL OR bid_count > 0),
  CONSTRAINT lots_leader_not_seller CHECK (leader_id IS NULL OR leader_id <> seller_id),
  CONSTRAINT lots_leader_max_covers_price CHECK (leader_max IS NULL OR leader_max >= current_price),
  -- While live, "someone has bid" and "there is a leader" are the same fact.
  CONSTRAINT lots_active_leader_matches_bids CHECK (
    status <> 'active' OR ((bid_count = 0) = (leader_id IS NULL))),
  CONSTRAINT lots_buyer_not_seller CHECK (buyer_id IS NULL OR buyer_id <> seller_id),

  -- Fields a status promises.
  CONSTRAINT lots_active_has_clock CHECK (status <> 'active' OR (ends_at IS NOT NULL AND starts_at IS NOT NULL)),
  CONSTRAINT lots_sale_has_buyer CHECK (
    status NOT IN ('awaiting_payment', 'paid', 'shipped', 'completed')
    OR (buyer_id IS NOT NULL AND final_price IS NOT NULL AND sold_at IS NOT NULL)),
  CONSTRAINT lots_awaiting_has_deadline CHECK (status <> 'awaiting_payment' OR payment_due_at IS NOT NULL),
  CONSTRAINT lots_paid_has_time CHECK (status NOT IN ('paid', 'shipped', 'completed') OR paid_at IS NOT NULL),
  CONSTRAINT lots_shipped_has_tracking CHECK (
    status NOT IN ('shipped', 'completed') OR (shipped_at IS NOT NULL AND tracking_number IS NOT NULL)),
  CONSTRAINT lots_completed_has_commission CHECK (
    status <> 'completed' OR (completed_at IS NOT NULL AND commission IS NOT NULL)),
  CONSTRAINT lots_rejected_has_reason CHECK (status <> 'rejected' OR reject_reason IS NOT NULL),
  CONSTRAINT lots_removed_has_reason CHECK (status <> 'removed' OR removed_reason IS NOT NULL),
  -- A moderator claim exists only on a lot waiting for review.
  CONSTRAINT lots_claim_pair CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL)),
  CONSTRAINT lots_claim_only_in_review CHECK (claimed_by IS NULL OR status = 'in_review'),
  CONSTRAINT lots_tracking_format CHECK (
    tracking_number IS NULL OR tracking_number ~ '^[A-Za-z0-9 -]{3,64}$')
);

CREATE TABLE lot_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id       uuid        NOT NULL REFERENCES lots (id),
  position     smallint    NOT NULL,
  key          text        NOT NULL,               -- object key of the processed image
  preview_key  text,                               -- 400 px preview
  content_type text        NOT NULL,
  size_bytes   integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The 10-photo limit is a column constraint: positions are 0..9 and unique per lot.
  CONSTRAINT lot_photos_position_range CHECK (position BETWEEN 0 AND 9),
  CONSTRAINT lot_photos_type_valid CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CONSTRAINT lot_photos_size_valid CHECK (size_bytes BETWEEN 1 AND 10485760),
  CONSTRAINT lot_photos_status_valid CHECK (status IN ('pending', 'ready', 'rejected')),
  CONSTRAINT lot_photos_ready_has_preview CHECK (status <> 'ready' OR preview_key IS NOT NULL)
);
CREATE UNIQUE INDEX lot_photos_position_key ON lot_photos (lot_id, position);

CREATE TABLE bids (
  id          bigserial PRIMARY KEY,
  lot_id      uuid        NOT NULL REFERENCES lots (id),
  user_id     uuid        NOT NULL REFERENCES users (id),
  amount      bigint      NOT NULL,
  is_auto     boolean     NOT NULL DEFAULT false,  -- placed by the system on the user's behalf
  created_at  timestamptz NOT NULL DEFAULT now(),
  annulled_at timestamptz,                         -- lot removed by a moderator
  CONSTRAINT bids_amount_range CHECK (amount BETWEEN 1 AND 10000000000)
);

CREATE TABLE deposits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid        NOT NULL REFERENCES lots (id),
  user_id     uuid        NOT NULL REFERENCES users (id),
  amount      bigint      NOT NULL,
  status      text        NOT NULL DEFAULT 'held',
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT deposits_amount_range CHECK (amount BETWEEN 1 AND 10000000000),
  CONSTRAINT deposits_status_valid CHECK (status IN ('held', 'released', 'applied', 'forfeited')),
  CONSTRAINT deposits_resolved_matches_status CHECK ((status = 'held') = (resolved_at IS NULL))
);
-- One live deposit per participant per lot, so a retry can never lock the money twice.
CREATE UNIQUE INDEX deposits_one_held_key ON deposits (lot_id, user_id) WHERE status = 'held';
CREATE INDEX deposits_user_held_idx ON deposits (user_id) WHERE status = 'held';

CREATE TABLE second_chance_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid        NOT NULL REFERENCES lots (id),
  user_id     uuid        NOT NULL REFERENCES users (id),
  amount      bigint      NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT offers_amount_range CHECK (amount BETWEEN 1 AND 10000000000),
  CONSTRAINT offers_status_valid CHECK (status IN ('pending', 'accepted', 'expired')),
  CONSTRAINT offers_resolved_matches_status CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CONSTRAINT offers_expiry_after_creation CHECK (expires_at > created_at)
);
-- One offer at a time per lot, and nobody is offered the same lot twice.
CREATE UNIQUE INDEX offers_one_pending_key ON second_chance_offers (lot_id) WHERE status = 'pending';
CREATE UNIQUE INDEX offers_user_once_key ON second_chance_offers (lot_id, user_id);
CREATE INDEX offers_due_idx ON second_chance_offers (expires_at) WHERE status = 'pending';

CREATE TABLE payment_defaults (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id     uuid        NOT NULL REFERENCES lots (id),
  user_id    uuid        NOT NULL REFERENCES users (id),
  amount     bigint      NOT NULL,                 -- the price they failed to pay
  forfeited  bigint      NOT NULL,                 -- deposit that went to the seller
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT defaults_amounts CHECK (amount > 0 AND forfeited >= 0)
);
CREATE UNIQUE INDEX defaults_once_key ON payment_defaults (lot_id, user_id);
CREATE INDEX defaults_created_idx ON payment_defaults (created_at);

CREATE TABLE topups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users (id),
  amount              bigint      NOT NULL,
  status              text        NOT NULL DEFAULT 'pending',
  provider_payment_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  CONSTRAINT topups_amount_range CHECK (amount BETWEEN 1 AND 10000000000),
  CONSTRAINT topups_status_valid CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT topups_settled_matches_status CHECK ((status = 'pending') = (settled_at IS NULL))
);
CREATE UNIQUE INDEX topups_provider_payment_key ON topups (provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX topups_user_idx ON topups (user_id, created_at DESC);
CREATE INDEX topups_pending_idx ON topups (created_at) WHERE status = 'pending';

CREATE TABLE idempotency_keys (
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope        text        NOT NULL,               -- e.g. "bid:{lotId}", "topup", "pay:{lotId}"
  key          text        NOT NULL,
  request_hash text        NOT NULL,               -- sha256 of the canonical request body
  status_code  integer     NOT NULL,
  response     jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, key),
  CONSTRAINT idem_key_len CHECK (char_length(key) BETWEEN 8 AND 128)
);
CREATE INDEX idem_created_idx ON idempotency_keys (created_at);

CREATE TABLE lot_events (
  lot_id     uuid        NOT NULL REFERENCES lots (id),
  seq        bigint      NOT NULL,
  type       text        NOT NULL,
  payload    jsonb       NOT NULL,                 -- public data only; never the reserve price
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lot_id, seq),
  CONSTRAINT lot_events_seq_positive CHECK (seq > 0)
);

CREATE TABLE lot_audit (
  id         bigserial PRIMARY KEY,
  lot_id     uuid        NOT NULL REFERENCES lots (id),
  actor_id   uuid REFERENCES users (id),           -- NULL = the system
  action     text        NOT NULL,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lot_audit_lot_idx ON lot_audit (lot_id, id);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text        NOT NULL,
  aggregate_id uuid,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE processed_at IS NULL;

CREATE TABLE email_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key  text        NOT NULL,                -- the same key can never produce two emails
  user_id     uuid        NOT NULL REFERENCES users (id),
  kind        text        NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status      text        NOT NULL DEFAULT 'pending',
  attempts    integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  CONSTRAINT email_status_valid CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT email_sent_matches_status CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT email_attempts_nonneg CHECK (attempts >= 0)
);
CREATE UNIQUE INDEX email_dedupe_key ON email_log (dedupe_key);
CREATE INDEX email_pending_idx ON email_log (created_at) WHERE status = 'pending';

-- Per user and lot: when the last "you were outbid" email was queued (15-minute throttle).
CREATE TABLE outbid_email_state (
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  lot_id          uuid        NOT NULL REFERENCES lots (id),
  last_emailed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, lot_id)
);

CREATE TABLE favorites (
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  lot_id      uuid        NOT NULL REFERENCES lots (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  reminded_at timestamptz,                         -- the single "ends in an hour" reminder
  PRIMARY KEY (user_id, lot_id)
);
CREATE INDEX favorites_lot_idx ON favorites (lot_id);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at    timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, id DESC);

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);
