import type { Pool } from '@auction/db';
import type { Timings } from '@auction/shared';
import type pg from 'pg';

/** A transaction handle. Every domain write runs inside one. */
export type Tx = pg.PoolClient;

/** The only way domain code reads the time, so tests can move it. */
export type Clock = { readonly now: () => Date };

export type Deps = {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly timings: Timings;
};

export type DomainEvent = {
  readonly lotId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type Notification = {
  readonly userId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

/**
 * Things to push to clients AFTER the transaction committed (socket events, in-app notifications).
 * They are also stored in Postgres inside the transaction, so a lost push is recovered by the
 * client catching up from the database.
 */
export type Effects = {
  readonly events: readonly DomainEvent[];
  readonly notifications: readonly Notification[];
};

export const NO_EFFECTS: Effects = { events: [], notifications: [] };

export const mergeEffects = (...all: readonly Effects[]): Effects => ({
  events: all.flatMap((e) => e.events),
  notifications: all.flatMap((e) => e.notifications),
});

/** What a mutating use case returns: the result for the caller and the effects to push. */
export type Outcome<T> = { readonly result: T; readonly effects: Effects };

export const systemClock: Clock = { now: () => new Date() };

/** A clock tests can move. Plain object with functions, no class. */
export type FakeClock = Clock & {
  readonly set: (value: Date | number) => void;
  readonly advance: (ms: number) => Date;
};

export const createFakeClock = (start: Date | number = Date.now()): FakeClock => {
  let current = typeof start === 'number' ? start : start.getTime();
  return {
    now: () => new Date(current),
    set: (value) => {
      current = typeof value === 'number' ? value : value.getTime();
    },
    advance: (ms) => {
      current += ms;
      return new Date(current);
    },
  };
};
