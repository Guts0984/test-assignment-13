-- 0007: editing a published lot with no bids sends it back to moderation (active -> in_review).

CREATE OR REPLACE FUNCTION lot_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to OR (p_from, p_to) IN (
    ('draft', 'in_review'),
    ('rejected', 'draft'),
    ('in_review', 'active'),
    ('in_review', 'rejected'),
    ('active', 'in_review'),
    ('active', 'awaiting_payment'),
    ('active', 'ended_unsold'),
    ('active', 'removed'),
    ('awaiting_payment', 'paid'),
    ('awaiting_payment', 'ended_unsold'),
    ('paid', 'shipped'),
    ('shipped', 'completed')
  )
$$;

CREATE OR REPLACE FUNCTION lots_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'lot identity (id, seller, created_at) is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NOT lot_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'lot status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- A published lot goes back to review only while nobody has bid (an edit of a live lot).
  IF OLD.status = 'active' AND NEW.status = 'in_review' AND OLD.bid_count > 0 THEN
    RAISE EXCEPTION 'a lot with bids cannot go back to review' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.event_seq < OLD.event_seq THEN
    RAISE EXCEPTION 'lot event_seq can only grow' USING ERRCODE = 'check_violation';
  END IF;

  -- A sale, once paid, never changes hands or price.
  IF OLD.status IN ('paid', 'shipped', 'completed')
     AND (NEW.buyer_id IS DISTINCT FROM OLD.buyer_id OR NEW.final_price IS DISTINCT FROM OLD.final_price) THEN
    RAISE EXCEPTION 'buyer and price of a paid lot are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.commission IS NOT NULL AND NEW.commission IS DISTINCT FROM OLD.commission THEN
    RAISE EXCEPTION 'commission is immutable once set' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'active' THEN
    -- Before the first bid the seller may still change prices and duration freely (so the price
    -- and the end time may move either way). From the first bid on, both only move forward.
    IF OLD.bid_count > 0 AND NEW.current_price < OLD.current_price THEN
      RAISE EXCEPTION 'price of a live lot can only grow (% -> %)', OLD.current_price, NEW.current_price
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.bid_count < OLD.bid_count THEN
      RAISE EXCEPTION 'bid_count of a live lot can only grow' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.bid_count > 0 AND NEW.ends_at < OLD.ends_at THEN
      RAISE EXCEPTION 'a live lot can only be extended, never shortened' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.leader_max IS NOT NULL AND NEW.leader_max IS NOT NULL
       AND NEW.leader_id = OLD.leader_id AND NEW.leader_max < OLD.leader_max THEN
      RAISE EXCEPTION 'a leader''s max can only be raised' USING ERRCODE = 'check_violation';
    END IF;

    -- After the first bid the seller may only append to the description.
    IF OLD.bid_count > 0 AND (
         NEW.title <> OLD.title
         OR NEW.category_id <> OLD.category_id
         OR NEW.city_id <> OLD.city_id
         OR NEW.condition <> OLD.condition
         OR NEW.start_price <> OLD.start_price
         OR NEW.reserve_price IS DISTINCT FROM OLD.reserve_price
         OR NEW.buy_now_price IS DISTINCT FROM OLD.buy_now_price
         OR NEW.duration_days <> OLD.duration_days
         OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
         OR left(NEW.description, char_length(OLD.description)) <> OLD.description
       ) THEN
      RAISE EXCEPTION 'after the first bid only appending to the description is allowed'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := GREATEST(NEW.updated_at, OLD.updated_at);
  RETURN NEW;
END $$;

