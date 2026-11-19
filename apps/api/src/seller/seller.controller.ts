import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req as ReqDec,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { appendDescription, createLot, submitLot, updateLot } from '@auction/domain';

import { photoKeys, presignPhotoUpload } from '@auction/platform';
import {
  appError,
  lotAppendDescriptionInputSchema,
  photoPresignInputSchema,
  LOT_RULES,
} from '@auction/shared';

import { CTX, type Ctx } from '../core/context.js';
import { Limit, Roles, parse, type Req } from '../common/http.js';

import { emit, uid, uuidParam } from '../common/helpers.js';

@ApiTags('seller')
@Controller('lots')
export class SellerController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Post()
  @Roles('user')
  @HttpCode(201)
  create(@Body() body: unknown, @ReqDec() req: Req) {
    return createLot(this.ctx.deps, uid(req), body);
  }

  @Put(':id')
  @Roles('user')
  async update(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    return (
      await updateLot(this.ctx.deps, { lotId: uuidParam(id), sellerId: uid(req), patch: body })
    ).result;
  }

  @Post(':id/description')
  @Roles('user')
  @HttpCode(200)
  async append(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    const { text } = parse(lotAppendDescriptionInputSchema, body);
    const r = await appendDescription(this.ctx.deps, {
      lotId: uuidParam(id),
      sellerId: uid(req),
      text,
    });
    emit(this.ctx, r.effects);
    return r.result;
  }

  @Post(':id/submit')
  @Roles('user')
  @HttpCode(200)
  submit(@Param('id') id: string, @ReqDec() req: Req) {
    return submitLot(this.ctx.deps, { lotId: uuidParam(id), sellerId: uid(req) });
  }

  /** Gives the browser a one-file upload ticket straight to object storage. */
  @Post(':id/photos/presign')
  @Roles('user')
  @HttpCode(201)
  @Limit({ bucket: 'presign', limit: (c) => c.config.rate.presign, windowMs: 60_000, by: 'user' })
  async presign(@Param('id') id: string, @Body() body: unknown, @ReqDec() req: Req) {
    const lotId = uuidParam(id);
    const input = parse(photoPresignInputSchema, body);
    const lot = (
      await this.ctx.pool.query<{ seller_id: string; status: string }>(
        'SELECT seller_id, status FROM lots WHERE id = $1',
        [lotId],
      )
    ).rows[0];
    if (lot?.seller_id !== uid(req)) throw appError('NOT_FOUND', 'lot not found');
    if (!['draft', 'rejected'].includes(lot.status))
      throw appError('LOT_NOT_EDITABLE', 'photos can no longer be added');
    // A rejected photo no longer holds a slot (the unique index still counts it, so remove it).
    await this.ctx.pool.query("DELETE FROM lot_photos WHERE lot_id = $1 AND status = 'rejected'", [
      lotId,
    ]);
    const photoId = randomUUID();
    // The unique (lot_id, position) index is what enforces "at most 10": a free slot or a refusal.
    let position = -1;
    for (let attempt = 0; attempt < 4 && position < 0; attempt++) {
      const used = new Set(
        (
          await this.ctx.pool.query<{ position: number }>(
            'SELECT position FROM lot_photos WHERE lot_id = $1 AND status <> $2',
            [lotId, 'rejected'],
          )
        ).rows.map((r) => r.position),
      );
      const free = Array.from({ length: LOT_RULES.maxPhotos }, (_, i) => i).find(
        (i) => !used.has(i),
      );
      if (free === undefined)
        throw appError(
          'PHOTO_LIMIT_REACHED',
          `a lot can have at most ${LOT_RULES.maxPhotos} photos`,
        );
      try {
        await this.ctx.pool.query<Record<string, unknown>>(
          `INSERT INTO lot_photos (id, lot_id, position, key, content_type, size_bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            photoId,
            lotId,
            free,
            photoKeys(lotId, photoId).upload,
            input.contentType,
            input.size,
            this.ctx.clock.now(),
          ],
        );
        position = free;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e; // someone took the slot: look again
      }
    }
    if (position < 0) throw appError('CONFLICT', 'could not reserve a photo slot, try again');
    const ticket = await presignPhotoUpload(this.ctx.s3, this.ctx.config.s3, {
      lotId,
      photoId,
      contentType: input.contentType,
      size: input.size,
    });
    return {
      photoId,
      position,
      upload: {
        url: this.ctx.config.publicUploadUrl,
        fields: ticket.fields,
        expiresInSeconds: ticket.expiresInSeconds,
      },
    };
  }
}
