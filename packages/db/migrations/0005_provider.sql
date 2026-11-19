-- 0005: the payment stub's own data. A separate schema because it plays a company that is
-- not us: the app talks to it over HTTP and never reads these tables directly.
CREATE SCHEMA provider;

CREATE TABLE provider.payments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount     bigint      NOT NULL,
  reference  text        NOT NULL,                -- what the merchant sent (our top-up id)
  status     text        NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_payments_amount CHECK (amount BETWEEN 1 AND 10000000000),
  CONSTRAINT provider_payments_status CHECK (status IN ('pending', 'succeeded', 'failed'))
);
CREATE UNIQUE INDEX provider_payments_reference_key ON provider.payments (reference);
CREATE INDEX provider_payments_pending_idx ON provider.payments (created_at) WHERE status = 'pending';

-- Provider-side payments are final too (same rule as our top-ups).
CREATE TRIGGER provider_payments_settle_once BEFORE UPDATE ON provider.payments
  FOR EACH ROW EXECUTE FUNCTION settle_once();
