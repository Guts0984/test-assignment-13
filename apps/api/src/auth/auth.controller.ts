import { Body, Controller, Get, HttpCode, Inject, Post, Req as ReqDec, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { hashPassword, verifyPassword } from '@auction/db';

import { appError, loginInputSchema, registerInputSchema } from '@auction/shared';
import type { Response } from 'express';

import { CTX, type Ctx } from '../core/context.js';
import {
  Limit,
  Public,
  Roles,
  SESSION_COOKIE,
  hashToken,
  newToken,
  parse,
  type Req,
} from '../common/http.js';

import { uid } from '../common/helpers.js';

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
