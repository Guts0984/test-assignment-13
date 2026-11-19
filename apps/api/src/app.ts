import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { ApiConfig } from './config.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { CoreModule } from './core/core.module.js';
import { createCtx, type Ctx } from './core/context.js';
import { FinanceModule } from './finance/finance.module.js';
import { MeModule } from './me/me.module.js';
import { ModerationModule } from './moderation/moderation.module.js';
import { ProviderModule } from './provider/provider.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RedisIoAdapter } from './realtime/gateway.js';
import { SellerModule } from './seller/seller.module.js';
import { TestingModule } from './testing/testing.module.js';
import { TradingModule } from './trading/trading.module.js';
import { ErrorFilter, SecurityGuard, requestId } from './common/http.js';
import { setupOpenApi } from './openapi.js';
@Module({})
class AppModule {
  static register(ctx: Ctx): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.register(ctx),
        AuthModule,
        CatalogModule,
        TradingModule,
        MeModule,
        SellerModule,
        ModerationModule,
        FinanceModule,
        ProviderModule,
        RealtimeModule,
        ...(ctx.config.testClock ? [TestingModule] : []),
      ],
      providers: [
        { provide: APP_GUARD, useClass: SecurityGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
      ],
    };
  }
}

export type RunningApp = {
  readonly app: NestExpressApplication;
  readonly ctx: Ctx;
  readonly url: string;
  readonly close: () => Promise<void>;
};

/** Builds the Nest app (no listening). `main.ts` listens; tests listen on a random port; the OpenAPI script just reads routes. */
export const buildApp = async (
  config: ApiConfig,
): Promise<{ app: NestExpressApplication; ctx: Ctx }> => {
  const ctx = createCtx(config);
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(ctx), {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestId);
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    next();
  });
  app.use(cookieParser());
  // The webhook signature is over the exact bytes, so keep the raw body next to the parsed one.
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  const adapter = new RedisIoAdapter(app);
  adapter.connectRedis(config.redisUrl);
  app.useWebSocketAdapter(adapter);
  app.enableShutdownHooks();
  await setupOpenApi(app); // must be registered before the app starts listening
  return { app, ctx };
};

export const startApp = async (config: ApiConfig, port = config.port): Promise<RunningApp> => {
  const { app, ctx } = await buildApp(config);
  await app.listen(port, '0.0.0.0');
  const url = await app.getUrl();
  return {
    app,
    ctx,
    url: url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1'),
    close: async () => {
      await app.close();
      await ctx.close();
    },
  };
};
