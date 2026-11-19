import { appError } from '@auction/shared';
import { notify, queueEmail, requireTrader } from './support.js';
import { withTx } from './tx.js';
import type { Deps, Notification, Outcome } from './types.js';
import { NO_EFFECTS } from './types.js';

/** Adds a lot to the user's favourites (idempotent). Only public, running lots can be favourited. */
export const addFavorite = (deps: Deps, input: { userId: string; lotId: string }) =>
  withTx(deps.pool, async (tx): Promise<{ favorited: true }> => {
    await requireTrader(tx, input.userId);
    const lot = await tx.query<{ status: string }>('SELECT status FROM lots WHERE id = $1', [
      input.lotId,
    ]);
    const status = lot.rows[0]?.status;
    if (!status || ['draft', 'in_review', 'rejected', 'removed'].includes(status)) {
      throw appError('NOT_FOUND', 'lot not found');
    }
    await tx.query(
      `INSERT INTO favorites (user_id, lot_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [input.userId, input.lotId, deps.clock.now()],
    );
    return { favorited: true };
  });

export const removeFavorite = async (
  deps: Deps,
  input: { userId: string; lotId: string },
): Promise<void> => {
  await deps.pool.query('DELETE FROM favorites WHERE user_id = $1 AND lot_id = $2', [
    input.userId,
    input.lotId,
  ]);
};

export type ReminderReport = { readonly reminded: number };

/**
 * "An hour before the end" reminder for favourites, exactly once per user and lot.
 * `reminded_at` is claimed with a conditional UPDATE, so any number of workers running this at the
 * same moment send one email in total; the email's dedupe key is a second lock. If the lot is
 * extended afterwards the reminder is NOT repeated (it already happened once).
 */
export const sendFavoriteReminders = (deps: Deps): Promise<Outcome<ReminderReport>> =>
  withTx(deps.pool, async (tx): Promise<Outcome<ReminderReport>> => {
    const now = deps.clock.now();
    const horizon = new Date(now.getTime() + deps.timings.favoriteReminderMs);
    const { rows } = await tx.query<{
      user_id: string;
      lot_id: string;
      title: string;
      ends_at: Date;
    }>(
      `UPDATE favorites f SET reminded_at = $1
         FROM lots l
        WHERE l.id = f.lot_id AND f.reminded_at IS NULL
          AND l.status = 'active' AND l.ends_at > $1 AND l.ends_at <= $2
       RETURNING f.user_id, f.lot_id, l.title, l.ends_at`,
      [now, horizon],
    );
    const notifications: Notification[] = [];
    for (const r of rows) {
      const payload = { lotId: r.lot_id, title: r.title, endsAt: r.ends_at.toISOString() };
      await queueEmail(
        tx,
        {
          userId: r.user_id,
          kind: 'favorite_reminder',
          dedupeKey: `fav:${r.user_id}:${r.lot_id}`,
          payload,
        },
        now,
      );
      notifications.push(
        await notify(tx, { userId: r.user_id, kind: 'favorite_ending', payload }, now),
      );
    }
    return {
      result: { reminded: rows.length },
      effects: rows.length === 0 ? NO_EFFECTS : { events: [], notifications },
    };
  });
