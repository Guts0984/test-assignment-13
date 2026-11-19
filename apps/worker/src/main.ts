import 'reflect-metadata';
import { Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadWorkerConfig } from './env.js';
import { createLogger } from './log.js';
import { startWorker, type WorkerHandle } from './runtime.js';

/** NestJS only wires lifecycle here; all behaviour is the functional `startWorker`. */
@Injectable()
class WorkerService implements OnModuleInit, OnApplicationShutdown {
  private handle: WorkerHandle | null = null;

  async onModuleInit(): Promise<void> {
    const config = loadWorkerConfig();
    this.handle = await startWorker({
      config,
      logger: createLogger(config.logLevel, { service: 'worker' }),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle?.stop();
  }
}

@Module({ providers: [WorkerService] })
class WorkerModule {}

const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks();
