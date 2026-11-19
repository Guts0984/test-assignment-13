import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { infra } from '@auction/test-kit';
import { createRedis, type Redis } from '@auction/platform';
import { createRateLimiter } from '../src/common/ratelimit.js';

const redis = createRedis(`${infra.redisUrl}/5`, 'rl-test');
afterAll(() => {
  redis.disconnect();
});
const ready = async (r: Redis) => {
  for (let i = 0; i < 50 && r.status !== 'ready'; i++) await new Promise((x) => setTimeout(x, 100));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('sliding-window rate limiter', () => {
  it('a burst straddling a window boundary does not get 2x the limit', async () => {
    await ready(redis);
    const rl = createRateLimiter(redis);
    const key = randomUUID();
    const first = await Promise.all(Array.from({ length: 5 }, () => rl.hit(key, 5, 1000)));
    expect(first.every((r) => r.allowed)).toBe(true);
    await sleep(600); // a fixed window would very likely have rolled over for some of these
    const mid = await Promise.all(Array.from({ length: 5 }, () => rl.hit(key, 5, 1000)));
    expect(mid.filter((r) => r.allowed)).toHaveLength(0);
    expect(mid[0]!.retryAfterMs).toBeGreaterThan(0);
    expect(mid[0]!.retryAfterMs).toBeLessThanOrEqual(1000);
    await sleep(500); // the first burst has now left the window
    expect((await rl.hit(key, 5, 1000)).allowed).toBe(true);
  });

  it('is atomic: 50 parallel hits against a limit of 10 let exactly 10 through, from two limiter instances', async () => {
    await ready(redis);
    const other = createRedis(`${infra.redisUrl}/5`, 'rl-test-2');
    try {
      await ready(other);
      const a = createRateLimiter(redis);
      const b = createRateLimiter(other);
      const key = randomUUID();
      const res = await Promise.all(
        Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).hit(key, 10, 5000)),
      );
      expect(res.filter((r) => r.allowed)).toHaveLength(10);
    } finally {
      other.disconnect();
    }
  });

  it('separate keys do not share a budget', async () => {
    await ready(redis);
    const rl = createRateLimiter(redis);
    const [k1, k2] = [randomUUID(), randomUUID()];
    expect((await rl.hit(k1, 1, 1000)).allowed).toBe(true);
    expect((await rl.hit(k1, 1, 1000)).allowed).toBe(false);
    expect((await rl.hit(k2, 1, 1000)).allowed).toBe(true);
  });

  it('falls back to the same sliding algorithm in memory when Redis is not ready', async () => {
    const down = { status: 'end' } as unknown as Redis;
    const rl = createRateLimiter(down);
    const key = randomUUID();
    const first = await Promise.all(Array.from({ length: 3 }, () => rl.hit(key, 3, 800)));
    expect(first.every((r) => r.allowed)).toBe(true);
    await sleep(400);
    expect((await rl.hit(key, 3, 800)).allowed).toBe(false);
    await sleep(500);
    expect((await rl.hit(key, 3, 800)).allowed).toBe(true);
  });

  it('falls back when a Redis command throws', async () => {
    const broken = {
      status: 'ready',
      eval: () => Promise.reject(new Error('connection lost')),
    } as unknown as Redis;
    const rl = createRateLimiter(broken);
    const key = randomUUID();
    expect((await rl.hit(key, 1, 1000)).allowed).toBe(true);
    expect((await rl.hit(key, 1, 1000)).allowed).toBe(false);
  });
});
