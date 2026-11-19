import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req as ReqDec,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  addFavorite,
  confirmReceipt,
  buyNow,
  payForLot,
  placeBid,
  removeFavorite,
  shipLot,
} from '@auction/domain';

import { bidInputSchema, shipInputSchema } from '@auction/shared';

import { CTX, type Ctx } from '../core/context.js';
import { Limit, Roles, idemKey, parse, type Req } from '../common/http.js';

import { emit, refuse, uid, uuidParam } from '../common/helpers.js';

@ApiTags('trading')
@Controller()
export class TradingController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Post('lots/:id/bids')
  @Roles('user')
  @HttpCode(200)
  @Limit({ bucket: 'bid', limit: (c) => c.config.rate.bid, windowMs: 10_000, by: 'user' })
  async bid(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    const input = parse(bidInputSchema, body);
    const r = await placeBid(this.ctx.deps, {
      lotId: uuidParam(id),
      userId: uid(req),
      kind: input.kind,
      amount: input.amount,
      idempotencyKey: idemKey(req),
    });
    emit(this.ctx, r.effects);
    return r.result.ok ? r.result : refuse(r.result.reason, r.result.minNextBid);
  }

  @Post('lots/:id/buy-now')
  @Roles('user')
  @HttpCode(200)
  async buyNow(@Param('id') id: string, @ReqDec() req: Req) {
    const r = await buyNow(this.ctx.deps, {
      lotId: uuidParam(id),
      userId: uid(req),
      idempotencyKey: idemKey(req),
    });
    emit(this.ctx, r.effects);
    return r.result.ok ? r.result : refuse(r.result.reason);
  }

  @Post('lots/:id/pay')
  @Roles('user')
  @HttpCode(200)
  async pay(@Param('id') id: string, @ReqDec() req: Req) {
    const r = await payForLot(this.ctx.deps, {
      lotId: uuidParam(id),
      userId: uid(req),
      idempotencyKey: idemKey(req),
    });
    emit(this.ctx, r.effects);
    return r.result.ok ? r.result : refuse(r.result.reason);
  }

  @Post('lots/:id/ship')
  @Roles('user')
  @HttpCode(200)
  async ship(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    const r = await shipLot(this.ctx.deps, {
      lotId: uuidParam(id),
      sellerId: uid(req),
      trackingNumber: parse(shipInputSchema, body).trackingNumber,
    });
    emit(this.ctx, r.effects);
    return r.result;
  }

  @Post('lots/:id/confirm')
  @Roles('user')
  @HttpCode(200)
  async confirm(@Param('id') id: string, @ReqDec() req: Req) {
    const r = await confirmReceipt(this.ctx.deps, { lotId: uuidParam(id), buyerId: uid(req) });
    emit(this.ctx, r.effects);
    return r.result;
  }

  @Put('me/favorites/:lotId')
  @Roles('user')
  @HttpCode(200)
  favorite(@Param('lotId') lotId: string, @ReqDec() req: Req) {
    return addFavorite(this.ctx.deps, { userId: uid(req), lotId: uuidParam(lotId) });
  }

  @Delete('me/favorites/:lotId')
  @Roles('user')
  @HttpCode(204)
  async unfavorite(@Param('lotId') lotId: string, @ReqDec() req: Req) {
    await removeFavorite(this.ctx.deps, { userId: uid(req), lotId: uuidParam(lotId) });
  }
}
