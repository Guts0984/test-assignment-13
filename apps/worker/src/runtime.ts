import {
  type Deps,
  type Effects,
  type FakeClock,
  autoConfirmLot,
  closeLot,
  createFakeClock,
  expirePayment,
  reconcilePendingTopups,
  sendFavoriteReminders,
  sweepExpiredClaims,
  systemClock,
  type Clock,
  type ProviderStatus,
} from '@auction/domain';
import { createDb, createPool, type Pool } from '@auction/db';
import { deliverDueWebhooks, type Fetcher } from '@auction/payment-stub';
import {
  QUEUES,
  closeQueues,
  createMailer,
  createMeili,
  createQueues,
  createRealtimeEmitter,
  createRedis,
  createS3,
  processOutbox,
  processUploadedPhoto,
  sendEmailById,
  syncLotPhotos,
  type Mailer,
  type Queues,
  type RealtimeEmitter,
} from '@auction/platform';
import { Worker, type Job } from 'bullmq';
import type { WorkerConfig } from './config.js';
import { errorFields, type Logger, silentLogger } from './log.js';
import { scheduleDueWork } from './scheduler.js';

export type WorkerHandle = {
  readonly name: string;
  readonly stop: () => Promise<void>;
  /** For tests: run one scheduler pass right now. */
  readonly tick: () => Promise<void>;
  readonly deps: Deps;
};

export type StartOptions = {
  readonly config: WorkerConfig;
  readonly name?: string;
  readonly clock?: Clock | FakeClock;
  readonly logger?: Logger;
  /** Turn individual loops off (tests). All on by default. */
  readonly disable?: {
    scheduler?: boolean;
    searchSync?: boolean;
    webhooks?: boolean;
    reconcile?: boolean;
    consumers?: boolean;
  };
  /** Replace the HTTP client used for webhooks and provider status (tests). */
  readonly fetcher?: typeof fetch;
};

/** Runs `fn` every `ms`, never two at once, never crashing the process: a failure is logged and retried next time. */
const every = (
  ms: number,
  name: string,
  log: Logger,
  fn: () => Promise<unknown>,
): { stop: () => Promise<void> } => {
  let running: Promise<unknown> | null = null;
  let stopped = false;
  const timer = setInterval(() => {
    if (running || stopped) return;
    running = fn()
      .catch((e: unknown) => log.warn(`${name} failed`, errorFields(e)))
      .finally(() => {
        running = null;
      });
  }, ms);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
};

/**
 * Starts one worker copy. Everything it does is idempotent, so any number of copies can run
 * against the same Postgres and Redis:
 *   - BullMQ consumers (lot close, payment deadline, auto-confirm, email, photo) - Redis hands each
 *     job to one consumer; the SQL underneath is idempotent anyway;
 *   - a scheduler that queues what Postgres says is due (so a flushed Redis heals in one tick);
 *   - search sync from the outbox, favourite reminders, moderation-claim release;
 *   - the payment stub's webhook sender and the top-up reconciler.
 */
export const startWorker = async (options: StartOptions): Promise<WorkerHandle> => {
  const { config } = options;
  const log = options.logger ?? silentLogger;
  const name = options.name ?? `worker-${process.pid}`;
  const clock = options.clock ?? systemClock;
  const http = options.fetcher ?? fetch;
  const disable = options.disable ?? {};

  const pool: Pool = createPool(config.databaseUrl, { max: 12, applicationName: name });
  createDb(pool); // registers the bigint type parser exactly once, before any query
  const redis = createRedis(config.redisUrl, name);
  const queues: Queues = createQueues(redis);
  const meili = createMeili(config.meili.url, config.meili.key);
  const s3 = createS3(config.s3);
  const mailer: Mailer = createMailer(config.smtp);
  const emitter: RealtimeEmitter = createRealtimeEmitter(redis);
  const deps: Deps = { pool, clock, timings: config.timings };
  const now = () => clock.now();

  const push = (effects: Effects): void => {
    if (effects.events.length > 0 || effects.notifications.length > 0)
      emitter.emit(effects, now().getTime());
  };

  // ---- BullMQ consumers --------------------------------------------------------------------
  const consumers: Worker[] = [];
  const consume = (queueName: string, handler: (job: Job) => Promise<void>): void => {
    const w = new Worker(queueName, handler, {
      connection: createRedis(config.redisUrl, `${name}:${queueName}`),
      concurrency: config.concurrency,
    });
    // Errors such as "Missing key for job" after Redis lost its data are expected and self-healing: the scheduler re-queues.
    w.on('error', (e) => log.warn('worker error', { queue: queueName, ...errorFields(e) }));
    w.on('failed', (job, e) =>
      log.warn('job failed', { queue: queueName, jobId: job?.id, ...errorFields(e) }),
    );
    consumers.push(w);
  };
  if (!disable.consumers) {
    consume(QUEUES.lotClose, async (job) => {
      const r = await closeLot(deps, (job.data as { lotId: string }).lotId);
      push(r.effects);
      log.debug('lot close', {
        lotId: (job.data as { lotId: string }).lotId,
        result: r.result.status,
      });
    });
    consume(QUEUES.paymentDeadline, async (job) => {
      const r = await expirePayment(deps, (job.data as { lotId: string }).lotId);
      push(r.effects);
    });
    consume(QUEUES.autoConfirm, async (job) => {
      const r = await autoConfirmLot(deps, (job.data as { lotId: string }).lotId);
      push(r.effects);
    });
    consume(QUEUES.email, async (job) => {
      await sendEmailById(pool, mailer, (job.data as { emailId: string }).emailId, now);
    });
    consume(QUEUES.photo, async (job) => {
      const r = await processUploadedPhoto(
        { pool, s3, config: config.s3, now },
        (job.data as { photoId: string }).photoId,
      );
      log.debug('photo', { photoId: (job.data as { photoId: string }).photoId, status: r.status });
    });
  }

  // ---- Postgres-driven loops -----------------------------------------------------------------
  const tick = async (): Promise<void> => {
    await scheduleDueWork(deps, queues);
    await sweepExpiredClaims(deps);
    push((await sendFavoriteReminders(deps)).effects);
  };

  const providerStatus = async (paymentId: string): Promise<ProviderStatus> => {
    const res = await http(`${config.provider.baseUrl}/provider/payments/${paymentId}`, {
      headers: { authorization: `Bearer ${config.provider.apiKey}` },
    });
    if (res.status === 404) return 'not_found';
    if (!res.ok) throw new Error(`provider status ${res.status}`);
    const body = (await res.json()) as { status: ProviderStatus };
    return body.status;
  };

  const webhookFetcher: Fetcher = async (url, init) => {
    const res = await http(url, init);
    return { status: res.status };
  };

  const loops = [
    ...(disable.scheduler ? [] : [every(config.intervals.sweeperMs, 'scheduler', log, tick)]),
    ...(disable.searchSync
      ? []
      : [
          every(config.intervals.searchSyncMs, 'search-sync', log, () =>
            processOutbox(pool, meili, {
              indexUid: config.indexUid,
              now,
              afterSync: async (lotIds) => {
                for (const id of lotIds)
                  await syncLotPhotos({ pool, s3, config: config.s3, now }, id);
              },
            }),
          ),
        ]),
    ...(disable.webhooks
      ? []
      : [
          every(config.intervals.webhookMs, 'webhooks', log, () =>
            deliverDueWebhooks(pool, {
              secret: config.webhookSecret,
              fetcher: webhookFetcher,
              now,
            }),
          ),
        ]),
    ...(disable.reconcile
      ? []
      : [
          every(config.intervals.topupReconcileMs, 'topup-reconcile', log, async () => {
            const r = await reconcilePendingTopups(
              deps,
              providerStatus,
              config.intervals.topupReconcileMinAgeMs,
            );
            if (r.credited > 0)
              log.info('reconciler credited top-ups whose webhook never arrived', r);
          }),
        ]),
  ];

  log.info('worker started', { name });
  return {
    name,
    deps,
    tick,
    stop: async () => {
      await Promise.all(loops.map((l) => l.stop()));
      await Promise.all(consumers.map((c) => c.close()));
      await closeQueues(queues);
      mailer.close();
      redis.disconnect();
      await pool.end();
      log.info('worker stopped', { name });
    },
  };
};

export { createFakeClock };
