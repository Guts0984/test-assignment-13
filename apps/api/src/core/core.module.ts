import { Global, Module, type DynamicModule } from '@nestjs/common';
import { CTX, type Ctx } from './context.js';

/** Shared dependencies (database, Redis, storage, search, clock) as one injectable value. */
@Global()
@Module({})
export class CoreModule {
  static register(ctx: Ctx): DynamicModule {
    return { module: CoreModule, providers: [{ provide: CTX, useValue: ctx }], exports: [CTX] };
  }
}
