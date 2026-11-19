import { Body, Controller, Get, HttpCode, Inject, Post, Req as ReqDec } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createTopup, attachProviderPayment, walletSummary } from '@auction/domain';

import { createPayment } from '@auction/payment-stub';

import { topUpInputSchema } from '@auction/shared';

import { CTX, type Ctx } from '../core/context.js';
import { Limit, Roles, idemKey, parse, type Req } from '../common/http.js';

import { uid } from '../common/helpers.js';

@ApiTags('me')
@Controller('me')
export class MeController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Get('wallet')
  @Roles('user')
  wallet(@ReqDec() req: Req) {
    return walletSummary(this.ctx.pool, uid(req));
  }

  @Post('topups')
  @Roles('user')
  @HttpCode(201)
  @Limit({ bucket: 'topup', limit: (c) => c.config.rate.topup, windowMs: 60_000, by: 'user' })
  async topup(@Body() body: unknown, @ReqDec() req: Req) {
    const { amount } = parse(topUpInputSchema, body);
    const r = await createTopup(this.ctx.deps, {
      userId: uid(req),
      amount,
      idempotencyKey: idemKey(req),
    });
    const t = r.result;
    const payment = await createPayment(this.ctx.pool, {
      amount,
      reference: t.topupId,
      notifyUrl: `${this.ctx.config.providerBaseUrl}/webhooks/payments`,
      now: this.ctx.clock.now(),
    });
    await attachProviderPayment(this.ctx.pool, t.topupId, payment.id);
    return {
      topupId: t.topupId,
      amount,
      status: t.status,
      payUrl: `${this.ctx.config.publicUrl}/provider/pay/${payment.id}`,
    };
  }

  @Get('bids')
  @Roles('user')
  async bids(@ReqDec() req: Req) {
    return (
      await this.ctx.pool.query<Record<string, unknown>>(
        `SELECT b.id, b.lot_id AS "lotId", l.title, b.amount, b.is_auto AS "isAuto", b.created_at AS "at", l.status,
              (l.leader_id = b.user_id AND l.status = 'active') AS "leading"
         FROM bids b JOIN lots l ON l.id = b.lot_id WHERE b.user_id = $1 AND b.annulled_at IS NULL ORDER BY b.id DESC LIMIT 100`,
        [uid(req)],
      )
    ).rows;
  }

  @Get('lots')
  @Roles('user')
  async lots(@ReqDec() req: Req) {
    const rows = (
      await this.ctx.pool.query<Record<string, unknown>>(
        `SELECT id, title, status, current_price AS "currentPrice", bid_count AS "bidCount", ends_at AS "endsAt", final_price AS "finalPrice", reserve_price AS "reservePrice"
         FROM lots WHERE seller_id = $1 ORDER BY created_at DESC LIMIT 200`,
        [uid(req)],
      )
    ).rows as { status: string; finalPrice: number | null }[];
    const pending =
      (
        await this.ctx.pool.query<{ s: number }>(
          `SELECT COALESCE(SUM(final_price - LEAST(GREATEST((final_price * 5) / 100, 1000), final_price)), 0)::bigint AS s FROM lots WHERE seller_id = $1 AND status IN ('paid', 'shipped')`,
          [uid(req)],
        )
      ).rows[0]?.s ?? 0;
    return { items: rows, pendingPayout: pending };
  }

  @Get('wins')
  @Roles('user')
  async wins(@ReqDec() req: Req) {
    return (
      await this.ctx.pool.query<Record<string, unknown>>(
        `SELECT id, title, status, final_price AS "price", payment_due_at AS "payBy" FROM lots WHERE buyer_id = $1 ORDER BY updated_at DESC LIMIT 100`,
        [uid(req)],
      )
    ).rows;
  }

  @Get('favorites')
  @Roles('user')
  async favorites(@ReqDec() req: Req) {
    return (
      await this.ctx.pool.query<Record<string, unknown>>(
        `SELECT l.id, l.title, l.status, l.current_price AS "currentPrice", l.ends_at AS "endsAt" FROM favorites f JOIN lots l ON l.id = f.lot_id WHERE f.user_id = $1 ORDER BY f.created_at DESC`,
        [uid(req)],
      )
    ).rows;
  }

  @Get('notifications')
  @Roles('user', 'moderator', 'finance')
  async notifications(@ReqDec() req: Req) {
    return (
      await this.ctx.pool.query<Record<string, unknown>>(
        `SELECT id, kind, payload, created_at AS "at", read_at IS NOT NULL AS "read" FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
        [uid(req)],
      )
    ).rows;
  }

  @Post('notifications/read')
  @Roles('user', 'moderator', 'finance')
  @HttpCode(204)
  async read(@ReqDec() req: Req) {
    await this.ctx.pool.query<Record<string, unknown>>(
      'UPDATE notifications SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL',
      [uid(req), this.ctx.clock.now()],
    );
  }
}
