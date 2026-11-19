/** Deterministic UUIDs: a namespace (which table) plus a counter. Readable in test failures. */
export const NS = {
  user: 1,
  lot: 2,
  topup: 3,
  tx: 4,
  account: 5,
  payment: 6,
  deposit: 7,
  offer: 8,
  photo: 9,
  default: 10,
  event: 11,
} as const;

export const seedId = (ns: number, n: number): string =>
  `${ns.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Accounts: two per user (available, held), plus fixed ones. */
export const availableAccountId = (userIdx: number): string => seedId(NS.account, userIdx * 4);
export const heldAccountId = (userIdx: number): string => seedId(NS.account, userIdx * 4 + 1);
export const escrowAccountId = (lotIdx: number): string => seedId(NS.account, 100_000_000 + lotIdx);
export const EXTERNAL_ACCOUNT_ID = seedId(NS.account, 1);
export const COMMISSION_ACCOUNT_ID = seedId(NS.account, 2);
