import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSeed, seedDatabase } from '../src/seed/index.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import { newTestDb, type TestDb } from './helpers.js';

const NOW = Date.parse('2026-06-01T12:00:00Z');
const SMALL = {
  users: 200,
  lots: 500,
  bids: 4000,
  rng: 13,
  now: NOW,
  passwordHash: 'x'.repeat(10),
};

describe('generator (pure, no database)', () => {
  it('is deterministic: same config, byte-identical output', () => {
    const a = JSON.stringify(generateSeed(SMALL));
    const b = JSON.stringify(generateSeed(SMALL));
    expect(a).toBe(b);
    expect(JSON.stringify(generateSeed({ ...SMALL, rng: 14 }))).not.toBe(a);
  });

  it('hits the requested counts exactly', () => {
    const d = generateSeed(SMALL);
    expect(d.users).toHaveLength(200);
    expect(d.lots).toHaveLength(500);
    expect(d.bids).toHaveLength(4000);
    expect(d.categories).toHaveLength(30);
    expect(d.cities).toHaveLength(15);
  });

  it('rejects configs it cannot honour instead of silently producing less', () => {
    expect(() => generateSeed({ ...SMALL, users: 10 })).toThrow(/SEED_USERS/);
    expect(() => generateSeed({ ...SMALL, lots: 5 })).toThrow(/SEED_LOTS/);
    expect(() => generateSeed({ ...SMALL, bids: 5 })).toThrow();
  });

  it('ids are unique per table', () => {
    const d = generateSeed(SMALL);
    for (const rows of [d.users, d.lots, d.accounts, d.topups, d.deposits, d.photos]) {
      const ids = rows.map((r) => r['id']);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('small seed loaded into a real database', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await newTestDb();
    const r = await seedDatabase(t.pool, { ...SMALL, password: 'Passw0rd!' });
    expect(r.seeded).toBe(true);
  });
  afterAll(async () => {
    await t.close();
  });

  it('loads without violating a single constraint or trigger, and the counts match', async () => {
    const count = async (sql: string) => (await t.pool.query<{ n: number }>(sql)).rows[0]!.n;
    expect(await count('SELECT count(*)::int AS n FROM users')).toBe(200);
    expect(await count('SELECT count(*)::int AS n FROM lots')).toBe(500);
    expect(await count('SELECT count(*)::int AS n FROM bids')).toBe(4000);
  });

  it('a second run changes nothing (idempotent)', async () => {
    const before = await t.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM bids');
    const again = await seedDatabase(t.pool, { ...SMALL, password: 'Passw0rd!' });
    expect(again).toEqual({ seeded: false, reason: 'already_seeded' });
    const after = await t.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM bids');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('two seeders racing on an empty database: one seeds, the other backs off, no duplicates', async () => {
    const fresh = await newTestDb();
    try {
      const results = await Promise.all([
        seedDatabase(fresh.pool, { ...SMALL, password: 'Passw0rd!' }),
        seedDatabase(fresh.pool, { ...SMALL, password: 'Passw0rd!' }),
        seedDatabase(fresh.pool, { ...SMALL, password: 'Passw0rd!' }),
      ]);
      expect(results.filter((r) => r.seeded)).toHaveLength(1);
      const n = await fresh.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      expect(n.rows[0]?.n).toBe(200);
    } finally {
      await fresh.close();
    }
  });

  it('a failing seed leaves the database empty (all-or-nothing)', async () => {
    const fresh = await newTestDb();
    try {
      // Make the very last step fail: occupy the marker key with a poisoned trigger.
      await fresh.pool.query(`
        CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$;
        CREATE TRIGGER boom_trigger BEFORE INSERT ON lot_audit FOR EACH ROW EXECUTE FUNCTION boom();`);
      await expect(seedDatabase(fresh.pool, { ...SMALL, password: 'Passw0rd!' })).rejects.toThrow(
        /boom/,
      );
      const n = await fresh.pool.query(
        'SELECT (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM settings)::int AS s',
      );
      expect(n.rows[0]).toEqual({ u: 0, s: 0 });
    } finally {
      await fresh.close();
    }
  });
});

describe('password hashing', () => {
  it('verifies the right password, rejects the wrong one, and never throws on garbage', async () => {
    const hash = await hashPassword('Passw0rd!');
    expect(await verifyPassword('Passw0rd!', hash)).toBe(true);
    expect(await verifyPassword('passw0rd!', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
    for (const junk of [
      '',
      'x',
      'scrypt$1$1$1$a$b',
      'scrypt$32768$8$1$zz$zz',
      'scrypt$99999999999$8$1$aa$bb',
      'bcrypt$a$b$c$d$e',
      `${hash}$extra`,
      'scrypt$32768$8$1$$',
    ]) {
      expect(await verifyPassword('Passw0rd!', junk), junk).toBe(false);
    }
  });

  it('salts: the same password hashes differently each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('refuses hashes with absurd cost parameters (a stored hash cannot DoS the server)', async () => {
    const started = Date.now();
    expect(await verifyPassword('x', 'scrypt$1048576$32$16$aa$bb')).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
