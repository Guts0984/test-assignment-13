import type { Pool } from '@auction/db';
import type pg from 'pg';
import { planDeliveries, type Outcome } from './chaos.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from './signature.js';

/**
 * The payment stub as a company of its own: it has payments, decides them when a person clicks
 * a button, and sends webhooks. It only ever touches the `provider` schema.
 */

export type PaymentStatus = 'pending' | 'succeeded' | 'failed';

export type ProviderPayment = {
  readonly id: string;
  readonly amount: number;
  readonly reference: string;
  readonly status: PaymentStatus;
  readonly notifyUrl: string | null;
  readonly createdAt: Date;
};

type PaymentRow = {
  id: string;
  amount: number;
  reference: string;
  status: PaymentStatus;
  notify_url: string | null;
  created_at: Date;
};

const toPayment = (r: PaymentRow): ProviderPayment => ({
  id: r.id,
  amount: r.amount,
  reference: r.reference,
  status: r.status,
  notifyUrl: r.notify_url,
  createdAt: r.created_at,
});

/** The merchant asks for a payment page. The same reference returns the same payment (idempotent). */
export const createPayment = async (
  pool: Pool,
  input: { amount: number; reference: string; notifyUrl: string; now: Date },
): Promise<ProviderPayment> => {
  const { rows } = await pool.query<PaymentRow>(
    `INSERT INTO provider.payments (amount, reference, notify_url, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (reference) DO UPDATE SET reference = EXCLUDED.reference
     RETURNING id, amount, reference, status, notify_url, created_at`,
    [input.amount, input.reference, input.notifyUrl, input.now],
  );
  const row = rows[0];
  if (!row) throw new Error('payment was not created');
  if (row.amount !== input.amount) throw new Error('reference already used for a different amount');
  return toPayment(row);
};

export const getPayment = async (pool: Pool, id: string): Promise<ProviderPayment | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await pool.query<PaymentRow>(
    `SELECT id, amount, reference, status, notify_url, created_at FROM provider.payments WHERE id = $1`,
    [id],
  );
  return rows[0] ? toPayment(rows[0]) : null;
};

export type DecideResult = {
  /** True if this call is the one that settled the payment. */
  readonly applied: boolean;
  readonly status: PaymentStatus;
  readonly webhooksPlanned: number;
};

/**
 * The person clicked "Success" or "Failure". The first click settles the payment and schedules
 * its webhooks (honestly, or chaotically); later clicks change nothing. "Close without answer"
 * is simply not calling this: the payment stays pending and no webhook is ever sent.
 */
export const decidePayment = async (
  pool: Pool,
  input: { paymentId: string; outcome: Outcome; chaos: boolean; now: Date; random?: () => number },
): Promise<DecideResult> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const won = await client.query<{ id: string }>(
      `UPDATE provider.payments SET status = $2, updated_at = $3 WHERE id = $1 AND status = 'pending' RETURNING id`,
      [input.paymentId, input.outcome, input.now],
    );
    if (won.rowCount === 0) {
      const cur = await client.query<{ status: PaymentStatus }>(
        `SELECT status FROM provider.payments WHERE id = $1`,
        [input.paymentId],
      );
      await client.query('ROLLBACK');
      const status = cur.rows[0]?.status;
      if (!status) throw new Error('payment not found');
      return { applied: false, status, webhooksPlanned: 0 };
    }
    const plan = planDeliveries(input.outcome, {
      chaos: input.chaos,
      now: input.now,
      random: input.random ?? Math.random,
    });
    for (const d of plan) {
      await client.query(
        `INSERT INTO provider.webhook_events (payment_id, event, deliver_at, created_at) VALUES ($1, $2, $3, $4)`,
        [input.paymentId, d.event, d.deliverAt, input.now],
      );
    }
    await client.query('COMMIT');
    return { applied: true, status: input.outcome, webhooksPlanned: plan.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};

export type DeliveryReport = { readonly sent: number; readonly failed: number };

export type Fetcher = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

const MAX_ATTEMPTS = 8;

/**
 * Delivers every webhook that is due. Safe with any number of senders at once: each batch is
 * claimed with FOR UPDATE SKIP LOCKED, so two senders never send the same row. A failed delivery is
 * retried with exponential back-off, up to 8 times, then given up (the merchant's reconciler is the
 * safety net, exactly as with a real provider).
 */
export const deliverDueWebhooks = async (
  pool: Pool,
  options: { secret: string; fetcher: Fetcher; now: () => Date; batch?: number },
): Promise<DeliveryReport> => {
  const client: pg.PoolClient = await pool.connect();
  let sent = 0;
  let failed = 0;
  try {
    await client.query('BEGIN');
    const due = await client.query<{
      id: number;
      payment_id: string;
      event: string;
      attempts: number;
      notify_url: string | null;
      reference: string;
      amount: number;
    }>(
      `SELECT e.id, e.payment_id, e.event, e.attempts, p.notify_url, p.reference, p.amount
         FROM provider.webhook_events e JOIN provider.payments p ON p.id = e.payment_id
        WHERE e.delivered_at IS NULL AND e.deliver_at <= $1 AND e.attempts < $2
        ORDER BY e.deliver_at, e.id
        LIMIT $3
          FOR UPDATE OF e SKIP LOCKED`,
      [options.now(), MAX_ATTEMPTS, options.batch ?? 50],
    );
    for (const row of due.rows) {
      const timestamp = options.now().getTime();
      // The body states what THIS event says, not what the payment is now: a stale or
      // contradicting event is exactly the problem the receiver has to cope with.
      const body = JSON.stringify({
        id: `evt_${row.id}`,
        type: row.event,
        data: {
          paymentId: row.payment_id,
          reference: row.reference,
          amount: row.amount,
          status: row.event === 'payment.succeeded' ? 'succeeded' : 'failed',
        },
      });
      let error: string | null = null;
      try {
        if (!row.notify_url) throw new Error('no notify url');
        const res = await options.fetcher(row.notify_url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TIMESTAMP_HEADER]: String(timestamp),
            [SIGNATURE_HEADER]: signWebhook(options.secret, timestamp, body),
          },
          body,
        });
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (error === null) {
        await client.query(
          `UPDATE provider.webhook_events SET delivered_at = $2, attempts = attempts + 1 WHERE id = $1`,
          [row.id, options.now()],
        );
        sent++;
      } else {
        const backoffMs = Math.min(2 ** row.attempts * 1000, 60_000);
        await client.query(
          `UPDATE provider.webhook_events SET attempts = attempts + 1, last_error = $2, deliver_at = $3 WHERE id = $1`,
          [row.id, error.slice(0, 300), new Date(options.now().getTime() + backoffMs)],
        );
        failed++;
      }
    }
    await client.query('COMMIT');
    return { sent, failed };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
};
