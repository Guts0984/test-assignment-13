import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';

import { z } from 'zod';
import { CTX, type Ctx } from '../core/context.js';
import { NoCsrf, Public, parse } from '../common/http.js';

/** Only mounted when TEST_CLOCK is on; absent otherwise (a request gets the normal 404 route error). */
@Controller('__test')
export class TestClockController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Post('clock')
  @Public()
  @NoCsrf()
  @HttpCode(200)
  set(@Body() body: unknown) {
    const { offsetMs } = parse(z.object({ offsetMs: z.number().int() }), body);
    this.ctx.clock.setOffset(offsetMs);
    return { offsetMs };
  }
}
