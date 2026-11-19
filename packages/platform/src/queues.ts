import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * Queue names and deterministic job ids. A job id encodes WHAT and WHEN, so adding the same job
 * twice (from several workers, or again after Redis lost it) is a no-op, and a job for an old
 * deadline can be told apart from the current one. Postgres stays the source of truth: handlers
 * re-read the row and decide by the server clock.
 */
export const QUEUES = {
  lotClose: 'lot-close',
  paymentDeadline: 'payment-deadline',
  autoConfirm: 'auto-confirm',
  email: 'email',
  photo: 'photo-process',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const jobId = {
  close: (lotId: string, endsAtMs: number) => `close-${lotId}-${endsAtMs}`,
  payment: (lotId: string, dueAtMs: number) => `payment-${lotId}-${dueAtMs}`,
  autoConfirm: (lotId: string, shippedAtMs: number) => `confirm-${lotId}-${shippedAtMs}`,
  email: (emailId: string) => `email-${emailId}`,
  photo: (photoId: string) => `photo-${photoId}`,
} as const;

export type Queues = { readonly [K in keyof typeof QUEUES]: Queue };

export const createQueues = (connection: Redis): Queues => {
  const defaults: JobsOptions = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    // Finished jobs are forgotten at once, so the same deterministic id can be queued again later.
    removeOnComplete: true,
    removeOnFail: 1000,
  };
  const make = (name: QueueName) => {
    const queue = new Queue(name, { connection, defaultJobOptions: defaults });
    queue.on('error', () => undefined); // Redis hiccups are retried; an unhandled 'error' event would crash the process
    return queue;
  };
  return {
    lotClose: make(QUEUES.lotClose),
    paymentDeadline: make(QUEUES.paymentDeadline),
    autoConfirm: make(QUEUES.autoConfirm),
    email: make(QUEUES.email),
    photo: make(QUEUES.photo),
  };
};

/** Adds a job that should run at `runAtMs`. Duplicates (same id) are ignored by BullMQ. */
export const scheduleAt = async (
  queue: Queue,
  id: string,
  data: Record<string, unknown>,
  runAtMs: number,
  nowMs: number,
): Promise<void> => {
  await queue.add(queue.name, data, { jobId: id, delay: Math.max(0, runAtMs - nowMs) });
};

export const closeQueues = async (queues: Queues): Promise<void> => {
  await Promise.all(Object.values(queues).map((q) => q.close()));
};
