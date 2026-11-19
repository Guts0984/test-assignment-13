import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req as ReqDec,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  addFavorite,
  approveLot,
  appendDescription,
  claimNextLot,
  confirmReceipt,
  createLot,
  createTopup,
  attachProviderPayment,
  buyNow,
  financeReport,
  payForLot,
  placeBid,
  reconcile,
  rejectLot,
  removeFavorite,
  removeLot,
  settleTopup,
  shipLot,
  submitLot,
  updateLot,
  walletSummary,
  type Effects,
} from '@auction/domain';
import { hashPassword, verifyPassword } from '@auction/db';
import {
  createPayment,
  decidePayment,
  getPayment,
  verifyWebhook,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@auction/payment-stub';
import { photoKeys, presignPhotoUpload, searchLots } from '@auction/platform';
import {
  appError,
  bidInputSchema,
  lotAppendDescriptionInputSchema,
  loginInputSchema,
  photoPresignInputSchema,
  registerInputSchema,
  reportQuerySchema,
  searchQuerySchema,
  shipInputSchema,
  topUpInputSchema,
  lotRejectInputSchema,
  lotRemoveInputSchema,
  LOT_RULES,
  type ErrorCode,
} from '@auction/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { CTX, type Ctx } from './context.js';
import {
  Limit,
  NoCsrf,
  Optional,
  Public,
  Roles,
  SESSION_COOKIE,
  hashToken,
  idemKey,
  newToken,
  parse,
  type Req,
} from './http.js';
import { bidHistory, lotEventsAfter, lotView, signedPhotoUrl } from './views.js';

const emit = (ctx: Ctx, effects: Effects): void =>
  ctx.emitter.emit(effects, ctx.clock.now().getTime());
const uid = (req: Req): string => {
  if (!req.user) throw appError('UNAUTHENTICATED', 'sign in first');
  return req.user.id;
};
const uuidParam = (v: string): string => parse(z.uuid({ error: 'INVALID_ID' }), v);

/** A domain "refusal" result becomes the standard error (HTTP 409 etc.) with the minimum next bid attached. */
const refuse = (reason: string, minNextBid?: number): never => {
  throw appError(
    reason as ErrorCode,
    reason.toLowerCase().replaceAll('_', ' '),
    minNextBid === undefined ? {} : { meta: { minNextBid } },
  );
};

// =========================================================================================
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(CTX) private readonly ctx: Ctx) {}

  private async startSession(userId: string, res: Response): Promise<void> {
    const token = newToken();
    const now = this.ctx.clock.now();
    await this.ctx.pool.query<Record<string, unknown>>(
      `INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [userId, hashToken(token), now, new Date(now.getTime() + 7 * 86_400_000)],
    );
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.ctx.config.cookieSecure,
      maxAge: 7 * 86_400_000,
      path: '/',
    });
  }

  @Post('register')
  @Public()
  @HttpCode(201)
  @Limit({
    bucket: 'register',
    limit: (c) => c.config.rate.register,
    windowMs: 3_600_000,
    by: 'ip',
  })
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(registerInputSchema, body);
    const hash = await hashPassword(input.password);
    const { rows } = await this.ctx.pool
      .query<{ id: string }>(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id`,
        [input.email, hash, input.displayName],
      )
      .catch((e: unknown) => {
        if ((e as { code?: string }).code === '23505')
          throw appError('EMAIL_TAKEN', 'this email is already registered');
        throw e;
      });
    const id = rows[0]?.id ?? '';
    await this.startSession(id, res);
    return { id, email: input.email, displayName: input.displayName, role: 'user' };
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  @Limit({ bucket: 'login', limit: (c) => c.config.rate.login, windowMs: 60_000, by: 'ip' })
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const input = parse(loginInputSchema, body);
    const now = this.ctx.clock.now();
    const { rows } = await this.ctx.pool.query<{
      id: string;
      password_hash: string;
      role: string;
      display_name: string;
      failed_logins: number;
      locked_until: Date | null;
    }>(
      'SELECT id, password_hash, role, display_name, failed_logins, locked_until FROM users WHERE email = $1',
      [input.email],
    );
    const u = rows[0];
    // Same work and same answer for "no such user" and "wrong password": no account enumeration.
    const ok = await verifyPassword(input.password, u?.password_hash ?? 'scrypt$32768$8$1$00$00');
    if (u?.locked_until && u.locked_until > now)
      throw appError('ACCOUNT_LOCKED', 'too many failed attempts, try again later');
    if (!u || !ok) {
      if (u) {
        const failed = u.failed_logins + 1;
        await this.ctx.pool.query<Record<string, unknown>>(
          'UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1',
          [
            u.id,
            failed >= 5 ? 0 : failed,
            failed >= 5 ? new Date(now.getTime() + 15 * 60_000) : null,
          ],
        );
      }
      throw appError('INVALID_CREDENTIALS', 'wrong email or password');
    }
    await this.ctx.pool.query<Record<string, unknown>>(
      'UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1',
      [u.id],
    );
    await this.startSession(u.id, res);
    return { id: u.id, email: input.email, displayName: u.display_name, role: u.role };
  }

  @Post('logout')
  @Roles('user', 'moderator', 'finance')
  @HttpCode(204)
  async logout(@ReqDec() req: Req, @Res({ passthrough: true }) res: Response) {
    await this.ctx.pool.query<Record<string, unknown>>('DELETE FROM sessions WHERE id = $1', [
      req.user?.sessionId,
    ]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  @Roles('user', 'moderator', 'finance')
  me(@ReqDec() req: Req) {
    return {
      id: uid(req),
      role: req.user?.role,
      displayName: req.user?.displayName,
      locale: req.user?.locale,
    };
  }
}

// =========================================================================================
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

// =========================================================================================
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

// =========================================================================================
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
      notifyUrl: `${process.env['PROVIDER_BASE_URL'] ?? 'http://nginx:8080'}/webhooks/payments`,
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

// =========================================================================================
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
    if (!['draft', 'rejected', 'active'].includes(lot.status))
      throw appError('LOT_NOT_EDITABLE', 'photos can no longer be added');
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

// =========================================================================================
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

// =========================================================================================
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
  reconciliation() {
    return reconcile(this.ctx.pool, async (id) => {
      const p = await getPayment(this.ctx.pool, id);
      return { status: p?.status ?? 'not_found', amount: p?.amount };
    });
  }
}

// =========================================================================================
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

// =========================================================================================
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
