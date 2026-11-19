import {
  appError,
  lotAppendDescriptionInputSchema,
  lotCreateInputSchema,
  lotEditPolicy,
  lotUpdateInputSchema,
  zodIssuesToDetails,
  type LotCreateInput,
} from '@auction/shared';
import type { z } from 'zod';
import { appendEvent, audit, lockLot, queueLotSync, requireTrader } from './support.js';
import { withTx } from './tx.js';
import type { Deps, Outcome } from './types.js';
import { NO_EFFECTS } from './types.js';

const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw appError('VALIDATION_FAILED', 'invalid input', {
      details: zodIssuesToDetails(r.error.issues),
    });
  }
  return r.data;
};

/** Creates a draft. Input is validated here too, so no caller can bypass the rules. */
export const createLot = (deps: Deps, sellerId: string, rawInput: unknown) =>
  withTx(deps.pool, async (tx): Promise<{ lotId: string }> => {
    const input: LotCreateInput = parse(lotCreateInputSchema, rawInput);
    const now = deps.clock.now();
    await requireTrader(tx, sellerId);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO lots (seller_id, title, description, category_id, city_id, condition, start_price,
                         reserve_price, buy_now_price, duration_days, current_price, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $7, $11, $11) RETURNING id`,
      [
        sellerId,
        input.title,
        input.description,
        input.categoryId,
        input.cityId,
        input.condition,
        input.startPrice,
        input.reservePrice,
        input.buyNowPrice,
        input.durationDays,
        now,
      ],
    );
    const lotId = rows[0]?.id;
    if (!lotId) throw appError('INTERNAL', 'lot was not created');
    await audit(tx, lotId, sellerId, 'created', now);
    return { lotId };
  });

/**
 * Full edit: a draft, a rejected lot (which goes back to draft), or a live lot with NO bids.
 * After the first bid only `appendDescription` is possible.
 */
export const updateLot = (deps: Deps, input: { lotId: string; sellerId: string; patch: unknown }) =>
  withTx(deps.pool, async (tx): Promise<Outcome<{ status: string }>> => {
    const patch = parse(lotUpdateInputSchema, input.patch);
    const now = deps.clock.now();
    const lot = await lockLot(tx, input.lotId);
    if (lot.seller_id !== input.sellerId) throw appError('NOT_FOUND', 'lot not found');
    if (lotEditPolicy(lot.status, lot.bid_count) !== 'full') {
      throw appError('LOT_NOT_EDITABLE', 'this lot can no longer be changed');
    }
    const live = lot.status === 'active';
    let endsAt = lot.ends_at;
    if (live && lot.starts_at) {
      endsAt = new Date(lot.starts_at.getTime() + patch.durationDays * 86_400_000);
      if (endsAt.getTime() <= now.getTime()) {
        throw appError('LOT_NOT_EDITABLE', 'the new duration would end the lot in the past');
      }
    }
    const status = lot.status === 'rejected' ? 'draft' : lot.status;
    await tx.query(
      `UPDATE lots SET title = $2, description = $3, category_id = $4, city_id = $5, condition = $6,
              start_price = $7, current_price = $7, reserve_price = $8, buy_now_price = $9, duration_days = $10,
              ends_at = $11, status = $12, reject_reason = NULL, version = version + 1, updated_at = $13
        WHERE id = $1`,
      [
        lot.id,
        patch.title,
        patch.description,
        patch.categoryId,
        patch.cityId,
        patch.condition,
        patch.startPrice,
        patch.reservePrice,
        patch.buyNowPrice,
        patch.durationDays,
        endsAt,
        status,
        now,
      ],
    );
    await audit(tx, lot.id, input.sellerId, 'edited', now);
    if (live) await queueLotSync(tx, lot.id, now);
    return { result: { status }, effects: NO_EFFECTS };
  });

/** The only edit allowed once bidding has started. */
export const appendDescription = (
  deps: Deps,
  input: { lotId: string; sellerId: string; text: string },
) =>
  withTx(deps.pool, async (tx): Promise<Outcome<{ description: string }>> => {
    const { text } = parse(lotAppendDescriptionInputSchema, { text: input.text });
    const now = deps.clock.now();
    const lot = await lockLot(tx, input.lotId);
    if (lot.seller_id !== input.sellerId) throw appError('NOT_FOUND', 'lot not found');
    if (lotEditPolicy(lot.status, lot.bid_count) === 'none') {
      throw appError('LOT_NOT_EDITABLE', 'this lot can no longer be changed');
    }
    const description = lot.description === '' ? text : `${lot.description}\n${text}`;
    if (description.length > 7000) {
      throw appError('VALIDATION_FAILED', 'description is too long', {
        details: [
          { path: 'text', code: 'too_big', message: 'description would exceed 7000 characters' },
        ],
      });
    }
    await tx.query(
      `UPDATE lots SET description = $2, version = version + 1, updated_at = $3 WHERE id = $1`,
      [lot.id, description, now],
    );
    await audit(tx, lot.id, input.sellerId, 'description_appended', now, { added: text.length });
    let events: Outcome<unknown>['effects']['events'] = [];
    if (lot.status === 'active') {
      events = [await appendEvent(tx, lot, 1, 'description', { description }, now)];
      await tx.query('UPDATE lots SET event_seq = event_seq + 1 WHERE id = $1', [lot.id]);
      await queueLotSync(tx, lot.id, now);
    }
    return { result: { description }, effects: { events, notifications: [] } };
  });

/** draft → in_review. */
export const submitLot = (deps: Deps, input: { lotId: string; sellerId: string }) =>
  withTx(deps.pool, async (tx): Promise<{ status: 'in_review' }> => {
    const now = deps.clock.now();
    const lot = await lockLot(tx, input.lotId);
    if (lot.seller_id !== input.sellerId) throw appError('NOT_FOUND', 'lot not found');
    if (lot.status !== 'draft')
      throw appError('LOT_STATUS_CONFLICT', 'only a draft can be submitted for review');
    await tx.query(
      `UPDATE lots SET status = 'in_review', updated_at = $2, version = version + 1 WHERE id = $1`,
      [lot.id, now],
    );
    await audit(tx, lot.id, input.sellerId, 'submitted', now);
    return { status: 'in_review' };
  });
