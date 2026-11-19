import type { Pool } from '@auction/db';
import type { Tx } from './types.js';

const RETRYABLE = new Set(['40001', '40P01']); // serialization failure, deadlock detected

const sqlState = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/**
 * Runs `fn` in a transaction. A deadlock or serialization failure rolls back and retries the
 * whole function a few times: use cases are written so a retry is always safe (they re-read
 * everything under the lot lock, and money moves are keyed by unique refs).
 */
export const withTx = async <T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
  attempts = 4,
): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      const result = await fn(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => undefined);
      const code = sqlState(error);
      if (code !== undefined && RETRYABLE.has(code) && attempt < attempts) {
        // Small jittered back-off so the two victims do not collide again.
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * attempt));
        continue;
      }
      throw error;
    } finally {
      tx.release();
    }
  }
};

/** Postgres SQLSTATE of an error, if it has one. */
export const pgCode = sqlState;
