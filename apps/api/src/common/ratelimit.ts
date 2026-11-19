import { randomUUID } from 'node:crypto';
import type { Redis } from '@auction/platform';

export type LimitResult = { readonly allowed: boolean; readonly retryAfterMs: number };
export type RateLimiter = {
  readonly hit: (key: string, limit: number, windowMs: number) => Promise<LimitResult>;
};

/**
 * Sliding-window log: a request is allowed when fewer than `limit` allowed requests happened in the last
 * `windowMs` milliseconds, at ANY moment (unlike a fixed window, which lets 2x the limit through across a
 * window boundary). Rejected requests are not recorded, so a client that keeps hammering is let in again
 * exactly `windowMs` after its oldest allowed request.
 *
 * In Redis the whole decision (trim, count, record) is one Lua script, so it is atomic across any number of
 * API copies, and it uses the Redis server clock, so copies with skewed clocks agree.
 * KEYS[1] sorted set; ARGV: limit, windowMs, unique member. Returns {allowed, retryAfterMs}.
 */
const SLIDING_WINDOW_LUA = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
if redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, math.max(1, tonumber(oldest[2]) + window - now)}
`;

/**
 * If Redis is unreachable the limiter falls back to the SAME algorithm in a per-process map, so an attacker
 * cannot switch the limits off by taking Redis down and Redis loss never blocks real users. Caveat: while
 * Redis is down every API copy counts separately, so the effective limit is (limit x number of copies).
 */
export const createRateLimiter = (redis: Redis): RateLimiter => {
  const local = new Map<string, number[]>();
  const hitLocal = (key: string, limit: number, windowMs: number, now: number): LimitResult => {
    if (local.size > 50_000)
      for (const [k, v] of local) if ((v[v.length - 1] ?? 0) + windowMs <= now) local.delete(k);
    const log = (local.get(key) ?? []).filter((at) => at > now - windowMs);
    if (log.length < limit) {
      log.push(now);
      local.set(key, log);
      return { allowed: true, retryAfterMs: 0 };
    }
    local.set(key, log);
    return { allowed: false, retryAfterMs: Math.max(1, (log[0] ?? now) + windowMs - now) };
  };
  return {
    hit: async (key, limit, windowMs) => {
      try {
        if (redis.status !== 'ready') return hitLocal(key, limit, windowMs, Date.now());
        const [allowed, retry] = (await redis.eval(
          SLIDING_WINDOW_LUA,
          1,
          `rl:${key}`,
          limit,
          windowMs,
          randomUUID(),
        )) as [number, number];
        return { allowed: allowed === 1, retryAfterMs: retry };
      } catch {
        return hitLocal(key, limit, windowMs, Date.now());
      }
    },
  };
};
