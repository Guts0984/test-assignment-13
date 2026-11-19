import { type Kopecks, MAX_AMOUNT_KOP } from '../money/money.js';
import { bidStep } from '../rules/rules.js';
import { type LotStatus } from '../lot/status.js';

/**
 * Pure proxy-bidding engine. No I/O, no clock: the caller passes `now` (server time) and runs
 * this inside a transaction that holds the lot row lock, so calls on one lot are strictly
 * sequential. The arrival order is therefore the time order, and "earlier wins ties" means
 * "the incumbent leader wins ties".
 *
 * Invariant kept by construction: only the leader's max can exceed the current price; every
 * other participant's max is ≤ the current price. That is why the state needs just the leader.
 */

export type BidKind = 'manual' | 'auto';

export type Leader = {
  readonly userId: string;
  readonly maxBid: Kopecks;
};

export type AuctionState = {
  readonly status: LotStatus;
  readonly sellerId: string;
  readonly startPrice: Kopecks;
  /** Hidden from everyone except the seller. `null` = no reserve. */
  readonly reservePrice: Kopecks | null;
  /** Visible price. Equals startPrice while bidCount is 0. */
  readonly currentPrice: Kopecks;
  readonly bidCount: number;
  readonly leader: Leader | null;
  /** Epoch milliseconds, server clock. */
  readonly endsAt: number;
};

export type BidRequest = {
  readonly userId: string;
  readonly kind: BidKind;
  /** Manual: the bid itself. Auto: the maximum the system may bid on the user's behalf. */
  readonly amount: Kopecks;
  /** Epoch milliseconds, server clock. */
  readonly now: number;
};

export type HistoryEntry = {
  readonly userId: string;
  readonly amount: Kopecks;
  /** True when the system placed it on the user's behalf (autobid). */
  readonly isAuto: boolean;
};

export type BidRejection =
  | 'LOT_NOT_ACTIVE'
  | 'LOT_ENDED'
  | 'OWN_LOT'
  | 'BID_INVALID_AMOUNT'
  | 'BID_TOO_LOW'
  | 'BID_NOT_ABOVE_OWN_MAX';

export type BidOutcome = 'leading' | 'outbid_by_autobid';

export type BidAccepted = {
  readonly ok: true;
  readonly outcome: BidOutcome;
  readonly state: AuctionState;
  /** Public history rows to append, in order. Empty for a silent max raise. */
  readonly history: readonly HistoryEntry[];
  /** The previous leader when the bidder took the lead from someone else. */
  readonly displacedLeader: Leader | null;
  /** The bidder was already leading and only raised their max. */
  readonly raisedOwnMax: boolean;
  /** Anti-sniping moved endsAt. */
  readonly extended: boolean;
};

export type BidRejected = {
  readonly ok: false;
  readonly reason: BidRejection;
  readonly minNextBid: Kopecks;
};

export type BidResolution = BidAccepted | BidRejected;

export type EngineOptions = {
  readonly antiSnipeMs: number;
};

/** The smallest acceptable bid (or autobid max) for a newcomer right now. */
export const minNextBid = (
  state: Pick<AuctionState, 'bidCount' | 'currentPrice' | 'startPrice'>,
) => (state.bidCount === 0 ? state.startPrice : state.currentPrice + bidStep(state.currentPrice));

/** Whether the reserve is met at the given price. No reserve = always met. */
export const isReserveMet = (
  state: Pick<AuctionState, 'reservePrice' | 'currentPrice' | 'bidCount'>,
) =>
  state.bidCount > 0 && (state.reservePrice === null || state.currentPrice >= state.reservePrice);

/** If the leader's max covers the reserve, the price is lifted to the reserve (never above the max). */
const applyReserveJump = (price: Kopecks, leaderMax: Kopecks, reserve: Kopecks | null): Kopecks =>
  reserve !== null && leaderMax >= reserve && price < reserve ? reserve : price;

const reject = (state: AuctionState, reason: BidRejection): BidRejected => ({
  ok: false,
  reason,
  minNextBid: minNextBid(state),
});

export const placeBid = (
  state: AuctionState,
  bid: BidRequest,
  options: EngineOptions,
): BidResolution => {
  if (state.status !== 'active') return reject(state, 'LOT_NOT_ACTIVE');
  if (bid.now >= state.endsAt) return reject(state, 'LOT_ENDED');
  if (bid.userId === state.sellerId) return reject(state, 'OWN_LOT');
  if (!Number.isSafeInteger(bid.amount) || bid.amount <= 0 || bid.amount > MAX_AMOUNT_KOP) {
    return reject(state, 'BID_INVALID_AMOUNT');
  }

  const minNext = minNextBid(state);
  const leader = state.leader;
  const isAuto = bid.kind === 'auto';

  const resolved = (():
    | (Omit<BidAccepted, 'ok' | 'extended' | 'state'> & {
        readonly price: Kopecks;
        readonly leader: Leader;
      })
    | BidRejection => {
    // Case A: first bid on the lot.
    if (leader === null) {
      if (bid.amount < minNext) return 'BID_TOO_LOW';
      const base = isAuto ? state.startPrice : bid.amount;
      const price = applyReserveJump(base, bid.amount, state.reservePrice);
      const newLeader = { userId: bid.userId, maxBid: bid.amount };
      return {
        outcome: 'leading',
        price,
        leader: newLeader,
        history: [{ userId: bid.userId, amount: price, isAuto }],
        displacedLeader: null,
        raisedOwnMax: false,
      };
    }

    // Case B: the leader raises their own max. The price does not move (except a reserve jump).
    if (leader.userId === bid.userId) {
      if (bid.amount <= leader.maxBid) return 'BID_NOT_ABOVE_OWN_MAX';
      if (bid.amount < minNext) return 'BID_TOO_LOW';
      const price = applyReserveJump(state.currentPrice, bid.amount, state.reservePrice);
      return {
        outcome: 'leading',
        price,
        leader: { userId: bid.userId, maxBid: bid.amount },
        history:
          price !== state.currentPrice ? [{ userId: bid.userId, amount: price, isAuto: true }] : [],
        displacedLeader: null,
        raisedOwnMax: true,
      };
    }

    if (bid.amount < minNext) return 'BID_TOO_LOW';

    // Case C: the newcomer beats the leader's max and takes the lead.
    if (bid.amount > leader.maxBid) {
      const base = isAuto
        ? Math.min(bid.amount, leader.maxBid + bidStep(leader.maxBid))
        : bid.amount;
      const price = applyReserveJump(base, bid.amount, state.reservePrice);
      const history: HistoryEntry[] = [];
      // The old leader's autobid had silently gone up to their max before being beaten.
      if (leader.maxBid > state.currentPrice) {
        history.push({ userId: leader.userId, amount: leader.maxBid, isAuto: true });
      }
      history.push({ userId: bid.userId, amount: price, isAuto });
      return {
        outcome: 'leading',
        price,
        leader: { userId: bid.userId, maxBid: bid.amount },
        history,
        displacedLeader: leader,
        raisedOwnMax: false,
      };
    }

    // Case D: the leader's autobid answers. Equal maxes → the earlier one (incumbent) keeps the lead.
    const counter = Math.min(leader.maxBid, bid.amount + bidStep(bid.amount));
    const price = applyReserveJump(counter, leader.maxBid, state.reservePrice);
    return {
      outcome: 'outbid_by_autobid',
      price,
      leader,
      history: [
        { userId: bid.userId, amount: bid.amount, isAuto },
        { userId: leader.userId, amount: price, isAuto: true },
      ],
      displacedLeader: null,
      raisedOwnMax: false,
    };
  })();

  if (typeof resolved === 'string') return reject(state, resolved);

  const extended = state.endsAt - bid.now < options.antiSnipeMs;
  const endsAt = extended ? bid.now + options.antiSnipeMs : state.endsAt;

  return {
    ok: true,
    outcome: resolved.outcome,
    history: resolved.history,
    displacedLeader: resolved.displacedLeader,
    raisedOwnMax: resolved.raisedOwnMax,
    extended,
    state: {
      ...state,
      currentPrice: resolved.price,
      leader: resolved.leader,
      bidCount: state.bidCount + resolved.history.length,
      endsAt,
    },
  };
};
