import { randomUUID } from 'node:crypto';
import { DEFAULT_TIMINGS, type BidKind } from '@auction/shared';
import { newTestDb, type TestDb } from '@auction/test-kit';
import {
  createFakeClock,
  placeBid,
  type Deps,
  type FakeClock,
  type PlaceBidResult,
} from '../src/index.js';

export const T0 = Date.parse('2026-06-01T12:00:00Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const UAH = (n: number): number => Math.round(n * 100);

export type World = {
  readonly t: TestDb;
  readonly clock: FakeClock;
  readonly deps: Deps;
  close: () => Promise<void>;
};

export const newWorld = async (poolSize = 40): Promise<World> => {
  const t = await newTestDb(poolSize);
  const clock = createFakeClock(T0);
  const deps: Deps = { pool: t.pool, clock, timings: { ...DEFAULT_TIMINGS } };
  return { t, clock, deps, close: () => t.close() };
};

export const bid = async (
  deps: Deps,
  lotId: string,
  userId: string,
  amount: number,
  kind: BidKind = 'manual',
): Promise<PlaceBidResult> =>
  (await placeBid(deps, { lotId, userId, kind, amount, idempotencyKey: randomUUID() })).result;

export const accepted = (r: PlaceBidResult) => {
  if (!r.ok) throw new Error(`expected an accepted bid, got ${r.reason}`);
  return r;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
