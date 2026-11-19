import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req as ReqDec,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { settleTopup } from '@auction/domain';

import {
  decidePayment,
  getPayment,
  verifyWebhook,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@auction/payment-stub';

import { appError } from '@auction/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { CTX, type Ctx } from '../core/context.js';
import { NoCsrf, Public, parse, type Req } from '../common/http.js';

import { emit, uuidParam } from '../common/helpers.js';

const htmlEscape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The payment stub, as a company of its own: a pay page, a status API and the webhook receiver. */
@ApiTags('payment-stub')
@Controller()
export class ProviderController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  @Get('provider/pay/:id')
  @Public()
  async page(@Param('id') id: string, @Res() res: Response) {
    const p = await getPayment(this.ctx.pool, id);
    if (!p) throw appError('NOT_FOUND', 'payment not found');
    const amount = (p.amount / 100).toFixed(2);
    res.type('html')
      .send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Payment stub</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem">
<h1>Payment stub</h1><p>Pay <b>${htmlEscape(amount)} ₴</b> (status: <b>${htmlEscape(p.status)}</b>)</p>
<form method="post" action="/provider/pay/${htmlEscape(p.id)}/decision" style="display:grid;gap:.75rem">
<button name="outcome" value="succeeded">Success</button>
<button name="outcome" value="failed">Failure</button>
<button name="outcome" value="close">Close without answer</button></form></body></html>`);
  }

  @Post('provider/pay/:id/decision')
  @Public()
  @NoCsrf()
  @HttpCode(200)
  async decide(@Param('id') id: string, @Body() body: unknown, @Res() res: Response) {
    const outcome = parse(
      z.object({ outcome: z.enum(['succeeded', 'failed', 'close']) }),
      body,
    ).outcome;
    if (outcome !== 'close') {
      await decidePayment(this.ctx.pool, {
        paymentId: uuidParam(id),
        outcome,
        chaos: this.ctx.config.chaos,
        now: this.ctx.clock.now(),
      });
    }
    res.redirect(303, `${this.ctx.config.publicUrl}/en/wallet?payment=${outcome}`);
  }

  /** Status API, used by the reconciler. Needs the provider API key. */
  @Get('provider/payments/:id')
  @Public()
  async status(@Param('id') id: string, @ReqDec() req: Req) {
    if (req.headers.authorization !== `Bearer ${this.ctx.config.providerApiKey}`)
      throw appError('UNAUTHENTICATED', 'provider API key required');
    const p = await getPayment(this.ctx.pool, id);
    if (!p) throw appError('NOT_FOUND', 'payment not found');
    return { id: p.id, status: p.status, amount: p.amount, reference: p.reference };
  }

  /**
   * Webhook receiver. The signature is checked over the RAW body, then the status is re-fetched from the
   * provider (the webhook is only a hint, so a duplicate, late or contradicting event cannot decide
   * anything), and the settle is applied at most once.
   */
  @Post('webhooks/payments')
  @Public()
  @NoCsrf()
  @HttpCode(200)
  async webhook(@ReqDec() req: Req) {
    const raw = (req as Req & { rawBody?: string }).rawBody ?? '';
    const v = verifyWebhook({
      secret: this.ctx.config.webhookSecret,
      signature: req.headers[SIGNATURE_HEADER] as string | undefined,
      timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
      body: raw,
      nowMs: this.ctx.clock.now().getTime(),
    });
    if (!v.ok) throw appError('WEBHOOK_SIGNATURE_INVALID', 'webhook signature is invalid');
    const body = parse(z.object({ data: z.object({ paymentId: z.uuid() }) }), JSON.parse(raw));
    const p = await getPayment(this.ctx.pool, body.data.paymentId);
    if (!p) throw appError('NOT_FOUND', 'unknown payment');
    if (p.status === 'pending') return { ok: true, settled: false };
    const r = await settleTopup(this.ctx.deps, { topupId: p.reference, outcome: p.status });
    emit(this.ctx, r.effects);
    return { ok: true, settled: r.result.credited };
  }
}
