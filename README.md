# Online auction for used goods

A marketplace where private sellers auction used items. Buyers search, top up a wallet, bid or
set autobids, and pay for what they win. Moderators review lots; finance sees turnover and
reconciles money.

> Work in progress. The build plan is in [plan.md](plan.md); this README grows with each block.

## Repository

| Path              | What                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | Zod input schemas, rule constants and pure rules: money, bid step, deposit, commission, the proxy-bid engine, the lot status machine, error codes, env helpers |

## Development

Requirements: Node 24, pnpm 12, Docker with Compose v2.

```bash
pnpm install
pnpm check       # format check, lint, typecheck, tests
```

## Rules as implemented

### Money

Hryvnia in kopecks, integers everywhere (`MAX_AMOUNT_KOP` = 100 000 000 ₴ keeps every product
below 2^53). Display uses `Intl.NumberFormat`: `uk` → `1 234,50 ₴`, `en` → `₴1,234.50`,
`pl` → `1234,50 ₴` (Polish does not group four-digit numbers).

### Bidding

The engine (`packages/shared/src/auction/engine.ts`) is a pure function
`placeBid(state, bid, { antiSnipeMs })`. It runs inside a transaction that holds the lot row lock,
so the arrival order is the time order.

- **Minimum bid:** the start price for the first bid, then `price + step(price)`.
- **Manual bid X:** if X beats every other max, the price becomes exactly X. Otherwise the
  leader's autobid answers with `min(leaderMax, X + step(X))`.
- **Autobid M:** the price becomes `min(M, secondMax + step(secondMax))`. On equal maxes, the
  earlier bid leads.
- **Leader raising their own max:** silent. The price doesn't move and no public row is added.
- **Anti-sniping:** an accepted bid with less than 2 minutes left sets `endsAt = now + 2 min`.

Only the leader's max can exceed the current price, so the state needs nothing but the leader.

**Order independence.** For autobids, the final price and leader follow the formula over the
bids that were accepted, in every arrival order. A property test checks every permutation of up
to 5 bidders. A bid can still be rejected in one order and not another (BID_TOO_LOW once the
price has passed it). That is the minimum-increment rule doing its job, not order dependence.

## Decisions

1. **Reserve price.** When the leader's max covers the hidden reserve but the computed price is
   below it, the price jumps to the reserve and the lot shows "reserve met". It still sells only
   at the end of the auction, and anyone may outbid until then. Without this, a single bidder
   willing to pay the reserve would lose the lot.
2. **Deposit rounding.** 10% of the max bid is rounded **up** to a kopeck, with a minimum of
   50 ₴. **Commission** is 5% rounded **down** (in the seller's favour), with a minimum of 10 ₴
   capped at the sale price.
3. **Leader raises.** A bid by the current leader always raises their max. It must be above the
   old max and at least the minimum next bid.
4. **Ties in history.** When a challenger's autobid equals the leader's max, history shows the
   challenger's row and the leader's answering row at the same amount. The price still rose
   compared to before the bid.
