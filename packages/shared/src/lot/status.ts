import { z } from 'zod';

export const LOT_STATUSES = [
  'draft',
  'in_review',
  'rejected',
  'active',
  'ended_unsold',
  'awaiting_payment',
  'paid',
  'shipped',
  'completed',
  'removed',
] as const;

export type LotStatus = (typeof LOT_STATUSES)[number];
export const lotStatusSchema = z.enum(LOT_STATUSES);

export const ROLES = ['user', 'moderator', 'finance'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

/** Who performs a transition. `seller`/`buyer` are a `user` in a relation to the lot. */
export type LotActor = 'seller' | 'buyer' | 'moderator' | 'system';

export type LotTransition = {
  readonly from: LotStatus;
  readonly to: LotStatus;
  readonly actor: LotActor;
  readonly action: LotAction;
};

export type LotAction =
  | 'submit'
  | 'revise'
  | 'approve'
  | 'reject'
  | 'buy_now'
  | 'close_sold'
  | 'close_unsold'
  | 'remove'
  | 'pay'
  | 'payment_expired_next_offer'
  | 'payment_expired_unsold'
  | 'ship'
  | 'confirm'
  | 'auto_confirm';

/**
 * The single source of truth for lot status transitions. The database repeats every check with
 * `UPDATE … WHERE status = <from>`, so a stale request can never apply a transition twice.
 */
export const LOT_TRANSITIONS: readonly LotTransition[] = [
  { from: 'draft', to: 'in_review', actor: 'seller', action: 'submit' },
  { from: 'rejected', to: 'draft', actor: 'seller', action: 'revise' },
  { from: 'in_review', to: 'active', actor: 'moderator', action: 'approve' },
  { from: 'in_review', to: 'rejected', actor: 'moderator', action: 'reject' },
  { from: 'active', to: 'awaiting_payment', actor: 'buyer', action: 'buy_now' },
  { from: 'active', to: 'awaiting_payment', actor: 'system', action: 'close_sold' },
  { from: 'active', to: 'ended_unsold', actor: 'system', action: 'close_unsold' },
  { from: 'active', to: 'removed', actor: 'moderator', action: 'remove' },
  { from: 'awaiting_payment', to: 'paid', actor: 'buyer', action: 'pay' },
  {
    from: 'awaiting_payment',
    to: 'awaiting_payment',
    actor: 'system',
    action: 'payment_expired_next_offer',
  },
  {
    from: 'awaiting_payment',
    to: 'ended_unsold',
    actor: 'system',
    action: 'payment_expired_unsold',
  },
  { from: 'paid', to: 'shipped', actor: 'seller', action: 'ship' },
  { from: 'shipped', to: 'completed', actor: 'buyer', action: 'confirm' },
  { from: 'shipped', to: 'completed', actor: 'system', action: 'auto_confirm' },
];

export const findTransition = (from: LotStatus, action: LotAction): LotTransition | undefined =>
  LOT_TRANSITIONS.find((t) => t.from === from && t.action === action);

export const canTransition = (from: LotStatus, action: LotAction, actor: LotActor): boolean =>
  findTransition(from, action)?.actor === actor;

/** Statuses in which the lot is visible to the public (catalog, lot page, sockets). */
export const PUBLIC_LOT_STATUSES: readonly LotStatus[] = [
  'active',
  'ended_unsold',
  'awaiting_payment',
  'paid',
  'shipped',
  'completed',
];

export const isPublicStatus = (status: LotStatus): boolean => PUBLIC_LOT_STATUSES.includes(status);

/** Terminal statuses: nothing can move the lot further. */
export const isTerminalStatus = (status: LotStatus): boolean =>
  !LOT_TRANSITIONS.some((t) => t.from === status && t.to !== status);

/** Field editing policy for the seller. */
export type LotEditPolicy = 'full' | 'append_description' | 'none';

export const lotEditPolicy = (status: LotStatus, bidCount: number): LotEditPolicy => {
  if (status === 'draft' || status === 'rejected') return 'full';
  if (status === 'active') return bidCount === 0 ? 'full' : 'append_description';
  return 'none';
};
