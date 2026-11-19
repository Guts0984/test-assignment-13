-- 0002: double-entry ledger. The database refuses to let money appear or vanish, whatever
-- the application does.
--
--   * every transaction's entries sum to zero and there are at least two (checked at COMMIT)
--   * entries and transactions are append-only
--   * accounts.balance is derived: only the entry trigger may change it
--   * user accounts, escrow and held money can never go below zero
--   * `ledger_transactions.ref` is unique: the same business event can't be booked twice

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text   NOT NULL,                      -- 'user:<id>:available', 'escrow:<lot id>', ...
  kind       text   NOT NULL,
  owner_id   uuid REFERENCES users (id),
  lot_id     uuid REFERENCES lots (id),
  balance    bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT accounts_kind_valid CHECK (kind IN (
    'external', 'user_available', 'user_held', 'escrow', 'platform_commission')),
  -- Only the outside world may go negative (it is where top-ups come from), and the
  -- platform's own commission account is a sink that only grows.
  CONSTRAINT accounts_no_overdraft CHECK (kind = 'external' OR balance >= 0),
  CONSTRAINT accounts_shape CHECK (
    (kind IN ('user_available', 'user_held') AND owner_id IS NOT NULL AND lot_id IS NULL)
    OR (kind = 'escrow' AND lot_id IS NOT NULL AND owner_id IS NULL)
    OR (kind IN ('external', 'platform_commission') AND owner_id IS NULL AND lot_id IS NULL)),
  CONSTRAINT accounts_key_matches_shape CHECK (
    (kind = 'user_available' AND key = 'user:' || owner_id || ':available')
    OR (kind = 'user_held' AND key = 'user:' || owner_id || ':held')
    OR (kind = 'escrow' AND key = 'escrow:' || lot_id)
    OR (kind = 'external' AND key = 'external:payment_provider')
    OR (kind = 'platform_commission' AND key = 'platform:commission'))
);
CREATE UNIQUE INDEX accounts_key_key ON accounts (key);
CREATE INDEX accounts_owner_idx ON accounts (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE ledger_transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text        NOT NULL,                 -- topup, hold, release, pay, forfeit, payout, ...
  ref        text        NOT NULL,                 -- business idempotency key, e.g. 'topup:<id>'
  lot_id     uuid REFERENCES lots (id),
  user_id    uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ledger_transactions_ref_key ON ledger_transactions (ref);
CREATE INDEX ledger_transactions_lot_idx ON ledger_transactions (lot_id) WHERE lot_id IS NOT NULL;
CREATE INDEX ledger_transactions_created_idx ON ledger_transactions (created_at);

CREATE TABLE ledger_entries (
  id         bigserial PRIMARY KEY,
  tx_id      uuid   NOT NULL REFERENCES ledger_transactions (id),
  account_id uuid   NOT NULL REFERENCES accounts (id),
  amount     bigint NOT NULL,                      -- + debit side, - credit side, kopecks
  CONSTRAINT ledger_entries_nonzero CHECK (amount <> 0),
  CONSTRAINT ledger_entries_range CHECK (amount BETWEEN -10000000000 AND 10000000000)
);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (tx_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id DESC);

-- ---------------------------------------------------------------------------------------------
-- Append-only
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ledger_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();

-- ---------------------------------------------------------------------------------------------
-- Balance is derived from entries
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ledger_apply_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Locks the account row until commit, which serialises concurrent spenders of one balance.
  -- The CHECK on accounts then rejects an overdraft against the *current* balance.
  UPDATE accounts SET balance = balance + NEW.amount WHERE id = NEW.account_id;
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_entries_apply AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry();

CREATE FUNCTION accounts_guard_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Depth 1 = called from ledger_apply_entry(). A direct UPDATE has depth 0.
  IF NEW.balance IS DISTINCT FROM OLD.balance AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'accounts.balance is derived from ledger entries and cannot be edited'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.key <> OLD.key OR NEW.kind <> OLD.kind
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.lot_id IS DISTINCT FROM OLD.lot_id THEN
    RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_guard BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_guard_balance();

CREATE FUNCTION accounts_forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'accounts cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER accounts_no_delete BEFORE DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_forbid_delete();

-- Only ordinary users own wallets. Moderators and finance never touch money.
CREATE FUNCTION accounts_owner_is_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_id IS NOT NULL
     AND (SELECT role FROM users WHERE id = NEW.owner_id) <> 'user' THEN
    RAISE EXCEPTION 'only ordinary users can own a wallet' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_owner_role BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_owner_is_user();

-- ---------------------------------------------------------------------------------------------
-- Every transaction sums to zero (checked when the database transaction commits)
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tx uuid;
  v_sum bigint;
  v_count integer;
BEGIN
  -- The same function guards both tables; NEW has different columns in each.
  IF TG_TABLE_NAME = 'ledger_entries' THEN v_tx := NEW.tx_id; ELSE v_tx := NEW.id; END IF;
  SELECT COALESCE(SUM(amount), 0), COUNT(*) INTO v_sum, v_count
    FROM ledger_entries WHERE tx_id = v_tx;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries, need at least 2', v_tx, v_count
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_sum <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: entries sum to %', v_tx, v_sum
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
-- A transaction header with no entries at all is also an error.
CREATE CONSTRAINT TRIGGER ledger_transactions_have_entries AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
