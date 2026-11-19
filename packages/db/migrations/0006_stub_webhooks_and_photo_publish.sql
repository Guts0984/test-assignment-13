-- 0006: (a) the payment stub's webhook queue, (b) which photos are copied to the public bucket.

-- Where the provider sends its webhooks for this payment (the merchant's endpoint).
ALTER TABLE provider.payments ADD COLUMN notify_url text;

-- Every webhook the provider intends to send. The chaos mode decides at settlement time how many
-- rows to write (duplicate), when they are due (delay), whether a bogus contradicting one follows
-- (out of order), or whether none are written at all (lost). A sender loop delivers due rows.
CREATE TABLE provider.webhook_events (
  id           bigserial PRIMARY KEY,
  payment_id   uuid        NOT NULL REFERENCES provider.payments (id),
  event        text        NOT NULL,
  deliver_at   timestamptz NOT NULL,
  delivered_at timestamptz,
  attempts     integer     NOT NULL DEFAULT 0,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_webhook_event_valid CHECK (event IN ('payment.succeeded', 'payment.failed')),
  CONSTRAINT provider_webhook_attempts_nonneg CHECK (attempts >= 0)
);
CREATE INDEX provider_webhook_due_idx ON provider.webhook_events (deliver_at) WHERE delivered_at IS NULL;
CREATE INDEX provider_webhook_payment_idx ON provider.webhook_events (payment_id);

-- A photo is private until its lot is published. `published_at` records that the processed
-- copies exist in the public bucket (and is cleared when they are taken down again).
ALTER TABLE lot_photos ADD COLUMN published_at timestamptz;
CREATE INDEX lot_photos_unpublished_idx ON lot_photos (lot_id) WHERE status = 'ready' AND published_at IS NULL;
CREATE INDEX lot_photos_published_idx ON lot_photos (lot_id) WHERE published_at IS NOT NULL;
