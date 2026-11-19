import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  appError,
  ERROR_DEFINITIONS,
  httpStatusFor,
  idempotencyKeySchema,
  isAppError,
  zodIssuesToDetails,
  type ErrorCode,
  type Role,
} from '@auction/shared';
import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { CTX, type Ctx } from '../core/context.js';

export const SESSION_COOKIE = 'sid';
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_VALUE = 'auction-web';

export type AuthUser = {
  id: string;
  role: Role;
  displayName: string;
  locale: 'uk' | 'en' | 'pl';
  sessionId: string;
};
export type Req = Request & { user?: AuthUser; requestId: string };

// ---- policy decorators: every route MUST declare one, otherwise it is refused (fail closed) ----
export const Public = () => SetMetadata('policy', { kind: 'public' });
/** Public, but a valid session (if any) is still attached so the response can be personalised. */
export const Optional = () => SetMetadata('policy', { kind: 'optional' });
export const Roles = (...roles: Role[]) => SetMetadata('policy', { kind: 'roles', roles });
export const NoCsrf = () => SetMetadata('noCsrf', true);
export type LimitSpec = {
  bucket: string;
  limit: (c: Ctx) => number;
  windowMs: number;
  by: 'ip' | 'user';
};
export const Limit = (spec: LimitSpec) => SetMetadata('limit', spec);

type Policy = { kind: 'public' | 'optional' } | { kind: 'roles'; roles: Role[] };

/** Parses with a Zod schema or throws the one error format. Used for bodies, queries and params. */
export const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
  const r = schema.safeParse(value);
  if (!r.success)
    throw appError('VALIDATION_FAILED', 'invalid input', {
      details: zodIssuesToDetails(r.error.issues),
    });
  return r.data;
};

export const idemKey = (req: Request): string => {
  const raw = req.headers['idempotency-key'];
  if (typeof raw !== 'string')
    throw appError('IDEMPOTENCY_KEY_REQUIRED', 'the Idempotency-Key header is required');
  const r = idempotencyKeySchema.safeParse(raw);
  if (!r.success)
    throw appError('VALIDATION_FAILED', 'invalid Idempotency-Key', {
      details: [{ path: 'Idempotency-Key', code: 'invalid', message: 'invalid Idempotency-Key' }],
    });
  return r.data;
};

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');

export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  (req as Req).requestId = randomUUID();
  res.setHeader('x-request-id', (req as Req).requestId);
  next();
};

/** Counted by the real client address (nginx sets it; only trusted proxies may). */
export const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    @Inject(CTX) private readonly ctx: Ctx,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Req>();
    const res = context.switchToHttp().getResponse<Response>();
    const policy = this.reflector.getAllAndOverride<Policy | undefined>('policy', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) throw appError('FORBIDDEN', 'this route has no access policy');

    // 1. one global budget per client address
    const ip = clientIp(req);
    const g = await this.ctx.limiter.hit(`ip:${ip}`, this.ctx.config.rate.global, 60_000);
    if (!g.allowed) return this.tooMany(res, g.retryAfterMs);

    // 2. CSRF: state-changing requests must carry the custom header, and a browser Origin must be ours
    if (
      !SAFE.has(req.method) &&
      !this.reflector.getAllAndOverride<boolean | undefined>('noCsrf', [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      const origin = req.headers.origin;
      let originOk = origin === undefined;
      if (origin !== undefined) {
        try {
          originOk = new URL(origin).host === new URL(this.ctx.config.publicUrl).host;
        } catch {
          originOk = false;
        }
      }
      if (req.headers[CSRF_HEADER] !== CSRF_VALUE || !originOk)
        throw appError('CSRF_REJECTED', 'missing or invalid CSRF protection');
    }

    // 3. session
    if (policy.kind !== 'public') await this.attachUser(req);
    if (policy.kind === 'roles') {
      if (!req.user) throw appError('UNAUTHENTICATED', 'sign in first');
      if (!policy.roles.includes(req.user.role))
        throw appError('FORBIDDEN', 'your role cannot do this');
    }

    // 4. per-route limit
    const spec = this.reflector.getAllAndOverride<LimitSpec | undefined>('limit', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (spec) {
      const who = spec.by === 'user' && req.user ? `u:${req.user.id}` : `ip:${ip}`;
      const r = await this.ctx.limiter.hit(
        `${spec.bucket}:${who}`,
        spec.limit(this.ctx),
        spec.windowMs,
      );
      if (!r.allowed) return this.tooMany(res, r.retryAfterMs);
    }
    return true;
  }

  private tooMany(res: Response, retryAfterMs: number): never {
    res.setHeader('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    throw appError('RATE_LIMITED', 'too many requests', { meta: { retryAfterMs } });
  }

  private async attachUser(req: Req): Promise<void> {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return;
    const { rows } = await this.ctx.pool.query<{
      id: string;
      role: Role;
      display_name: string;
      locale: 'uk' | 'en' | 'pl';
      sid: string;
    }>(
      `SELECT u.id, u.role, u.display_name, u.locale, s.id AS sid FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2`,
      [hashToken(token), this.ctx.clock.now()],
    );
    const r = rows[0];
    if (r)
      req.user = {
        id: r.id,
        role: r.role,
        displayName: r.display_name,
        locale: r.locale,
        sessionId: r.sid,
      };
  }
}

/** One error shape for everything, mapped from domain errors, Zod, Nest and Postgres. Never leaks internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Req>();
    const res = http.getResponse<Response>();
    const send = (
      code: ErrorCode,
      message: string,
      extra: { details?: unknown; meta?: unknown } = {},
    ) => {
      if (res.headersSent) return;
      res
        .status(httpStatusFor(code))
        .json({ error: { code, message, ...extra }, requestId: req.requestId });
    };

    if (isAppError(error))
      return send(error.code, error.message, { details: error.details, meta: error.meta });
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 404) return send('ROUTE_NOT_FOUND', 'no such route');
      if (status === 413) return send('PAYLOAD_TOO_LARGE', 'request body is too large');
      if (status === 415) return send('UNSUPPORTED_MEDIA_TYPE', 'unsupported content type');
      if (status === 401) return send('UNAUTHENTICATED', 'sign in first');
      if (status === 403) return send('FORBIDDEN', 'forbidden');
      if (status === 400 && /JSON|Unexpected token|Unterminated|Expected/i.test(error.message))
        return send('MALFORMED_JSON', 'the request body is not valid JSON');
      return send('VALIDATION_FAILED', 'bad request');
    }
    const e = error as { type?: string; status?: number; code?: string; name?: string };
    if (e.type === 'entity.parse.failed')
      return send('MALFORMED_JSON', 'the request body is not valid JSON');
    if (e.type === 'entity.too.large')
      return send('PAYLOAD_TOO_LARGE', 'request body is too large');
    if (e.type === 'encoding.unsupported' || e.type === 'charset.unsupported')
      return send('UNSUPPORTED_MEDIA_TYPE', 'unsupported encoding');
    if (e.code === '23505') return send('CONFLICT', 'conflicts with existing data');
    if (e.code === '23503') return send('VALIDATION_FAILED', 'a referenced item does not exist');
    if (
      e.code === '22P02' ||
      e.code === '22003' ||
      e.code === '23502' ||
      e.code === '23514' ||
      e.code === '22021' ||
      e.code === '22001'
    ) {
      return send('VALIDATION_FAILED', 'invalid input');
    }
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'unhandled error', requestId: req.requestId, name: e.name, code: e.code, message: (error as Error).message })}\n`,
    );
    send('INTERNAL', 'something went wrong; quote the requestId when reporting this');
  }
}

export const knownErrorCodes = Object.keys(ERROR_DEFINITIONS);
