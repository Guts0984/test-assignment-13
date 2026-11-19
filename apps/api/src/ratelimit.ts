import type { Redis } from '@auction/platform';

export type LimitResult = { readonly allowed: boolean; readonly retryAfterMs: number };
export type RateLimiter = {
  readonly hit: (key: string, limit: number, windowMs: number) => Promise<LimitResult>;
};

/**
 * Fixed-window counter in Redis (INCR + PEXPIRE). If Redis is unreachable the limiter falls back to
 * a per-process map, so an attacker cannot switch the limits off by taking Redis down, and Redis loss
 * never blocks real users.
 */
export const createRateLimiter = (redis: Redis): RateLimiter => {
  const local = new Map<string, { count: number; resetAt: number }>();
  const hitLocal = (key: string, limit: number, windowMs: number, now: number): LimitResult => {
    if (local.size > 50_000) for (const [k, v] of local) if (v.resetAt <= now) local.delete(k);
    const cur = local.get(key);
    if (!cur || cur.resetAt <= now) {
      local.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    cur.count++;
    return { allowed: cur.count <= limit, retryAfterMs: Math.max(0, cur.resetAt - now) };
  };
  return {
    hit: async (key, limit, windowMs) => {
      const now = Date.now();
      try {
        if (redis.status !== 'ready') return hitLocal(key, limit, windowMs, now);
        const k = `rl:${key}:${Math.floor(now / windowMs)}`;
        const count = await redis.incr(k);
        if (count === 1) await redis.pexpire(k, windowMs * 2);
        return { allowed: count <= limit, retryAfterMs: windowMs - (now % windowMs) };
      } catch {
        return hitLocal(key, limit, windowMs, now);
      }
    },
  };
};
