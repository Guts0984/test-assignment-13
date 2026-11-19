import { Redis } from 'ioredis';

/**
 * One connection factory for BullMQ and everything else. `maxRetriesPerRequest: null` is required
 * by BullMQ workers (they block on Redis), and the retry strategy keeps reconnecting forever so a
 * Redis restart heals by itself instead of crashing the process.
 */
export const createRedis = (url: string, name = 'auction'): Redis => {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    connectionName: name,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  // Errors are surfaced through retries; an unhandled 'error' event would kill the process.
  client.on('error', () => undefined);
  return client;
};

export type { Redis };
