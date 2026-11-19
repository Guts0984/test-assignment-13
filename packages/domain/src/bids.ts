import {
  bidStep,
  depositFor,
  maskName,
  placeBid as resolveBid,
  type BidKind,
  type BidRejection,
  type BidOutcome,
} from '@auction/shared';
import { idempotent } from './idempotency.js';
import { book, ensureWallet, lockBalances } from './ledger.js';
import {
  appendEvent,
  lockLot,
  maskedNames,
  notify,
  publicState,
  queueEmail,
  queueLotSync,
  requireTrader,
  toAuctionState,
} from './support.js';
import {
  NO_EFFECTS,
  type Deps,
  type DomainEvent,
  type Notification,
  type Outcome,
  type Tx,
} from './types.js';

export type PlaceBidInput = {
  readonly lotId: string;
  readonly userId: string;
  readonly kind: BidKind;
  /** Manual: the bid. Auto: the maximum. Kopecks. */
  readonly amount: number;
  readonly idempotencyKey: string;
};

export type BidAcceptedResult = {
  readonly ok: true;
  readonly outcome: BidOutcome;
  readonly currentPrice: number;
  readonly bidCount: number;
  readonly endsAt: string;
  readonly extended: boolean;
  readonly reserveMet: boolean | null;
  /** The caller's own maximum, if they lead; they are the only one who may see it. */
  readonly yourMax: number | null;
  readonly minNextBid: number;
};

export type BidRejectedResult = {
  readonly ok: false;
  readonly reason: BidRejection | 'INSUFFICIENT_FUNDS';
  readonly minNextBid: number;
};

export type PlaceBidResult = BidAcceptedResult | BidRejectedResult;

type HeldDeposit = { id: string; amount: number };

const heldDeposit = async (
  tx: Tx,
  lotId: string,
  userId: string,
): Promise<HeldDeposit | undefined> =>
  (
    await tx.query<HeldDeposit>(
      `SELECT id, amount FROM deposits WHERE lot_id = $1 AND user_id = $2 AND status = 'held'`,
      [lotId, userId],
    )
  ).rows[0];

/**
 * Places a bid or an autobid.
 *
 * One transaction, serialised per lot by the lot row lock:
 *   lock lot → engine decides → check and lock the money → write bids, deposits, ledger, lot,
 *   event, notifications, outbox → commit.
 * The deposit of an outbid participant is released in that same transaction.
 * A rejection is a normal result (stored under the idempotency key), not an exception.
 */
export const placeBid = (deps: Deps, input: PlaceBidInput) =>
  idempotent<PlaceBidResult>(
    deps,
    {
      userId: input.userId,
      scope: 'bid',
      key: input.idempotencyKey,
      body: { lotId: input.lotId, kind: input.kind, amount: input.amount },
    },
    async (tx): Promise<Outcome<PlaceBidResult>> => {
      const now = deps.clock.now();
      const lot = await lockLot(tx, input.lotId);
      await requireTrader(tx, input.userId);

      const decision = resolveBid(
        toAuctionState(lot),
        { userId: input.userId, kind: input.kind, amount: input.amount, now: now.getTime() },
        { antiSnipeMs: deps.timings.antiSnipeMs },
      );
      if (!decision.ok) {
        return {
          result: { ok: false, reason: decision.reason, minNextBid: decision.minNextBid },
          effects: NO_EFFECTS,
        };
      }

      const next = decision.state;
      const leadsNow = next.leader?.userId === input.userId;
      const displaced = decision.displacedLeader;

      // ---- money: lock every wallet account involved, in id order, then check ---------------
      const mine = await ensureWallet(tx, input.userId);
      const theirs = displaced ? await ensureWallet(tx, displaced.userId) : null;
      const balances = await lockBalances(tx, [
        mine.available,
        mine.held,
        ...(theirs ? [theirs.available, theirs.held] : []),
      ]);
      const available = balances.get(mine.available) ?? 0;

      const existing = await heldDeposit(tx, lot.id, input.userId);
      const targetDeposit = leadsNow ? depositFor(next.leader.maxBid) : 0;
      const extraToHold = leadsNow ? targetDeposit - (existing?.amount ?? 0) : 0;
      // Even when an autobid immediately outbids them, the bidder must be able to afford the
      // deposit for what they offered; nothing is locked in that case.
      const mustAfford = leadsNow ? extraToHold : depositFor(input.amount);
      if (available < mustAfford) {
        return {
          result: {
            ok: false,
            reason: 'INSUFFICIENT_FUNDS',
            minNextBid: decision.state.currentPrice,
          },
          effects: NO_EFFECTS,
        };
      }

      const seq = lot.event_seq + 1;
      const notifications: Notification[] = [];

      // ---- release the displaced leader's deposit, same transaction -------------------------
      if (displaced && theirs) {
        const old = await heldDeposit(tx, lot.id, displaced.userId);
        if (old) {
          await book(tx, {
            kind: 'release',
            ref: `release:${lot.id}:${displaced.userId}:${seq}`,
            lotId: lot.id,
            userId: displaced.userId,
            at: now,
            entries: [
              { account: theirs.held, amount: -old.amount },
              { account: theirs.available, amount: old.amount },
            ],
          });
          await tx.query(
            `UPDATE deposits SET status = 'released', resolved_at = $2 WHERE id = $1`,
            [old.id, now],
          );
        }
      }

      // ---- lock (or top up) the bidder's deposit --------------------------------------------
      if (leadsNow && extraToHold > 0) {
        await book(tx, {
          kind: 'hold',
          ref: `hold:${lot.id}:${input.userId}:${seq}`,
          lotId: lot.id,
          userId: input.userId,
          at: now,
          entries: [
            { account: mine.available, amount: -extraToHold },
            { account: mine.held, amount: extraToHold },
          ],
        });
        if (existing) {
          await tx.query('UPDATE deposits SET amount = $2 WHERE id = $1', [
            existing.id,
            targetDeposit,
          ]);
        } else {
          await tx.query(
            `INSERT INTO deposits (lot_id, user_id, amount, created_at) VALUES ($1, $2, $3, $4)`,
            [lot.id, input.userId, targetDeposit, now],
          );
        }
      }

      // ---- history rows ---------------------------------------------------------------------
      const history = decision.history;
      if (history.length > 0) {
        await tx.query(
          `INSERT INTO bids (lot_id, user_id, amount, is_auto, created_at)
           SELECT $1, u, a, f, $5 FROM unnest($2::uuid[], $3::bigint[], $4::boolean[]) WITH ORDINALITY AS t(u, a, f, ord)
           ORDER BY ord`,
          [
            lot.id,
            history.map((h) => h.userId),
            history.map((h) => h.amount),
            history.map((h) => h.isAuto),
            now,
          ],
        );
      }

      // ---- the lot itself -------------------------------------------------------------------
      const endsAt = new Date(next.endsAt);
      await tx.query(
        `UPDATE lots SET current_price = $2, bid_count = $3, leader_id = $4, leader_max = $5,
                ends_at = $6, event_seq = $7, version = version + 1, updated_at = $8
          WHERE id = $1`,
        [
          lot.id,
          next.currentPrice,
          next.bidCount,
          next.leader?.userId ?? null,
          next.leader?.maxBid ?? null,
          endsAt,
          seq,
          now,
        ],
      );

      // ---- event for everyone watching (public data only) -----------------------------------
      const names = await maskedNames(
        tx,
        history.map((h) => h.userId),
      );
      const pub = publicState({
        current_price: next.currentPrice,
        bid_count: next.bidCount,
        ends_at: endsAt,
        reserve_price: lot.reserve_price,
      });
      const event: DomainEvent = await appendEvent(
        tx,
        { id: lot.id, event_seq: lot.event_seq },
        1,
        'bid',
        {
          ...pub,
          extended: decision.extended,
          bids: history.map((h) => ({
            bidder: names.get(h.userId) ?? maskName('?'),
            amount: h.amount,
            isAuto: h.isAuto,
            at: now.toISOString(),
          })),
        },
        now,
      );

      // ---- tell the outbid participant (in-app now, email at most once per 15 min) -----------
      if (displaced) {
        notifications.push(
          await notify(
            tx,
            {
              userId: displaced.userId,
              kind: 'outbid',
              payload: { lotId: lot.id, title: lot.title, currentPrice: next.currentPrice },
            },
            now,
          ),
        );
        const allowed = await tx.query(
          `INSERT INTO outbid_email_state (user_id, lot_id, last_emailed_at) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, lot_id) DO UPDATE SET last_emailed_at = EXCLUDED.last_emailed_at
             WHERE outbid_email_state.last_emailed_at <= $3::timestamptz - make_interval(secs => $4::double precision)`,
          [displaced.userId, lot.id, now, deps.timings.outbidEmailThrottleMs / 1000],
        );
        if ((allowed.rowCount ?? 0) > 0) {
          await queueEmail(
            tx,
            {
              userId: displaced.userId,
              kind: 'outbid',
              dedupeKey: `outbid:${displaced.userId}:${lot.id}:${now.getTime()}`,
              payload: { lotId: lot.id, title: lot.title, currentPrice: next.currentPrice },
            },
            now,
          );
        }
      }

      await queueLotSync(tx, lot.id, now);
      return {
        result: {
          ok: true,
          outcome: decision.outcome,
          currentPrice: next.currentPrice,
          bidCount: next.bidCount,
          endsAt: endsAt.toISOString(),
          extended: decision.extended,
          reserveMet: pub.reserveMet,
          yourMax: leadsNow ? next.leader.maxBid : null,
          minNextBid: next.currentPrice + bidStep(next.currentPrice),
        },
        effects: { events: [event], notifications },
      };
    },
  );
