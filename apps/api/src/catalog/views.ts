import { appError, bidStep, isPublicStatus, maskName, type LotStatus } from '@auction/shared';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Ctx } from '../core/context.js';

type PhotoRow = {
  id: string;
  position: number;
  key: string;
  preview_key: string | null;
  status: string;
  published_at: Date | null;
};

/** The lot as the public sees it. The reserve amount appears ONLY for the seller; everyone else gets "met / not met". */
export const lotView = async (ctx: Ctx, lotId: string, viewerId: string | null) => {
  if (!/^[0-9a-f-]{36}$/i.test(lotId)) throw appError('NOT_FOUND', 'lot not found');
  const { rows } = await ctx.pool.query<
    Record<string, unknown> & {
      id: string;
      seller_id: string;
      status: LotStatus;
      reserve_price: number | null;
      current_price: number;
      bid_count: number;
      leader_id: string | null;
      leader_max: number | null;
      buyer_id: string | null;
      final_price: number | null;
      payment_due_at: Date | null;
      ends_at: Date | null;
      starts_at: Date | null;
      buy_now_price: number | null;
      event_seq: number;
      title: string;
      description: string;
      category_id: number;
      city_id: number;
      condition: string;
      start_price: number;
      seller_name: string;
      shipped_at: Date | null;
      tracking_number: string | null;
      paid_at: Date | null;
      reject_reason: string | null;
    }
  >(
    `SELECT l.*, u.display_name AS seller_name FROM lots l JOIN users u ON u.id = l.seller_id WHERE l.id = $1`,
    [lotId],
  );
  const l = rows[0];
  const isSeller = viewerId !== null && l?.seller_id === viewerId;
  if (!l || (!isPublicStatus(l.status) && !isSeller)) throw appError('NOT_FOUND', 'lot not found');

  const photos = (
    await ctx.pool.query<PhotoRow>(
      `SELECT id, position, key, preview_key, status, published_at FROM lot_photos WHERE lot_id = $1 ORDER BY position`,
      [lotId],
    )
  ).rows;
  const base = ctx.config.publicPhotoUrl;
  const isBuyer = viewerId !== null && l.buyer_id === viewerId;
  const live = l.status === 'active';
  return {
    id: l.id,
    title: l.title,
    description: l.description,
    categoryId: l.category_id,
    cityId: l.city_id,
    condition: l.condition,
    status: l.status,
    startPrice: l.start_price,
    currentPrice: l.current_price,
    bidCount: l.bid_count,
    minNextBid: l.bid_count === 0 ? l.start_price : l.current_price + bidStep(l.current_price),
    buyNowPrice: l.bid_count === 0 && live ? l.buy_now_price : null,
    startsAt: l.starts_at?.toISOString() ?? null,
    endsAt: l.ends_at?.toISOString() ?? null,
    reserveMet:
      l.reserve_price === null ? null : l.bid_count > 0 && l.current_price >= l.reserve_price,
    seller: { displayName: maskName(l.seller_name) },
    eventSeq: l.event_seq,
    serverNow: ctx.clock.now().getTime(),
    // Only ready AND published photos have a public URL; the seller also sees pending ones (without URLs).
    photos: photos
      .filter((p) => (p.published_at !== null && p.status === 'ready') || isSeller)
      .map((p) => ({
        id: p.id,
        position: p.position,
        status: p.status,
        url: p.published_at && p.status === 'ready' ? `${base}/${p.key}` : null,
        previewUrl: p.published_at && p.preview_key ? `${base}/${p.preview_key}` : null,
      })),
    viewer: {
      isSeller,
      isBuyer,
      isLeading: viewerId !== null && l.leader_id === viewerId,
      yourMax: viewerId !== null && l.leader_id === viewerId ? l.leader_max : null,
      mustPayBy:
        isBuyer && l.status === 'awaiting_payment'
          ? (l.payment_due_at?.toISOString() ?? null)
          : null,
      priceToPay: isBuyer && l.status === 'awaiting_payment' ? l.final_price : null,
      // Seller-only
      reservePrice: isSeller ? l.reserve_price : null,
      rejectReason: isSeller ? l.reject_reason : null,
      trackingNumber: isSeller || isBuyer ? l.tracking_number : null,
      // The seller learns who won only after payment.
      winner:
        isSeller && l.buyer_id !== null && ['paid', 'shipped', 'completed'].includes(l.status)
          ? {
              displayName:
                (
                  await ctx.pool.query<{ display_name: string }>(
                    'SELECT display_name FROM users WHERE id = $1',
                    [l.buyer_id],
                  )
                ).rows[0]?.display_name ?? '',
            }
          : null,
    },
  };
};

/** Public bid history: names masked (`о***7`), the viewer's own bids marked. Annulled bids are hidden. */
export const bidHistory = async (ctx: Ctx, lotId: string, viewerId: string | null, limit = 100) => {
  const lot = await ctx.pool.query<{ status: LotStatus; seller_id: string }>(
    'SELECT status, seller_id FROM lots WHERE id = $1',
    [lotId],
  );
  const l = lot.rows[0];
  if (!l || (!isPublicStatus(l.status) && l.seller_id !== viewerId))
    throw appError('NOT_FOUND', 'lot not found');
  const { rows } = await ctx.pool.query<{
    id: number;
    amount: number;
    is_auto: boolean;
    created_at: Date;
    user_id: string;
    display_name: string;
  }>(
    `SELECT b.id, b.amount, b.is_auto, b.created_at, b.user_id, u.display_name
       FROM bids b JOIN users u ON u.id = b.user_id WHERE b.lot_id = $1 AND b.annulled_at IS NULL ORDER BY b.id DESC LIMIT $2`,
    [lotId, limit],
  );
  return {
    serverNow: ctx.clock.now().getTime(),
    items: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      isAuto: r.is_auto,
      at: r.created_at.toISOString(),
      bidder: maskName(r.display_name),
      you: r.user_id === viewerId,
    })),
  };
};

/** Catch-up for a client that missed pushes: all events after `after`, in order. */
export const lotEventsAfter = async (ctx: Ctx, lotId: string, after: number) => {
  const lot = await ctx.pool.query<{ status: LotStatus; event_seq: number }>(
    'SELECT status, event_seq FROM lots WHERE id = $1',
    [lotId],
  );
  const l = lot.rows[0];
  if (!l || !isPublicStatus(l.status)) throw appError('NOT_FOUND', 'lot not found');
  const { rows } = await ctx.pool.query<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }>(
    `SELECT seq, type, payload FROM lot_events WHERE lot_id = $1 AND seq > $2 ORDER BY seq LIMIT 500`,
    [lotId, after],
  );
  return { serverNow: ctx.clock.now().getTime(), latestSeq: l.event_seq, events: rows };
};

export const signedPhotoUrl = (ctx: Ctx, key: string): Promise<string> =>
  getSignedUrl(ctx.s3, new GetObjectCommand({ Bucket: ctx.config.s3.privateBucket, Key: key }), {
    expiresIn: 300,
  });
