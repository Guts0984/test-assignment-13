import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { financeReport, reconcile } from '@auction/domain';

import { reportQuerySchema } from '@auction/shared';

import { CTX, type Ctx } from '../core/context.js';
import { Roles, parse } from '../common/http.js';

@ApiTags('finance')
@Controller('finance')
export class FinanceController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Get('report')
  @Roles('finance')
  report(@Query() query: unknown) {
    const q = parse(reportQuerySchema, query);
    return financeReport(this.ctx.pool, q.from, q.to);
  }

  @Get('reconciliation')
  @Roles('finance')
  async reconciliation() {
    // One query for every provider payment instead of one per top-up (the seed has 10 000 of them).
    const rows = (
      await this.ctx.pool.query<{
        id: string;
        status: 'pending' | 'succeeded' | 'failed';
        amount: number;
      }>('SELECT id, status, amount FROM provider.payments')
    ).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return reconcile(this.ctx.pool, (id) => {
      const p = byId.get(id);
      return Promise.resolve({ status: p?.status ?? 'not_found', amount: p?.amount });
    });
  }
}
