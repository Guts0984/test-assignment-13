# Online auction for used goods

A marketplace where private sellers auction used items. Buyers search, top up a wallet, bid or
set autobids, and pay for what they win. Moderators review lots; finance sees turnover and
reconciles money.

> Work in progress. The build plan is in [plan.md](plan.md); this README grows with each block.

## Repository

| Path                | What                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared`   | Zod input schemas, rule constants and pure rules: money, bid step, deposit, commission, the proxy-bid engine, the lot status machine, error codes, env helpers                                                                 |
| `packages/domain`   | Every business operation as a plain function `(deps, input) → result`: bids, buy-now, closing, payment, second chance, shipping, payout, moderation, top-ups, reconciliation, reports, the sweeper. Used by `api` and `worker` |
| `packages/test-kit` | Test harness: a migrated template database cloned per test file, raw-SQL fixtures                                                                                                                                              |
| `packages/db`       | PostgreSQL: SQL migrations (tables, constraints, triggers, indexes), Drizzle schema, migration runner, restricted app role, seed, `db-init` Dockerfile                                                                         |

## Development

Requirements: Node 24, pnpm 12, Docker with Compose v2.

```bash
pnpm install
docker compose -f docker-compose.test.yml up -d --wait   # throw-away Postgres for the tests (port 55432)
pnpm check       # format check, lint, typecheck, tests
```

Run only the database stack, with the full seed (about two minutes the first time):

```bash
cp .env.example .env
docker compose up --build db-init      # postgres + migrations + app role + seed
```

### Demo logins (every password is `Passw0rd!`)

| Role      | Logins                                         |
| --------- | ---------------------------------------------- |
| Buyer     | `buyer1@seed.test` … `buyer5@seed.test`        |
| Seller    | `seller1@seed.test` … `seller5@seed.test`      |
| Moderator | `moderator1@seed.test`, `moderator2@seed.test` |
| Finance   | `finance1@seed.test`                           |

The demo buyers have more than 500 000 ₴ in their wallet. The other 9 987 users are
`user<N>@seed.test`.

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

## How bids, locks and transactions work (`packages/domain`)

Every use case is a function that takes `deps` (`pool`, `clock`, `timings`) and returns its result
plus the **effects** to push to clients after commit (socket events, in-app notifications). The
same effects are stored in Postgres inside the transaction, so a lost push is recovered by the
client catching up from the database.

**One lock per lot.** Anything that changes a lot (bid, buy now, close, pay, expire, remove, edit)
starts with `SELECT … FROM lots WHERE id = $1 FOR UPDATE`. That serialises everything on one lot,
so 50 simultaneous bids are processed one after another in lock order and the pure engine always
sees the state the previous bid left. Different lots proceed in parallel.

`placeBid` in one transaction:

1. advisory lock on `(user, 'bid', Idempotency-Key)` → replay the stored result if there is one;
2. lock the lot; read the **server clock**; the engine decides (end time, minimum bid, own lot,
   autobid maths, anti-sniping);
3. lock the wallet accounts involved **in id order** and check the money (so "available is never
   negative" is exact, not optimistic);
4. release the displaced leader's deposit, lock or top up the bidder's deposit (ledger, in the
   same transaction);
5. insert the history rows, update the lot, write the numbered event, the outbid notification, the
   throttled email and the search-sync outbox row;
6. store the result under the idempotency key; commit.

**Lock order, so nothing deadlocks:** lot → wallet accounts (ascending id) → rows hanging off them.
Ledger entries are inserted in ascending account order too. A deadlock or serialisation failure
still rolls back and retries the use case (up to four times); use cases are written to be safe to
repeat. The fuzz test would show a deadlock as a failure.

**Time is never taken from a job or a client.** Closing, payment expiry and auto-confirm compare
the lot's own deadline with the server clock under the lot lock. So a stale job (the lot was
extended after it was queued) does nothing, a duplicate job does nothing, and a bid one second
after the end is refused even if no worker has closed the lot yet.

**Money is only moved through `book()`** (`ledger.ts`), which creates accounts on demand, merges
and sorts entries and writes one balanced transaction with a unique `ref`.

**The sweeper is the real timer.** `runSweep` asks Postgres what is due (lots to close, payments
to expire, shipments to auto-confirm, abandoned moderation claims) and runs the same idempotent
handlers. BullMQ jobs, added later, are only an optimisation that runs them sooner; if Redis
loses every job, the next sweep finds the same work.

**Idempotency** (`Idempotency-Key`) covers bids, buy-now, payment and top-ups. The result is
stored in the same transaction as the writes. Same key and body → the stored result, no new
effects. Same key, different body → `IDEMPOTENCY_KEY_REUSED`. A rejection (`BID_TOO_LOW`) is a
result too and replays. Parallel retries queue on the advisory lock, so only one runs.

**Second chance.** When the payment (or offer) deadline passes: the deposit of the current buyer
goes to the seller, a default is recorded, and the lot is offered for 24 hours to the participant
with the next-highest maximum who has not been offered or defaulted yet, at that maximum. The lot
stays `awaiting_payment` for that one user (a unique index allows one pending offer per lot), so
nobody else can buy it. Nobody left → `ended_unsold`.

**Moderation.** `claimNextLot` takes the oldest unclaimed lot with `FOR UPDATE SKIP LOCKED`:
concurrent moderators skip each other's rows instead of waiting. A claim expires after 15
minutes; after that the lot is claimable again and the slow moderator's decision is refused
(`REVIEW_CLAIM_LOST`).

## API (`apps/api`)

REST + OpenAPI (`/docs`, generated into `apps/api/openapi.json` by `pnpm --filter @auction/api openapi:generate`) + Socket.IO over the Redis adapter. Every route must declare a policy (`@Public`, `@Optional`, `@Roles(...)`); a route without one answers 403 to everyone. Errors always look like `{ error: { code, message, details?, meta? }, requestId }`. State-changing requests need the `X-Requested-With: auction-web` header and a same-site Origin (CSRF); login is rate limited per address and locks an account after 5 failures; limits count the real client address and fall back to memory if Redis is down. Sockets authenticate from the session cookie at the handshake and can only ever join their own `user:` room.

## Worker, Redis, search, photos, mail (`apps/worker`, `packages/platform`)

| Store       | Holds                                                                                                  | If lost                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres    | everything that matters, including every deadline                                                      | n/a                                                                                                                                                                         |
| Redis       | BullMQ jobs, socket pub/sub                                                                            | **nothing is lost.** The worker's scheduler asks Postgres what is due every second and re-queues it with a deterministic job id; handlers re-check by lock and server clock |
| Meilisearch | read-only projection of ACTIVE lots, built from an explicit column list that never selects the reserve | the `outbox` table keeps unprocessed rows; `pnpm --filter @auction/worker reindex` rebuilds into a new index and swaps it in atomically                                     |
| MinIO       | `photos-private` (raw uploads, processed copies), `photos-public` (copies of approved lots only)       | photo rows are in Postgres; the pipeline is re-runnable                                                                                                                     |

- **Search sync:** the domain writes an `outbox` row in the same transaction as every lot change. Workers claim rows with `FOR UPDATE SKIP LOCKED`, sync from the CURRENT row (so duplicates and reordering converge) and mark them done only after Meilisearch accepted the change. Meilisearch down → rows wait, search answers `503 SEARCH_UNAVAILABLE`, bidding and the lot page keep working.
- **Photos:** the browser POSTs straight to MinIO with a presigned policy that pins this key, this Content-Type and exactly this size, so MinIO itself refuses anything else. The worker sniffs the real format, rejects decompression bombs, decodes and **re-encodes** (EXIF, GPS, XMP and trailing payloads do not survive), applies orientation, makes a 400 px WebP preview and deletes the raw upload. Public copies exist only while the lot is public.
- **Email:** `email_log` has a unique `dedupe_key`; rows are sent under `FOR UPDATE SKIP LOCKED`, so any number of workers send each at most once. The only duplicate window is a crash between SMTP "250 OK" and the status update.
- **Payment stub** (`packages/payment-stub`): HMAC-SHA256 over `timestamp.body`, 5-minute replay window, constant-time compare; chaos mode makes webhooks duplicate, late, contradicting (`failed` after `succeeded`) or lost. A receiver must re-fetch the authoritative status; the worker's reconciler finds lost ones every minute.
- Run several workers with `docker compose up --scale worker=3`.
- MinIO: the official `minio/minio` image is no longer on Docker Hub, so compose uses the community build `pgsty/minio` (override with `MINIO_IMAGE`).

## Database (`packages/db`)

PostgreSQL is the only source of truth. Rules that must never be broken live in the database as
CHECKs, unique indexes and triggers, not only in application code, so a bug in the API cannot
corrupt money or lot state. Every one of them has a test that attacks it with raw SQL.

### Roles: who may do what

| Role                    | Used by                        | Can                                                                                                                                                         |
| ----------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER` (owner) | `db-init` only (migrate, seed) | everything                                                                                                                                                  |
| `APP_DB_USER`           | `api`, `worker`                | SELECT / INSERT / UPDATE; DELETE only on sessions, idempotency keys, favourites, photos, notifications, outbox. No DDL, no TRUNCATE, cannot touch triggers. |

This matters: a superuser can switch every trigger off with `SET session_replication_role =
replica`. The application never connects as one, and a test proves the restricted role is denied
that and about a dozen similar attacks.

### Money: double-entry ledger

Money is `bigint` kopecks. `ledger_transactions` (header, unique `ref`) and `ledger_entries`
(`account_id`, signed `amount`). The database enforces:

- the entries of every transaction **sum to zero** and there are at least two (a deferred
  constraint trigger, checked at COMMIT: a half-written transaction cannot commit);
- entries and transactions are **append-only** (UPDATE, DELETE and TRUNCATE are refused);
- `accounts.balance` is **derived**: only the entry trigger can change it, never a direct UPDATE;
- user wallets, held money and escrow can **never go below zero** (`CHECK balance >= 0`). When
  two transactions race for one balance, the second waits on the row lock and is then checked
  against the new balance, so "money for 3 deposits, 10 attempts" lets exactly 3 through;
- `ledger_transactions.ref` is unique (`topup:<id>`, `hold:<lot>:<user>` …), so the same business
  event can never be booked twice, whatever a webhook does;
- only ordinary users own wallets: moderators and finance cannot have an account.

Lock order matters: a transaction that touches several accounts must insert its entries in a
fixed order (sorted by account id). The tests show that sorted order never deadlocks and that
inverted order does, in which case Postgres aborts one transaction with `40P01`.

| Account                     | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `external:payment_provider` | the outside world; goes negative by the sum of all top-ups |
| `user:<id>:available`       | spendable balance                                          |
| `user:<id>:held`            | deposits locked on live bids                               |
| `escrow:<lot id>`           | the buyer's payment, held until delivery is confirmed      |
| `platform:commission`       | the platform's revenue                                     |

| Operation                 | Entries (kopecks)                                 |
| ------------------------- | ------------------------------------------------- |
| Top-up X                  | external −X, available +X                         |
| Bid or raise (deposit D)  | available −D, held +D                             |
| Outbid / unsold / removed | held −D, available +D                             |
| Pay price P (deposit D)   | held −D, available −(P−D), escrow +P              |
| Non-payment               | buyer held −D, seller available +D                |
| Payout (commission C)     | escrow −P, seller available +(P−C), commission +C |

Seeded data books each sale as its net effect in one transaction instead of replaying every
hold and release, and still reconciles exactly (a test checks it).

### Lot status transitions

The pairs are in `LOT_TRANSITIONS` (`@auction/shared`) and again in SQL (`lot_transition_allowed`);
a test compares the two exhaustively (10 × 10 pairs). The database refuses any other change.

| From → To                               | Who            | Action                              |
| --------------------------------------- | -------------- | ----------------------------------- |
| `draft` → `in_review`                   | seller         | submit                              |
| `rejected` → `draft`                    | seller         | revise                              |
| `in_review` → `active`                  | moderator      | approve                             |
| `in_review` → `rejected`                | moderator      | reject (reason required)            |
| `active` → `awaiting_payment`           | buyer / system | buy now / close with a winner       |
| `active` → `ended_unsold`               | system         | no bids, or reserve not met         |
| `active` → `removed`                    | moderator      | remove (reason required)            |
| `awaiting_payment` → `paid`             | buyer          | pay                                 |
| `awaiting_payment` → `awaiting_payment` | system         | non-payment, offer to the next      |
| `awaiting_payment` → `ended_unsold`     | system         | nobody left to offer                |
| `paid` → `shipped`                      | seller         | ship (tracking number required)     |
| `shipped` → `completed`                 | buyer / system | confirm / auto-confirm after 7 days |

Each status also promises fields (an `active` lot has a clock; `awaiting_payment` has a buyer, a
price and a deadline; `shipped` has a tracking number; `rejected` and `removed` have a reason),
and the database refuses a lot that is in a status without them.

### Constraints that carry business rules

| Rule                                                                     | How it is enforced                                                           |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Price only grows, bids only grow, end only extends (after the first bid) | trigger `lots_guard`                                                         |
| After the first bid, only appending to the description                   | the same trigger compares every other field with its old value               |
| A sold lot keeps its buyer, price and commission                         | the same trigger                                                             |
| Seller never bids on, leads or buys their own lot                        | CHECKs on `lots`, trigger on `bids`                                          |
| Staff never sell, bid, buy or hold money                                 | role triggers on `lots`, `bids`, `accounts`; only moderators can claim a lot |
| Bid history never goes backwards; bids are never edited                  | trigger on `bids` (only `annulled_at` may be set, once)                      |
| At most 10 photos per lot                                                | `position` is 0–9 and unique per lot                                         |
| Photo is JPEG/PNG/WebP, ≤ 10 MB                                          | CHECKs on `lot_photos`                                                       |
| One live deposit per participant per lot                                 | partial unique index `deposits (lot_id, user_id) WHERE status = 'held'`      |
| One second-chance offer at a time, nobody offered twice                  | partial unique index on pending offers, unique `(lot_id, user_id)`           |
| A top-up settles once; a late webhook cannot flip it                     | trigger `settle_once` (also on the provider's own payments)                  |
| One provider payment backs one top-up                                    | partial unique index on `provider_payment_id`                                |
| One email per dedupe key                                                 | unique `email_log.dedupe_key`                                                |
| One result per idempotency key                                           | primary key `(user_id, scope, key)`                                          |
| Lot events are numbered 1, 2, 3 … without gaps; append-only              | trigger `lot_events_gapless`, primary key `(lot_id, seq)`                    |
| Lots are never deleted                                                   | trigger; they change status instead                                          |

### Indexes (each one exists for a specific query, and a test runs `EXPLAIN` on it)

| Index                                                                                                                 | Query it serves                 |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `bids (lot_id, id DESC)`                                                                                              | lot page: latest bids           |
| `bids (user_id, id DESC)`                                                                                             | "my bids"                       |
| `lots (ends_at) WHERE status = 'active'`                                                                              | closing, sweeper, "ending soon" |
| `lots (leader_id) WHERE status = 'active'`                                                                            | lots I am leading               |
| `lots (seller_id, status, created_at DESC)`                                                                           | seller dashboard                |
| `lots (buyer_id, status)`                                                                                             | lots I won                      |
| `lots (created_at, id) WHERE in_review AND unclaimed`                                                                 | moderation queue, oldest first  |
| `lots (claim_expires_at) WHERE in_review AND claimed`                                                                 | claims abandoned for 15 minutes |
| `lots (payment_due_at) WHERE awaiting_payment`                                                                        | overdue payments                |
| `lots (shipped_at) WHERE shipped`                                                                                     | auto-confirm after 7 days       |
| `lots (paid_at) INCLUDE (category_id, final_price, commission)`                                                       | 90-day finance report           |
| `ledger_entries (account_id, id DESC)`                                                                                | wallet history                  |
| `outbox (id) WHERE processed_at IS NULL`, `email_log (created_at) WHERE pending`, `topups (created_at) WHERE pending` | workers' queues                 |

### Measured on the full seed (50 000 lots, 500 000 bids, in the test run)

Lot page (lot row + latest 50 bids with names) and wallet history take a few milliseconds; the
90-day finance report takes a few tens of milliseconds, against budgets of 200 ms and 500 ms. The
tests fail if a budget is exceeded or if the planner stops using an index listed above.

### Seed

`docker compose up` runs `db-init`: migrations, the restricted role, then the seed, once (a
marker row makes later runs no-ops; concurrent runs queue on an advisory lock). The seed is one
transaction, so a failure leaves an empty database. It is deterministic (`SEED_RNG`).

Bid histories are produced by running the **real bid engine** from `@auction/shared`, so every
seeded lot is a state the engine could actually have reached. Placeholder photo rows point at
`seed/p0` … `seed/p59` objects, which the worker uploads to MinIO at start-up.

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
5. **Password hashing is scrypt** (`node:crypto`), not argon2: no native module to compile in
   Docker, and OWASP lists scrypt (N=2^15, r=8, p=1) as acceptable. Parameters are stored in each
   hash; parameters read back from the database are capped so a tampered row cannot make a login
   burn gigabytes of memory.
6. **Migrations are plain SQL** run by a small runner (checksums, advisory lock, one transaction
   per file) instead of generated ones, because triggers and partial indexes are the point.
   Editing an applied migration is an error. The Drizzle schema mirrors them, and a test compares
   the two column by column.
7. **The application never connects as the owner** (see "Roles"), so database guarantees cannot
   be switched off by application code or by anyone who steals its credentials.
8. **Before the first bid the seller can still change prices and duration**, so the price and end
   time are allowed to move either way until then. From the first bid on, they only move forward.
9. **Reserve price: what becomes visible.** Before the reserve is met, nothing in the API, events or
   notifications can reveal it (tests scan every output for the amount). The public view only says
   `reserveMet: true | false`. Because the price jumps to the reserve when a bid covers it (decision
   1), the _price_ equals the reserve at the moment it is met; that is inherent to selling at the
   reserve and is the only way it can be inferred.
10. **A second-chance offeree pays from the wallet, no deposit.** Their earlier deposit was released
    when they were outbid. Ignoring the offer costs nothing, but it is recorded as an unpaid win,
    so it counts in the finance report.
11. **Staff cannot trade.** Moderators and finance cannot bid, sell, buy, own a wallet or top up
    (a domain error, and also refused by the database).
12. **A bid that is accepted but immediately outbid by an autobid** locks no deposit, but the bidder
    must be able to afford the deposit for what they offered, otherwise it is `INSUFFICIENT_FUNDS`.
13. **Reports.** Turnover and commission are for lots _paid_ in the period (UTC dates). Commission is
    computed with the payout formula, so it includes sales not yet paid out. "Unpaid share" =
    payment defaults ÷ (winners + second-chance offers) in the period.
