-- 0003: business guards the application must not be able to bypass.

-- ---------------------------------------------------------------------------------------------
-- Lot status machine + edit rules
-- ---------------------------------------------------------------------------------------------
-- The allowed (from, to) pairs. A test compares this list with LOT_TRANSITIONS in
-- @auction/shared so the two can never drift apart.
CREATE FUNCTION lot_transition_allowed(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_from = p_to OR (p_from, p_to) IN (
    ('draft', 'in_review'),
    ('rejected', 'draft'),
    ('in_review', 'active'),
    ('in_review', 'rejected'),
    ('active', 'awaiting_payment'),
    ('active', 'ended_unsold'),
    ('active', 'removed'),
    ('awaiting_payment', 'paid'),
    ('awaiting_payment', 'ended_unsold'),
    ('paid', 'shipped'),
    ('shipped', 'completed')
  )
$$;

CREATE FUNCTION lots_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'lot identity (id, seller, created_at) is immutable'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NOT lot_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'lot status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
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

CREATE TRIGGER lots_guard BEFORE UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION lots_guard_update();

CREATE FUNCTION lots_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'lots are never deleted; remove them by status' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER lots_no_delete BEFORE DELETE ON lots
  FOR EACH ROW EXECUTE FUNCTION lots_forbid_delete();

-- Who may play which part. Staff never sell, buy or hold money; only moderators claim lots.
CREATE FUNCTION lots_check_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.seller_id IS DISTINCT FROM OLD.seller_id)
     AND (SELECT role FROM users WHERE id = NEW.seller_id) <> 'user' THEN
    RAISE EXCEPTION 'only ordinary users can sell' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.leader_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.leader_id IS DISTINCT FROM OLD.leader_id)
     AND (SELECT role FROM users WHERE id = NEW.leader_id) <> 'user' THEN
    RAISE EXCEPTION 'only ordinary users can bid' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.buyer_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.buyer_id IS DISTINCT FROM OLD.buyer_id)
     AND (SELECT role FROM users WHERE id = NEW.buyer_id) <> 'user' THEN
    RAISE EXCEPTION 'only ordinary users can buy' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.claimed_by IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.claimed_by IS DISTINCT FROM OLD.claimed_by)
     AND (SELECT role FROM users WHERE id = NEW.claimed_by) <> 'moderator' THEN
    RAISE EXCEPTION 'only moderators can claim a lot for review' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lots_roles BEFORE INSERT OR UPDATE ON lots
  FOR EACH ROW EXECUTE FUNCTION lots_check_roles();

-- ---------------------------------------------------------------------------------------------
-- Bids: append-only history, never on your own lot, amounts never go backwards
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION bids_guard_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_seller uuid;
  v_last bigint;
BEGIN
  SELECT seller_id INTO v_seller FROM lots WHERE id = NEW.lot_id;
  IF NEW.user_id = v_seller THEN
    RAISE EXCEPTION 'a seller cannot bid on their own lot' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT role FROM users WHERE id = NEW.user_id) <> 'user' THEN
    RAISE EXCEPTION 'only ordinary users can bid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT amount INTO v_last FROM bids WHERE lot_id = NEW.lot_id ORDER BY id DESC LIMIT 1;
  IF v_last IS NOT NULL AND NEW.amount < v_last THEN
    RAISE EXCEPTION 'bid history must not go down (% after %)', NEW.amount, v_last
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bids_guard BEFORE INSERT ON bids
  FOR EACH ROW EXECUTE FUNCTION bids_guard_insert();

CREATE FUNCTION bids_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bids are never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.lot_id <> OLD.lot_id OR NEW.user_id <> OLD.user_id
     OR NEW.amount <> OLD.amount OR NEW.is_auto <> OLD.is_auto OR NEW.created_at <> OLD.created_at
     OR OLD.annulled_at IS NOT NULL THEN
    RAISE EXCEPTION 'a bid can only be annulled, nothing else about it changes'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bids_guard_change BEFORE UPDATE OR DELETE ON bids
  FOR EACH ROW EXECUTE FUNCTION bids_guard_update();

-- ---------------------------------------------------------------------------------------------
-- Settled records do not change: top-ups, deposits, second-chance offers
-- ---------------------------------------------------------------------------------------------
-- A top-up (or provider payment) leaves `pending` exactly once. A late "failed" webhook can
-- never turn a credited top-up back into a failure, and vice versa.
CREATE FUNCTION settle_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.amount <> OLD.amount THEN
    RAISE EXCEPTION '% id and amount are immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION '% % is already % and cannot become %', TG_TABLE_NAME, OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER topups_settle_once BEFORE UPDATE ON topups
  FOR EACH ROW EXECUTE FUNCTION settle_once();

CREATE FUNCTION deposits_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.lot_id <> OLD.lot_id OR NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'deposit identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'held' THEN
    RAISE EXCEPTION 'deposit is already % and cannot change', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  -- While held, a deposit may only grow (the participant raised their maximum).
  IF NEW.status = 'held' AND NEW.amount < OLD.amount THEN
    RAISE EXCEPTION 'a held deposit cannot shrink' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'held' AND NEW.amount <> OLD.amount THEN
    RAISE EXCEPTION 'a deposit is resolved at the amount that was held' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposits_guard_update BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION deposits_guard();

CREATE FUNCTION offers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.lot_id <> OLD.lot_id OR NEW.user_id <> OLD.user_id
     OR NEW.amount <> OLD.amount OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'a second-chance offer is immutable apart from its outcome'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'pending' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'offer is already % and cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offers_guard_update BEFORE UPDATE ON second_chance_offers
  FOR EACH ROW EXECUTE FUNCTION offers_guard();

-- Only ordinary users get offers.
CREATE FUNCTION offers_user_is_ordinary() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_seller uuid;
BEGIN
  SELECT seller_id INTO v_seller FROM lots WHERE id = NEW.lot_id;
  IF NEW.user_id = v_seller THEN
    RAISE EXCEPTION 'a seller cannot be offered their own lot' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offers_not_to_seller BEFORE INSERT ON second_chance_offers
  FOR EACH ROW EXECUTE FUNCTION offers_user_is_ordinary();

-- ---------------------------------------------------------------------------------------------
-- Event stream and audit trail: append-only; event numbers have no gaps
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER lot_events_append_only BEFORE UPDATE OR DELETE ON lot_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lot_audit_append_only BEFORE UPDATE OR DELETE ON lot_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION lot_events_gapless() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_last bigint;
BEGIN
  SELECT seq INTO v_last FROM lot_events WHERE lot_id = NEW.lot_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(v_last, 0) + 1 THEN
    RAISE EXCEPTION 'lot event seq must be %, got %', COALESCE(v_last, 0) + 1, NEW.seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lot_events_seq BEFORE INSERT ON lot_events
  FOR EACH ROW EXECUTE FUNCTION lot_events_gapless();
