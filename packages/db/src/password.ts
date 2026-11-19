import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt from node:crypto (no native dependency to build in Docker).
 * Format: `scrypt$N$r$p$saltHex$hashHex`. Parameters are stored per hash so they can be raised
 * later without breaking old hashes.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LEN = 32;
/**
 * Ceiling for parameters read back from a stored hash. A hash comes from the database, so a
 * tampered row must not be able to make one login burn gigabytes and minutes of CPU.
 */
const MAX_PARAMS = { N: 2 ** 16, r: 8, p: 2 } as const;

const derive = (
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const options: ScryptOptions = {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: 128 * params.N * params.r * 2,
    };
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${key.toString('hex')}`;
};

/** Constant-time check. Any malformed stored hash is simply "no match", never an exception. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(R) ||
    !Number.isInteger(P) ||
    N < 2 ** 10 ||
    N > MAX_PARAMS.N ||
    (N & (N - 1)) !== 0 ||
    R < 1 ||
    R > MAX_PARAMS.r ||
    P < 1 ||
    P > MAX_PARAMS.p ||
    !saltHex ||
    !hashHex ||
    !/^[0-9a-f]+$/.test(saltHex) ||
    !/^[0-9a-f]+$/.test(hashHex)
  ) {
    return false;
  }
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await derive(password, Buffer.from(saltHex, 'hex'), { N, r: R, p: P });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
