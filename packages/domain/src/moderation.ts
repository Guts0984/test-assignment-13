import {
  appError,
  lotRejectInputSchema,
  lotRemoveInputSchema,
  zodIssuesToDetails,
} from '@auction/shared';
import { releaseHeldDeposits } from './close.js';
import {
  appendEvent,
  audit,
  getUser,
  lockLot,
  notify,
  publicState,
  queueEmail,
  queueLotSync,
  type LotRow,
} from './support.js';
import { withTx } from './tx.js';
import type { Deps, Notification, Outcome, Tx } from './types.js';

const requireModerator = async (tx: Tx, userId: string): Promise<void> => {
  const user = await getUser(tx, userId);
  if (user?.role !== 'moderator') throw appError('FORBIDDEN', 'moderators only');
};

/** Gives expired claims back to the queue. Returns how many lots were released. */
export const releaseExpiredClaims = async (tx: Tx, now: Date): Promise<number> => {
  const r = await tx.query(
    `UPDATE lots SET claimed_by = NULL, claim_expires_at = NULL, updated_at = $1
      WHERE status = 'in_review' AND claimed_by IS NOT NULL AND claim_expires_at <= $1`,
    [now],
  );
  return r.rowCount ?? 0;
};

export const sweepExpiredClaims = (deps: Deps): Promise<number> =>
  withTx(deps.pool, (tx) => releaseExpiredClaims(tx, deps.clock.now()));

/**
 * Takes the oldest lot nobody is reviewing. `FOR UPDATE SKIP LOCKED` makes concurrent moderators
 * skip each other's rows instead of waiting, so two moderators never get the same lot. A
 * moderator who already holds a live claim gets that lot back (no hoarding a second one).
 * A claim not decided within 15 minutes goes back to the queue.
 */
export const claimNextLot = (deps: Deps, moderatorId: string) =>
  withTx(deps.pool, async (tx): Promise<{ lotId: string; expiresAt: string } | null> => {
    const now = deps.clock.now();
    await requireModerator(tx, moderatorId);
    await releaseExpiredClaims(tx, now);

    const mine = await tx.query<{ id: string; claim_expires_at: Date }>(
      `SELECT id, claim_expires_at FROM lots WHERE status = 'in_review' AND claimed_by = $1 LIMIT 1`,
      [moderatorId],
    );
    const existing = mine.rows[0];
    if (existing) return { lotId: existing.id, expiresAt: existing.claim_expires_at.toISOString() };

    const expires = new Date(now.getTime() + deps.timings.reviewClaimMs);
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE lots SET claimed_by = $1, claim_expires_at = $2, updated_at = $3
        WHERE id = (
          SELECT id FROM lots WHERE status = 'in_review' AND claimed_by IS NULL
           ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id`,
      [moderatorId, expires, now],
    );
    const id = rows[0]?.id;
    if (!id) return null;
    await audit(tx, id, moderatorId, 'review_claimed', now);
    return { lotId: id, expiresAt: expires.toISOString() };
  });

const requireLiveClaim = (lot: LotRow, moderatorId: string, now: Date): void => {
  if (lot.status !== 'in_review') throw appError('LOT_STATUS_CONFLICT', 'the lot is not in review');
  if (
    lot.claimed_by !== moderatorId ||
    !lot.claim_expires_at ||
    lot.claim_expires_at.getTime() <= now.getTime()
  ) {
    throw appError(
      'REVIEW_CLAIM_LOST',
      'you no longer hold this lot (the claim expired or went to someone else)',
    );
  }
};

export const approveLot = (deps: Deps, input: { lotId: string; moderatorId: string }) =>
  withTx(deps.pool, async (tx): Promise<{ endsAt: string }> => {
    const now = deps.clock.now();
    await requireModerator(tx, input.moderatorId);
    const lot = await lockLot(tx, input.lotId);
    requireLiveClaim(lot, input.moderatorId, now);
    const endsAt = new Date(now.getTime() + lot.duration_days * 86_400_000);
    await tx.query(
      `UPDATE lots SET status = 'active', starts_at = $2, ends_at = $3, claimed_by = NULL, claim_expires_at = NULL,
              version = version + 1, updated_at = $2 WHERE id = $1`,
      [lot.id, now, endsAt],
    );
    await audit(tx, lot.id, input.moderatorId, 'approved', now);
    await notify(
      tx,
      { userId: lot.seller_id, kind: 'lot_approved', payload: { lotId: lot.id, title: lot.title } },
      now,
    );
    await queueEmail(
      tx,
      {
        userId: lot.seller_id,
        kind: 'lot_approved',
        dedupeKey: `approved:${lot.id}`,
        payload: { lotId: lot.id, title: lot.title },
      },
      now,
    );
    await queueLotSync(tx, lot.id, now);
    return { endsAt: endsAt.toISOString() };
  });

export const rejectLot = (
  deps: Deps,
  input: { lotId: string; moderatorId: string; reason: string },
) =>
  withTx(deps.pool, async (tx): Promise<{ status: 'rejected' }> => {
    const parsed = lotRejectInputSchema.safeParse({ reason: input.reason });
    if (!parsed.success) {
      throw appError('VALIDATION_FAILED', 'invalid input', {
        details: zodIssuesToDetails(parsed.error.issues),
      });
    }
    const now = deps.clock.now();
    await requireModerator(tx, input.moderatorId);
    const lot = await lockLot(tx, input.lotId);
    requireLiveClaim(lot, input.moderatorId, now);
    await tx.query(
      `UPDATE lots SET status = 'rejected', reject_reason = $2, claimed_by = NULL, claim_expires_at = NULL,
              version = version + 1, updated_at = $3 WHERE id = $1`,
      [lot.id, parsed.data.reason, now],
    );
    await audit(tx, lot.id, input.moderatorId, 'rejected', now, { reason: parsed.data.reason });
    await notify(
      tx,
      {
        userId: lot.seller_id,
        kind: 'lot_rejected',
        payload: { lotId: lot.id, title: lot.title, reason: parsed.data.reason },
      },
      now,
    );
    await queueEmail(
      tx,
      {
        userId: lot.seller_id,
        kind: 'lot_rejected',
        dedupeKey: `rejected:${lot.id}:${lot.version}`,
        payload: { lotId: lot.id, title: lot.title, reason: parsed.data.reason },
      },
      now,
    );
    return { status: 'rejected' };
  });

/**
 * A moderator takes a published lot down: bids are annulled, every deposit is released (money
 * back to available), and everyone who took part gets an email. A moderator touches the lot,
 * never the money directly: the releases are the same ledger moves a closed auction makes.
 */
export const removeLot = (
  deps: Deps,
  input: { lotId: string; moderatorId: string; reason: string },
) =>
  withTx(deps.pool, async (tx): Promise<Outcome<{ released: number }>> => {
    const parsed = lotRemoveInputSchema.safeParse({ reason: input.reason });
    if (!parsed.success) {
      throw appError('VALIDATION_FAILED', 'invalid input', {
        details: zodIssuesToDetails(parsed.error.issues),
      });
    }
    const now = deps.clock.now();
    await requireModerator(tx, input.moderatorId);
    const lot = await lockLot(tx, input.lotId);
    if (lot.status !== 'active')
      throw appError('LOT_STATUS_CONFLICT', 'only a published, running lot can be removed');

    const participants = (
      await tx.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM bids WHERE lot_id = $1`, [
        lot.id,
      ])
    ).rows.map((r) => r.user_id);
    const released = await releaseHeldDeposits(tx, lot.id, now, 'removed');
    await tx.query(`UPDATE bids SET annulled_at = $2 WHERE lot_id = $1 AND annulled_at IS NULL`, [
      lot.id,
      now,
    ]);
    await tx.query(
      `UPDATE lots SET status = 'removed', removed_reason = $2, event_seq = event_seq + 1,
              version = version + 1, updated_at = $3 WHERE id = $1`,
      [lot.id, parsed.data.reason, now],
    );
    const event = await appendEvent(
      tx,
      lot,
      1,
      'closed',
      { status: 'removed', ...publicState(lot) },
      now,
    );
    await audit(tx, lot.id, input.moderatorId, 'removed', now, { reason: parsed.data.reason });

    const notifications: Notification[] = [];
    for (const userId of new Set([lot.seller_id, ...participants])) {
      notifications.push(
        await notify(
          tx,
          { userId, kind: 'lot_removed', payload: { lotId: lot.id, title: lot.title } },
          now,
        ),
      );
      await queueEmail(
        tx,
        {
          userId,
          kind: 'lot_removed',
          dedupeKey: `removed:${lot.id}:${userId}`,
          payload: { lotId: lot.id, title: lot.title },
        },
        now,
      );
    }
    await queueLotSync(tx, lot.id, now);
    return { result: { released: released.length }, effects: { events: [event], notifications } };
  });
