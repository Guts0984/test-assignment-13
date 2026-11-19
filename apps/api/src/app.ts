import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { ApiConfig } from './config.js';
import {
  AuthController,
  CatalogController,
  FinanceController,
  MeController,
  ModerationController,
  ProviderController,
  SellerController,
  TestClockController,
  TradingController,
} from './controllers.js';
import { CTX, createCtx, type Ctx } from './context.js';
import { LiveGateway, RedisIoAdapter } from './gateway.js';
import { ErrorFilter, SecurityGuard, requestId } from './http.js';
import { setupOpenApi } from './openapi.js';

@Module({})
class AppModule {
  static register(ctx: Ctx): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        AuthController,
        CatalogController,
        TradingController,
        MeController,
        SellerController,
        ModerationController,
        FinanceController,
        ProviderController,
        ...(ctx.config.testClock ? [TestClockController] : []),
      ],
      providers: [
        { provide: CTX, useValue: ctx },
        { provide: APP_GUARD, useClass: SecurityGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        LiveGateway,
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
