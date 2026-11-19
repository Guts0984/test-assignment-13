-- 0004: indexes. Each one is here for a specific query; the db tests EXPLAIN those queries on the
-- full seed and fail if the planner stops using them.

-- Lot page: newest bids first.
CREATE INDEX bids_lot_idx ON bids (lot_id, id DESC);
-- "My bids".
CREATE INDEX bids_user_idx ON bids (user_id, id DESC);

-- Closing and sweeping live lots; "ending soon"; the sweeper finds overdue ones here.
CREATE INDEX lots_active_ends_idx ON lots (ends_at) WHERE status = 'active';
-- A live lot is led by someone: "lots I am leading".
CREATE INDEX lots_leader_idx ON lots (leader_id) WHERE status = 'active' AND leader_id IS NOT NULL;
-- Seller dashboard: my lots by status.
CREATE INDEX lots_seller_idx ON lots (seller_id, status, created_at DESC);
-- Winner dashboard: lots I won.
CREATE INDEX lots_buyer_idx ON lots (buyer_id, status) WHERE buyer_id IS NOT NULL;
-- Moderation queue: oldest unclaimed first; abandoned claims come back by expiry.
CREATE INDEX lots_review_queue_idx ON lots (created_at, id) WHERE status = 'in_review' AND claimed_by IS NULL;
CREATE INDEX lots_review_claims_idx ON lots (claim_expires_at) WHERE status = 'in_review' AND claimed_by IS NOT NULL;
-- Deadlines the sweeper and workers act on.
CREATE INDEX lots_payment_due_idx ON lots (payment_due_at) WHERE status = 'awaiting_payment';
CREATE INDEX lots_shipped_idx ON lots (shipped_at) WHERE status = 'shipped';
-- Finance reports are range scans over time. INCLUDE lets the planner skip the table when the
-- visibility map allows it.
CREATE INDEX lots_report_paid_idx ON lots (paid_at) INCLUDE (category_id, final_price, commission)
  WHERE paid_at IS NOT NULL;
CREATE INDEX lots_report_sold_idx ON lots (sold_at) INCLUDE (category_id, status)
  WHERE sold_at IS NOT NULL;
-- Seeding and reindexing page through lots in a stable order.
CREATE INDEX lots_category_idx ON lots (category_id);
CREATE INDEX lots_city_idx ON lots (city_id);

-- Favourite reminders: lots someone has not been reminded about yet.
CREATE INDEX favorites_unreminded_idx ON favorites (lot_id) WHERE reminded_at IS NULL;

-- Wallet history is read through ledger_entries_account_idx (0002) joined to the transaction.
