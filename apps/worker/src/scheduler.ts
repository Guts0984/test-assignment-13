import { jobId, scheduleAt, type Queues } from '@auction/platform';
import type { Deps } from '@auction/domain';

/**
 * The scheduler turns "what Postgres says is due soon" into BullMQ jobs. It is stateless and runs
 * in every worker copy: identical job ids make the extra adds no-ops. If Redis loses everything,
 * the next tick queues the same jobs again. Handlers re-check everything under row locks and by the
 * server clock, so a job that runs early, late, twice or for an old deadline is harmless.
 */

/** Anything due within this window is queued with a precise delay; the rest waits for a later tick. */
export const HORIZON_MS = 30_000;

export type SchedulerReport = {
  readonly close: number;
  readonly payment: number;
  readonly autoConfirm: number;
  readonly email: number;
  readonly photo: number;
};

export const scheduleDueWork = async (deps: Deps, queues: Queues): Promise<SchedulerReport> => {
  const now = deps.clock.now().getTime();
  const horizon = new Date(now + HORIZON_MS);
  const q = <T extends object>(sql: string, params: unknown[]) =>
    deps.pool.query<T>(sql, params).then((r) => r.rows);

  const closing = await q<{ id: string; ends_at: Date }>(
    `SELECT id, ends_at FROM lots WHERE status = 'active' AND ends_at <= $1 ORDER BY ends_at LIMIT 500`,
    [horizon],
  );
  for (const l of closing) {
    await scheduleAt(
      queues.lotClose,
      jobId.close(l.id, l.ends_at.getTime()),
      { lotId: l.id },
      l.ends_at.getTime(),
      now,
    );
  }

  const payments = await q<{ id: string; payment_due_at: Date }>(
    `SELECT id, payment_due_at FROM lots WHERE status = 'awaiting_payment' AND payment_due_at <= $1 ORDER BY payment_due_at LIMIT 500`,
    [horizon],
  );
  for (const l of payments) {
    await scheduleAt(
      queues.paymentDeadline,
      jobId.payment(l.id, l.payment_due_at.getTime()),
      { lotId: l.id },
      l.payment_due_at.getTime(),
      now,
    );
  }

  const confirmBefore = new Date(now + HORIZON_MS - deps.timings.autoConfirmMs);
  const shipped = await q<{ id: string; shipped_at: Date }>(
    `SELECT id, shipped_at FROM lots WHERE status = 'shipped' AND shipped_at <= $1 ORDER BY shipped_at LIMIT 500`,
    [confirmBefore],
  );
  for (const l of shipped) {
    const runAt = l.shipped_at.getTime() + deps.timings.autoConfirmMs;
    await scheduleAt(
      queues.autoConfirm,
      jobId.autoConfirm(l.id, l.shipped_at.getTime()),
      { lotId: l.id },
      runAt,
      now,
    );
  }

  const emails = await q<{ id: string }>(
    `SELECT id FROM email_log WHERE status = 'pending' ORDER BY created_at LIMIT 200`,
    [],
  );
  for (const e of emails)
    await scheduleAt(queues.email, jobId.email(e.id), { emailId: e.id }, now, now);

  // Photos whose upload had a moment to arrive.
  const photos = await q<{ id: string }>(
    `SELECT id FROM lot_photos WHERE status = 'pending' AND created_at <= $1 ORDER BY created_at LIMIT 100`,
    [new Date(now - 2000)],
  );
  for (const p of photos)
    await scheduleAt(queues.photo, jobId.photo(p.id), { photoId: p.id }, now, now);

  return {
    close: closing.length,
    payment: payments.length,
    autoConfirm: shipped.length,
    email: emails.length,
    photo: photos.length,
  };
};
