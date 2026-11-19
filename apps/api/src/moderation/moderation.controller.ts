import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req as ReqDec,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { approveLot, claimNextLot, rejectLot, removeLot } from '@auction/domain';

import { appError, lotRejectInputSchema, lotRemoveInputSchema } from '@auction/shared';

import { CTX, type Ctx } from '../core/context.js';
import { Roles, parse, type Req } from '../common/http.js';

import { emit, uid, uuidParam } from '../common/helpers.js';
import { signedPhotoUrl } from '../catalog/views.js';

@ApiTags('moderation')
@Controller('moderation')
export class ModerationController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Post('claim')
  @Roles('moderator')
  @HttpCode(200)
  async claim(@ReqDec() req: Req) {
    const c = await claimNextLot(this.ctx.deps, uid(req));
    if (!c) throw appError('REVIEW_QUEUE_EMPTY', 'nothing is waiting for review');
    return c;
  }

  /** The claimed lot with signed (private) photo links. Only the moderator holding the live claim sees it. */
  @Get('lots/:id')
  @Roles('moderator')
  async lot(@Param('id') id: string, @ReqDec() req: Req) {
    const lotId = uuidParam(id);
    const l = (
      await this.ctx.pool.query<
        Record<string, unknown> & {
          claimed_by: string | null;
          claim_expires_at: Date | null;
          status: string;
        }
      >('SELECT * FROM lots WHERE id = $1', [lotId])
    ).rows[0];
    if (
      l?.status !== 'in_review' ||
      l.claimed_by !== uid(req) ||
      !l.claim_expires_at ||
      l.claim_expires_at <= this.ctx.clock.now()
    )
      throw appError('REVIEW_CLAIM_LOST', 'you do not hold this lot');
    const photos = (
      await this.ctx.pool.query<{
        id: string;
        key: string;
        preview_key: string | null;
        status: string;
      }>(
        'SELECT id, key, preview_key, status FROM lot_photos WHERE lot_id = $1 ORDER BY position',
        [lotId],
      )
    ).rows;
    return {
      id: l['id'],
      title: l['title'],
      description: l['description'],
      categoryId: l['category_id'],
      cityId: l['city_id'],
      condition: l['condition'],
      startPrice: l['start_price'],
      buyNowPrice: l['buy_now_price'],
      durationDays: l['duration_days'],
      claimExpiresAt: l.claim_expires_at.toISOString(),
      photos: await Promise.all(
        photos
          .filter((p) => p.status === 'ready')
          .map(async (p) => ({
            id: p.id,
            url: await signedPhotoUrl(this.ctx, p.key),
            previewUrl: p.preview_key ? await signedPhotoUrl(this.ctx, p.preview_key) : null,
          })),
      ),
    };
  }

  @Post('lots/:id/approve')
  @Roles('moderator')
  @HttpCode(200)
  approve(@Param('id') id: string, @ReqDec() req: Req) {
    return approveLot(this.ctx.deps, { lotId: uuidParam(id), moderatorId: uid(req) });
  }

  @Post('lots/:id/reject')
  @Roles('moderator')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    return rejectLot(this.ctx.deps, {
      lotId: uuidParam(id),
      moderatorId: uid(req),
      reason: parse(lotRejectInputSchema, body).reason,
    });
  }

  @Post('lots/:id/remove')
  @Roles('moderator')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    const r = await removeLot(this.ctx.deps, {
      lotId: uuidParam(id),
      moderatorId: uid(req),
      reason: parse(lotRemoveInputSchema, body).reason,
    });
    emit(this.ctx, r.effects);
    return r.result;
  }
}
