import { describe, expect, it } from 'vitest';
import { loadDbEnv } from '../src/env.js';

const URL = 'postgres://u:p@h:5432/db';

describe('db env', () => {
  it('fills non-sensitive defaults and leaves nothing else to configure', () => {
    const env = loadDbEnv({ DATABASE_ADMIN_URL: URL });
    expect(env).toMatchObject({
      SEED_ENABLED: true,
      SEED_USERS: 10_000,
      SEED_LOTS: 50_000,
      SEED_BIDS: 500_000,
      SEED_RNG: 13,
    });
  });

  it('has no default for the connection URL', () => {
    expect(() => loadDbEnv({})).toThrow(/DATABASE_ADMIN_URL/);
  });

  it('rejects non-postgres URLs and never echoes the value (it contains a password)', () => {
    let message = '';
    try {
      loadDbEnv({ DATABASE_ADMIN_URL: 'mysql://root:hunter2@h/db' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('DATABASE_ADMIN_URL');
    expect(message).not.toContain('hunter2');
  });

  it.each([
    ['SEED_USERS', '0'],
    ['SEED_LOTS', '-5'],
    ['SEED_BIDS', 'many'],
    ['SEED_ENABLED', 'maybe'],
    ['SEED_PASSWORD', 'short'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => loadDbEnv({ DATABASE_ADMIN_URL: URL, [key]: value })).toThrow(new RegExp(key));
  });

  it('can switch the seed off', () => {
    expect(loadDbEnv({ DATABASE_ADMIN_URL: URL, SEED_ENABLED: 'false' }).SEED_ENABLED).toBe(false);
  });
});
