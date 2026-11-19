/** Deterministic PRNG (mulberry32), so the same SEED_RNG always yields the same data. */
export type Rng = {
  readonly next: () => number;
  readonly int: (min: number, max: number) => number;
  readonly chance: (p: number) => boolean;
  readonly pick: <T>(items: readonly T[]) => T;
  readonly shuffle: <T>(items: readonly T[]) => T[];
};

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (items) => {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new Error('pick() from an empty list');
      return item;
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        const a = out[i] as (typeof out)[number];
        out[i] = out[j] as (typeof out)[number];
        out[j] = a;
      }
      return out;
    },
  };
};
