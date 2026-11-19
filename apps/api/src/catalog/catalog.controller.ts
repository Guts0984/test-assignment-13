import { Controller, Get, Inject, Param, Query, Req as ReqDec } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { searchLots } from '@auction/platform';
import { searchQuerySchema } from '@auction/shared';
import { z } from 'zod';
import { CTX, type Ctx } from '../core/context.js';
import { Limit, Optional, Public, parse, type Req } from '../common/http.js';

import { uuidParam } from '../common/helpers.js';
import { bidHistory, lotEventsAfter, lotView } from './views.js';

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Get('health')
  @Public()
  health() {
    return { status: 'ok', node: this.ctx.config.nodeId };
  }

  /** Clients calibrate their countdown against this (NTP-style), so a wrong local clock does not matter. */
  @Get('time')
  @Public()
  time() {
    return { serverNow: this.ctx.clock.now().getTime() };
  }

  @Get('categories')
  @Public()
  async categories() {
    return (
      await this.ctx.pool.query<Record<string, unknown>>(
        'SELECT id, slug, name_uk AS "nameUk", name_en AS "nameEn", name_pl AS "namePl" FROM categories ORDER BY id',
      )
    ).rows;
  }

  @Get('cities')
  @Public()
  async cities() {
    return (
      await this.ctx.pool.query<Record<string, unknown>>(
        'SELECT id, slug, name_uk AS "nameUk", name_en AS "nameEn", name_pl AS "namePl" FROM cities ORDER BY id',
      )
    ).rows;
  }

  @Get('search')
  @Public()
  @Limit({ bucket: 'search', limit: (c) => c.config.rate.search, windowMs: 60_000, by: 'ip' })
  search(@Query() query: unknown) {
    return searchLots(
      this.ctx.meili,
      parse(searchQuerySchema, query),
      this.ctx.clock.now().getTime(),
    );
  }

  @Get('lots/:id')
  @Optional()
  lot(@Param('id') id: string, @ReqDec() req: Req) {
    return lotView(this.ctx, id, req.user?.id ?? null);
  }

  @Get('lots/:id/bids')
  @Optional()
  bids(@Param('id') id: string, @ReqDec() req: Req) {
    return bidHistory(this.ctx, uuidParam(id), req.user?.id ?? null);
  }

  @Get('lots/:id/events')
  @Public()
  events(@Param('id') id: string, @Query('after') after?: string) {
    return lotEventsAfter(
      this.ctx,
      uuidParam(id),
      parse(z.coerce.number().int().min(0).default(0), after ?? 0),
    );
  }
}
