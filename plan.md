# Plan — online auction for used goods (test assignment 13)

The assignment is the source of truth. When it conflicts with this plan or with a style preference, the assignment wins.
Anything ambiguous gets decided here, and the decision is copied into the README under "Decisions".

---

## 0. Working rules

| Rule                                 | How it shows up in the code                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classes only where NestJS needs them | Modules, controllers, gateways, guards, interceptors, filters, providers, `createZodDto` DTOs. Everything else is plain functions and data: domain logic, the bid engine, the ledger, queries, workers' handlers, web, tests. Nest providers are thin wrappers that call functional code.                                                                                                             |
| Frontend uses Feature-Sliced Design  | `apps/web/src/{app,views,widgets,features,entities,shared}`. The FSD "pages" layer is named `views` so it doesn't clash with Next's `app/` router. Next's `app/` directory only holds route files that re-export from `views`. Boundaries are enforced by `steiger` (the FSD linter) in CI.                                                                                                           |
| Modular blocks, tested end to end    | Each block ships its schema/code, Dockerfile or compose service, env vars, seed/fixtures, tests and CI job together. Once a block is green, a later bug can't be in that block unless its own tests missed a case, and that case then gets added to that block's tests.                                                                                                                               |
| Tests try to break things            | Every block has a **hostile** test section: concurrency storms, crashes and restarts, lost Redis, forged input, malicious users against a running server. A test that can't fail is deleted.                                                                                                                                                                                                          |
| Commits = whole blocks               | About 8 commits, one per block (§6). Each commit builds, lints, typechecks and passes its tests and CI on its own. I commit locally; you push.                                                                                                                                                                                                                                                        |
| Env                                  | `.env.example` lists every variable with a comment. Each block adds its own section. Every process (`api`, `worker`, `db` scripts, `web`) has an `env.ts` that parses `process.env` with Zod: defaults for non-sensitive values, **required with no default** for secrets. `cp .env.example .env` works as-is because the example holds dev-only placeholder secrets that are clearly marked as such. |
| No `any`, no `@ts-ignore`            | ESLint: `no-explicit-any: error`. `ban-ts-comment` allows only `@ts-expect-error` with a description.                                                                                                                                                                                                                                                                                                 |

---

## 1. Repository layout

```
apps/
  api/        NestJS: REST + OpenAPI + Socket.IO; payment stub HTTP (page, status API)
  worker/     NestJS standalone: BullMQ processors, Postgres sweeper, search sync, sharp, mail, webhook sender
  web/        Next.js 15 (App Router), React 19, FSD
packages/
  shared/     Zod schemas, rule constants, pure rules (bid step, deposit, commission, proxy-bid engine,
              status machine, masking, money), error codes. Browser-safe, no I/O.
  db/         Drizzle schema, SQL migrations (constraints, triggers), client factory, migrate + seed CLI,
              Dockerfile for the one-shot `db-init` container
  domain/     Server-side use cases as functions: (deps, input) => Result. Ledger postings, placeBid,
              buyNow, closeLot, pay, second chance, ship/confirm/payout, moderation claim, idempotency,
              outbox, lot events, reconciliation, reports. Used by both api and worker.
  test-kit/   Shared test helpers: per-test Postgres DB from a template, fake clock, factories, HTTP/socket clients
infra/
  nginx/      nginx.conf + Dockerfile
  minio/      bucket/policy bootstrap
docker-compose.yml, docker-compose.test.yml, .env.example, .github/workflows/ci.yml
```

**Note:** the assignment lists four packages. `db`, `domain` and `test-kit` are additions. Without them, `api` and `worker` would have to share the close-lot, payment and ledger code by importing from each other's source. The README will explain why they exist.

Tooling: pnpm workspaces + Turborepo, TypeScript strict (`noUncheckedIndexedAccess`), ESLint flat config, Prettier, Vitest, fast-check (property tests), Playwright, orval (client generation), testcontainers is **not** used. Integration tests run against the compose services in `docker-compose.test.yml` (tmpfs Postgres, real Redis/Meili/MinIO).

---

## 2. Where data lives and how it recovers

| Store                | Holds                                                                                                                                                                                                                                          | If lost                                                                                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Postgres** (truth) | users, sessions, lots, bids, deposits, ledger, idempotency keys, deadlines (`ends_at`, `payment_due_at`, offer `expires_at`, claim `expires_at`, `shipped_at`), lot events with per-lot `seq`, outbox, email log, payment-stub provider schema | n/a                                                                                                                                                                                                                                                                                             |
| **Redis**            | BullMQ queues and delayed jobs, Socket.IO adapter pub/sub, rate-limit counters, small caches                                                                                                                                                   | Nothing. A Postgres **sweeper** (every 5 s, in every worker, coordinated with `FOR UPDATE SKIP LOCKED`) finds every due deadline and enqueues a job with a **deterministic jobId**. Handlers are idempotent at the SQL level. Rate limits fall back to in-process counters while Redis is down. |
| **Meilisearch**      | search projection of public lot fields only (whitelist mapper, never `reserve_price`)                                                                                                                                                          | `outbox` rows stay unprocessed until Meili is back, then get replayed. `pnpm reindex` rebuilds from Postgres into a new index and swaps it in atomically.                                                                                                                                       |
| **MinIO**            | `photos-private` (originals plus processed copies, private bucket) and `photos-public` (EXIF-free copies of approved lots, anonymous read)                                                                                                     | Photos are the only data kept outside Postgres. Postgres stores keys and checksums.                                                                                                                                                                                                             |

---

## 3. Core designs

### 3.1 Bidding (invariants 1, 2, 3, 5)

- **Pure engine** (`shared/auction`): `resolve(state, bid, now) → { state', events[], outcome }`. The state holds the price, the leader with their max and `placed_at`, the bid count and the other participants' maxes.
  - Manual bid X: X must be ≥ price + step(price). If X beats every other max, the price becomes X. If someone's autobid max is ≥ X, that autobid answers with `min(theirMax, X + step(X))`. With equal maxes, the earlier one leads.
  - Autobid M: the price becomes `min(M, secondMax + step(secondMax))`. On equal maxes the earlier bid leads at that max. This is **order-independent**, and a fast-check property test runs every permutation of up to 6 bidders.
  - Step table and boundaries come from the assignment (<100: 5; 100–999.99: 10; 1 000–9 999.99: 50; ≥10 000: 100 ₴), all in kopecks.
- **Transaction** (`domain/placeBid`): `BEGIN` → `SELECT … FROM lots WHERE id=$1 FOR UPDATE`. This serialises every bid, buy-now and close on that lot. Then:
  1. Check the time with the **server clock** (`now < ends_at`), the status is `active`, the bidder is not the seller, and the bidder is not staff.
  2. Run the engine.
  3. Lock the wallet accounts involved, **sorted by id**. Lock order is always lot → accounts ascending, so there are no deadlock cycles.
  4. Hold the new or raised deposit and release the outbid participant's deposit **in this same transaction**.
  5. Insert bid rows (marked `is_auto` where applicable), update the lot, insert lot events (`seq = seq+1`) and the outbox row, and store the idempotency key.
  6. Anti-sniping: if `ends_at - now < 2 min`, set `ends_at = now + 2 min`.
  7. `COMMIT`, then emit the socket events.
- **Outcomes** are a typed union: `leading`, `outbid_by_autobid`, or `rejected{code}` (`LOT_ENDED`, `BID_TOO_LOW`, `OWN_LOT`, `INSUFFICIENT_FUNDS`, `LOT_NOT_ACTIVE`, …).
- **Buy-now vs first bid**: both lock the lot row. Buy-now requires `bid_count = 0`, so whichever transaction gets the lock first wins and the other gets `LOT_NOT_ACTIVE` or `BUY_NOW_UNAVAILABLE`.
- **Closing**: `UPDATE lots SET status=… WHERE id=$1 AND status='active' AND ends_at <= $now RETURNING`. If no row comes back, nothing happens. That makes stale jobs left over from an extension harmless, and a lot closes exactly once.
- Retry wrapper for `40001`/`40P01` errors, with a maximum of 3 attempts. The idempotency key makes retries safe.

### 3.2 Ledger: double entry (invariant 4)

Tables: `accounts(id, kind, owner_id, lot_id, balance)`, `ledger_transactions(id, kind, ref unique, created_at)`, `ledger_entries(tx_id, account_id, amount)`.

DB-enforced:

- A deferred constraint trigger requires that the entries of each transaction sum to 0.
- Entries are append-only: a trigger rejects UPDATE and DELETE.
- `accounts.balance` is maintained by a trigger on entry insert, so a balance always equals the sum of its entries.
- `CHECK (balance >= 0)` applies to user accounts. Only `external:*` and `platform:*` accounts may go negative.
- `ledger_transactions.ref` is UNIQUE (for example `topup:{id}`, `payout:{lotId}`), which makes double-crediting impossible even if the application has a bug.

| Account                     | Meaning                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `external:payment_provider` | money that came in from outside (goes negative by the total of all top-ups) |
| `user:{id}:available`       | spendable balance                                                           |
| `user:{id}:held`            | deposits (all lots)                                                         |
| `escrow:lot:{id}`           | buyer's payment held until delivery                                         |
| `platform:commission`       | revenue                                                                     |

| Operation                          | Entries                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Top-up X                           | external −X, available +X                                                                                             |
| Bid or raise (deposit D or delta)  | available −D, held +D                                                                                                 |
| Outbid, lot unsold, lot removed    | held −D, available +D                                                                                                 |
| Pay price P with deposit D         | held −D, available −(P−D), escrow +P                                                                                  |
| Buy-now                            | locks the deposit like a bid. Payment works the same way.                                                             |
| Non-payment                        | buyer held −D, seller available +D                                                                                    |
| Payout (confirm or auto after 7 d) | escrow −P, seller available +(P−C), commission +C. C = max(5% of P, 10 ₴), rounded **down** (in the seller's favour). |
| Second-chance payment              | available −P, escrow +P (no deposit, see decisions)                                                                   |

Reconciliation: Σ all entries = 0; every `balance` = Σ of its entries; provider records vs `topups` → list of mismatches.

### 3.3 Lot statuses

| From → To                               | Who                              | Condition                               |
| --------------------------------------- | -------------------------------- | --------------------------------------- |
| — → `draft`                             | seller                           | create                                  |
| `draft` → `in_review`                   | seller                           | submit (photos processed, fields valid) |
| `rejected` → `draft`                    | seller                           | edit after rejection                    |
| `in_review` → `active`                  | moderator holding the claim      | approve; `ends_at = now + duration`     |
| `in_review` → `rejected`                | moderator holding the claim      | reason required                         |
| `active` → `awaiting_payment`           | system (close) / buyer (buy-now) | reserve met / no bids yet               |
| `active` → `ended_unsold`               | system                           | no bids or reserve not met              |
| `active` → `removed`                    | moderator                        | deposits released, participants emailed |
| `awaiting_payment` → `paid`             | buyer / second-chance offeree    | pays within window                      |
| `awaiting_payment` → `awaiting_payment` | system                           | non-payment → offer to next participant |
| `awaiting_payment` → `ended_unsold`     | system                           | no participants left                    |
| `paid` → `shipped`                      | seller                           | tracking number                         |
| `shipped` → `completed`                 | buyer / system after 7 d         | payout                                  |

Editing: before the first bid the seller may change anything (an `active` lot with zero bids is edited under the lot row lock). After the first bid, only appending to the description is allowed. The status machine is a pure table in `shared` and is checked again in SQL with `WHERE status = …`. Every change writes to `lot_audit` (actor, action, diff, at).

### 3.4 Jobs and time (invariants 3, 8, 9, 13)

- Queues (BullMQ): `lot-close`, `payment-deadline`, `offer-expiry`, `auto-confirm`, `review-claim-expiry`, `favorite-reminder`, `email`, `photo-process`, `search-sync`, `webhook-delivery`.
- Each job ID encodes the deadline, for example `close:{lotId}:{endsAtMs}`. Duplicates collapse in Redis, and stale jobs no-op in SQL.
- The sweeper runs in every worker copy. It is driven by `setInterval` and not by a BullMQ repeatable job, so it survives `FLUSHALL`. It re-enqueues anything due or overdue.
- Emails: an `email_log` row with a UNIQUE `dedupe_key` is inserted in the business transaction. The sender claims rows with `FOR UPDATE SKIP LOCKED`, sends via SMTP and marks them `sent`. The outbid throttle (one per lot per 15 min) and the favourite reminder (one per lot, exactly once) are encoded in the dedupe key and in conditional upserts.
- **Clock**: every module receives `clock.now()`. SQL receives timestamps as parameters, never `now()`, except in DB-only tests. All durations come from env (`ANTI_SNIPE_MS`, `PAYMENT_WINDOW_MS`, `OFFER_WINDOW_MS`, `REVIEW_CLAIM_MS`, `AUTO_CONFIRM_MS`, `OUTBID_EMAIL_THROTTLE_MS`, `FAVORITE_REMINDER_MS`) with the assignment's values as defaults. In the e2e/test stack, `TEST_CLOCK=1` enables `POST /__test/clock` (a shared offset stored in Postgres). The hostile suite verifies that this route is 404 when the flag is off.

### 3.5 Real-time across two api copies (invariant 10)

- Rooms: `lot:{id}` is public and joined via `subscribe` only for publicly visible lots. `user:{id}` is joined **by the server** from the session cookie during the handshake. Clients cannot join it.
- Each lot event is written to `lot_events(lot_id, seq, type, payload)` in the same transaction. After commit, the api emits through the **Redis adapter**, and the worker emits through `@socket.io/redis-emitter`.
- The client tracks `lastSeq` per lot. On a gap or a reconnect, it calls `GET /lots/:id/events?after=seq` and then applies the result. Postgres fills the gaps even if a pub/sub message was lost.
- Server time: every event and every REST response carries `serverNow`. The client estimates its offset NTP-style (RTT/2) and runs the countdown on server time, which is correct even when the local clock is off by 5 minutes.
- Payloads are built by `toPublicLotEvent()` (output Zod schema with strip). A test scans every emitted payload for `reserve`.
- nginx uses websocket-only transport, so no sticky sessions are needed. For tests, nginx routes `?node=a|b` to a specific upstream, which lets us prove the cross-copy path.

### 3.6 Search (invariant 11)

- The outbox row is written in the same transaction as any change to a searchable field. The worker uses `LISTEN outbox` plus a 1 s polling fallback, sends batches to Meili and marks rows done. Lag stays under 5 s, and a test asserts it.
- Index settings: filterable fields are category, city, condition, price, `has_bids` and `ends_at`. Sortable fields are price, `ends_at` and `created_at`. Facets come with counts.
- If Meili is down, `GET /search` returns `503 {code: SEARCH_UNAVAILABLE}` while the lot page and bids keep working, because they read from Postgres. When Meili comes back, the outbox drains.
- `pnpm reindex` builds a fresh index and swaps it in with `swapIndexes`, with no downtime.

### 3.7 Photos (invariant 12)

- `POST /lots/:id/photos/presign {contentType, size}` checks the type (JPEG/PNG/WebP), size ≤ 10 MB and the count ≤ 10. It returns a **presigned POST** whose policy pins exactly that `Content-Type` and `content-length-range [size, size]`. Any other file or size is rejected by MinIO itself.
- The worker then:
  - checks magic bytes with sharp and rejects files whose type was spoofed;
  - re-encodes with sharp, which removes EXIF/XMP/ICC GPS data;
  - writes the full image and a 400 px preview to `photos-private`.
- On approval, the files are copied to `photos-public`. On removal or rejection, they are deleted from it. A direct unsigned URL to the private bucket is refused (403).

### 3.8 Payment stub (invariants 6, 9)

- The stub has its own Postgres schema `provider` and behaves like an outside system.
  - The api exposes `/provider/*`: an HTML pay page with Success / Failure / Close-without-answer buttons, and `GET /provider/payments/:id` for status. The status endpoint requires a provider API key.
  - Webhooks are sent by the worker (`webhook-delivery` queue) and signed with HMAC-SHA256 over `timestamp.body`.
  - Chaos mode (`PAYMENT_STUB_CHAOS=1`) randomly sends a webhook twice, delays it by 0–60 s, delivers it out of order (`failed` after `succeeded`), or drops it.
- Receiver:
  1. Verify the signature in constant time and reject anything outside a 5-minute timestamp window.
  2. **Re-fetch the authoritative status** from the status API. The webhook is only a hint.
  3. Apply the terminal transition `pending → succeeded|failed` with a conditional UPDATE. The credit has ledger ref `topup:{id}` (UNIQUE).
- The reconciler runs every minute and resolves pending top-ups older than N s through the status API.

### 3.9 API platform

- **Auth**: email + password (argon2id). Opaque session token in an httpOnly, SameSite=Lax cookie, stored hashed in Postgres. Sockets authenticate with the same cookie. CSRF: state-changing requests need the `X-Requested-With` header plus an Origin check.
- **Roles**: `user` (both buyer and seller), `moderator`, `finance`. Every controller and gateway handler declares a policy, and a CI test **fails if any route has no policy declared**. Moderators get 403 on money endpoints. Finance gets 403 on lot mutations. Staff cannot bid.
- **Errors**: one shape, `{ error: { code, message, details?: [{ path, code, message }] }, requestId }`. A global filter maps Zod errors, domain errors, Postgres constraint errors (23505 → `CONFLICT`, 23514 → `INSUFFICIENT_FUNDS`, …) and unknown errors (logged, returned as `INTERNAL` with the requestId). The schema is registered in OpenAPI and attached to every route. A fuzz test asserts that malformed input never returns a 5xx.
- **Idempotency**: `Idempotency-Key` is required on bid, pay, top-up and buy-now. The key is stored as `(user_id, scope, key) → request_hash, response` **in the same transaction** as the operation. The same key with the same body replays the stored response. The same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`.
- **Rate limits** (Redis sliding window, per IP and per user, falling back to in-memory) are layered with nginx `limit_req`. Separate buckets: login (per IP and per account, with backoff), register, bids, top-ups, presign, search. `trust proxy` covers only the nginx subnet, so a spoofed `X-Forwarded-For` from the internet is ignored.
- **OpenAPI**: Zod schemas from `shared` → `nestjs-zod` DTOs → `@nestjs/swagger` at `/docs`. `pnpm openapi:generate` writes `openapi.json` without starting a server. CI regenerates the orval client and fails on `git diff`.
- **Bidder masking**: `о***7` is the first letter of the display name, then `***`, then the last character of a per-lot pseudonym hash. The viewer's own bids are marked "you". The seller sees the winner only after payment.

---

## 4. Seed (`db-init` container, runs once, keyed by a marker row)

The seed generates set-based SQL (`generate_series` + `COPY`) and finishes in about a minute.

- 10 000 users sharing one precomputed argon2 hash for password `Passw0rd!`, plus fixed logins: `buyer1..5@seed.test`, `seller1..5@seed.test`, `moderator1..2@seed.test`, `finance1@seed.test`.
- 30 categories, 15 cities.
- 50 000 lots: 5 000 `active`, about 300 of which end within the next hour. The rest are spread across all other statuses.
- 500 000 bids, with consistent prices and steps.
- Ledger built to match the seeded state: top-ups with matching `provider` payments, holds for current leaders, and payments, payouts and commission for completed lots. **Reconciliation of the seed returns zero mismatches**, and a test asserts it.
- Photos: about 60 generated placeholder images (sharp, coloured with the category name) uploaded once and shared by key.
- Meili: the worker runs a full reindex at startup when the index is empty.

---

## 5. Testing strategy

| Level           | Runs against                                                                                                                                                   | Examples                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit / property | nothing                                                                                                                                                        | bid engine permutations, step boundaries (99.99/100/999.99/1 000…), commission rounding, deposit min, masking, status table, money formatting in uk/en/pl, plurals |
| Integration     | real Postgres/Redis/Meili/MinIO from `docker-compose.test.yml`. Each test file gets its own DB cloned from a migrated template (`CREATE DATABASE … TEMPLATE`). | everything in `domain`, `worker`, `api`                                                                                                                            |
| Hostile         | the full stack built from Dockerfiles: nginx + api×2 + worker×3                                                                                                | attackers in §6 blocks 5–6                                                                                                                                         |
| e2e             | Playwright against the compose stack                                                                                                                           | the 4 required scenarios + keyboard paths + locales                                                                                                                |
| Perf            | full seed                                                                                                                                                      | search with facets and lot page p95 < 200 ms; 90-day report < 500 ms (via autocannon)                                                                              |

**Separate source IPs in hostile tests**: the hostile runner container is attached to **two docker networks**, and nginx sits on both. Requests bind `localAddress` to one interface or the other, so nginx sees two genuinely different client IPs without any header spoofing. This lets us prove that "one IP floods, another IP is unaffected".

---

## 6. Blocks = commits

Each block below lists its deliverables, the tests it needs, and when it counts as done. CI grows with each block.

### Block 1 — Foundation + `packages/shared`

- pnpm/turbo, tsconfig base, ESLint (no-any, ban-ts-comment, import boundaries), Prettier, Vitest workspace, `.github/workflows/ci.yml` (install → lint → typecheck → test), `.env.example` skeleton, `plan.md`, README skeleton.
- `shared`:
  - money as kopecks, an integer branded type, with formatters;
  - bid step, deposit and commission;
  - proxy-bid engine;
  - status machine;
  - Zod input schemas (lot, bid, top-up, filters);
  - error code enum and error schema;
  - masking;
  - time constants with env overrides.
- **Tests**:
  - fast-check: the engine's final price and leader are identical across all permutations;
  - the price never decreases;
  - exactly one leader;
  - assignment example 1 000/1 500 → 1 050, second leads;
  - ties → earlier leads;
  - step boundaries;
  - commission minimum and rounding direction;
  - money edge cases (0, 1 kop, max safe int, negative rejected).
- **Done** when CI is green and coverage of `shared` is ≥ 95%.

### Block 2 — Postgres: `packages/db`

- Compose service `postgres:16`. Drizzle schema for all tables and SQL migrations with CHECKs, FKs, partial unique indexes and triggers:
  - ledger zero-sum;
  - append-only entries;
  - balance maintenance;
  - one pending second-chance offer per lot;
  - one open moderation claim per lot;
  - `bids(lot_id, created_at desc)`;
  - report indexes.
- `db-init` Dockerfile: migrate → seed (idempotent).
- **Hostile DB tests** (raw SQL, bypassing the app):
  - an unbalanced ledger transaction is rejected;
  - UPDATE/DELETE on entries is rejected;
  - a user balance driven below 0 is rejected;
  - a duplicate `topup:` ref is rejected;
  - a second pending offer is rejected;
  - an invalid status value is rejected;
  - 10 concurrent hold transactions with money for 3 → exactly 3 commit;
  - the migration is idempotent on rerun;
  - the seed runs twice → no duplicates;
  - seed counts match the spec;
  - seed reconciliation = 0;
  - `EXPLAIN` of the lot page, bid history and 90-day report uses the indexes and stays under budget on the full seed.
- **Done** when `docker compose up postgres db-init` gives a fully seeded DB and all DB tests are green.

### Block 3 — Domain: `packages/domain`

- Functional use cases (§3.1–3.4, 3.8 core), clock abstraction, idempotency store, outbox/events writers, reconciliation and report queries.
- **Hostile tests** on real Postgres:
  - 50 concurrent bids on one lot → monotonic price, one leader, every bid gets an outcome, history consistent;
  - autobids in random order → same result;
  - a bid 1 ms after `ends_at` (worker not run) → `LOT_ENDED`;
  - extension → the old close is a no-op;
  - 20 concurrent closes → closed exactly once;
  - buy-now vs bid race ×100 runs → exactly one wins, money moved once;
  - 3-of-10 deposits;
  - the outbid deposit is released in the same transaction (asserted by checking ledger tx ids);
  - an idempotent replay returns the same result; the same key with a different body → rejected;
  - non-payment chain: winner → 2nd → 3rd → unsold, one offer at a time, no sale during an offer;
  - a moderator removes a lot → all deposits released;
  - top-up webhook duplicate, out-of-order, lost → exactly one credit;
  - **model-based fuzz**: 10 000 random operations across 50 users and 20 lots, after which Σ=0, balances = Σ entries, no negative balances and no orphaned holds.
- **Done** when all invariants 1–9 hold at the domain level.

### Block 4 — Worker + Redis + Meilisearch + MinIO + mail stub

- Compose: `redis:7`, `meilisearch`, `minio` + bucket init, `mailpit` (SMTP + web UI), `worker`.
- `apps/worker`: queues, sweeper, closers/deadlines, email sender, outbox → Meili sync, `pnpm reindex`, sharp photo pipeline, webhook sender with chaos mode, top-up reconciler.
- **Hostile tests**:
  - `FLUSHALL` mid-run → every due lot still closes on time, no duplicate emails or ledger txs;
  - kill -9 a worker mid-job → the job is completed by another worker exactly once;
  - 3 workers → no duplicates (checked by counting effects in Postgres and Mailpit);
  - Meili stopped → outbox grows → Meili started → caught up within 5 s;
  - lag < 5 s under bid load;
  - JPEG with GPS EXIF → output has no EXIF;
  - PNG renamed to `.jpg`, truncated or polyglot file → rejected;
  - decompression bomb (huge pixel count) → rejected by the sharp `limitInputPixels`;
  - 20 MB upload to a presigned URL → MinIO rejects it;
  - unsigned GET on a private object → 403;
  - outbid email throttle (15 min) and the favourite reminder sent exactly once.
- **Done** when invariants 11, 12 (storage side) and 13 hold.

### Block 5 — API (`apps/api`)

- NestJS modules wrapping `domain`:
  - auth, users, wallet, top-ups, payment-stub HTTP;
  - lots, photos, moderation, bids, buy-now, payments, shipping, favorites;
  - finance (report, reconciliation), search, events catch-up;
  - Socket.IO gateway + Redis adapter.
- Also: `env.ts`, error filter, policies, rate limits, idempotency interceptor, OpenAPI at `/docs`, `openapi.json` + orval check in CI. Compose: `api` ×2 (Dockerfile).
- **Hostile tests** (real HTTP + sockets against the running app):
  - **authz matrix generated from OpenAPI**: every route × {anon, buyer, other buyer, seller, moderator, finance} → expected status. Covers IDOR on wallets, bids, drafts and payments;
  - reserve price never appears in any response, search document or socket payload (recursive key scan + value scan);
  - fuzzing every route with random and malicious bodies (prototype pollution `__proto__`, huge numbers, floats for kopecks, negative amounts, unicode, 1 MB strings, SQL fragments, wrong content-type) → always a 4xx in the documented format, never a 5xx;
  - login brute force → backoff and lockout per account and IP, with no user enumeration via timing or messages;
  - session fixation and stolen-cookie revocation on logout;
  - CSRF without header/Origin → 403;
  - socket: joining someone else's `user:` room is impossible; anonymous sockets get no private events; mass subscribe/flood → disconnect;
  - webhook: bad signature, stale timestamp, replay, unknown payment → rejected and nothing credited;
  - `/__test/clock` → 404 when the flag is off;
  - staff bids → 403.
- **Done** when invariants 7, 14 and 15 hold over HTTP and invariants 1–9 hold again through HTTP.

### Block 6 — nginx + cross-replica real-time

- `infra/nginx`:
  - load balancing across api×2;
  - websocket upgrade;
  - `limit_req` / `limit_conn` per real IP;
  - body size limits and timeouts (slowloris);
  - security headers;
  - `/docs`, `/provider`, `/photos` (public bucket proxy), web routing;
  - `?node=` pinning for tests.
- **Hostile tests**:
  - a bid on node A is seen on node B in under 1 s (measured p99 over 200 bids);
  - a client offline for 60 s reconnects → catches up by `seq`, never shows a stale price;
  - a private "outbid" notification reaches only its addressee (10 sockets, 1 target);
  - a client clock skewed by ±5 min shows the correct remaining time;
  - **IP flood**: attacker IP sends 5 000 req/s + 2 000 sockets, while the bystander IP keeps p95 < 300 ms and 0 errors;
  - spoofed `X-Forwarded-For`/`X-Real-IP` does not change the attacker's bucket;
  - slow-body attack is cut off;
  - killing one api copy mid-auction → clients reconnect to the other and lose no events.
- **Done** when invariant 10 holds and acceptance items 3 and 12 pass.

### Block 7 — Web (`apps/web`, FSD)

- Next 15 + React 19, orval client + TanStack Query, RHF + Zod (shared schemas), Tailwind, next-intl `uk`/`en`/`pl`.
- Pages:
  - search (filters, facets, sort and page in the URL, Back works);
  - lot page (live price, timer on server time, history, bid/autobid forms, buy-now, favourites);
  - wallet (balance, held, available, history, top-up);
  - my bids and wins (pay, confirm);
  - seller (create/edit with direct photo upload, by-status list, pending payout, ship);
  - moderator queue;
  - finance report and reconciliation;
  - in-app notifications.
- Field-level errors, and bid and pay forms fully usable from the keyboard.
- **Playwright**:
  - two browsers on different api nodes: a bid in the first updates price and timer in the second;
  - an autobid outbids → the first user sees a notification;
  - a last-2-minute bid extends the lot for both;
  - full money flow: top-up → bid → win → pay → ship → confirm → payout, with reconciliation still 0;
  - keyboard-only bid and payment;
  - `uk`/`en`/`pl` formatting (`1 234,50 ₴`, «3 ставки», «5 ставок», Polish plurals);
  - a Meili outage shows a friendly search error;
  - axe accessibility smoke test.
- **Done** when e2e is green and steiger is clean.

### Block 8 — Acceptance, performance, README

- `pnpm acceptance` runs acceptance items 1–20 against a fresh `docker compose up --build` and prints a pass/fail table. Perf runs on the full seed. The CI job does a full-stack build and e2e.
- README contains everything the assignment lists: run and test instructions, bids and locking, posting scheme, status table, data ownership and recovery, the real-time path, indexes and constraints, decisions, seed logins.
- **Done** when every acceptance row passes from a clean clone.

---

## 7. `.env.example` (final shape, filled in block by block)

```
# general
NODE_ENV=development  LOG_LEVEL=info  TZ=UTC  PUBLIC_URL=http://localhost:8080
# postgres
POSTGRES_USER=auction  POSTGRES_PASSWORD=dev-only-change-me  POSTGRES_DB=auction  DATABASE_URL=postgres://...
SEED_ENABLED=true  SEED_LOTS=50000  SEED_USERS=10000  SEED_BIDS=500000
# redis / meili / minio / smtp
REDIS_URL=redis://redis:6379
MEILI_URL=http://meilisearch:7700  MEILI_MASTER_KEY=dev-only-...
S3_ENDPOINT=http://minio:9000  S3_PUBLIC_ENDPOINT=http://localhost:8080/photos  S3_ACCESS_KEY=...  S3_SECRET_KEY=dev-only-...
S3_PRIVATE_BUCKET=photos-private  S3_PUBLIC_BUCKET=photos-public
SMTP_HOST=mailpit  SMTP_PORT=1025  MAIL_FROM=no-reply@auction.local
# auth / security
SESSION_SECRET=dev-only-...  SESSION_TTL_HOURS=168  TRUSTED_PROXY_CIDR=172.28.0.0/16
RATE_LIMIT_*  (per bucket: window + max)
# payment stub
PAYMENT_WEBHOOK_SECRET=dev-only-...  PAYMENT_PROVIDER_API_KEY=dev-only-...  PAYMENT_STUB_CHAOS=false
# rules / timing (defaults = assignment values, overridable for tests)
ANTI_SNIPE_MS=120000  PAYMENT_WINDOW_MS=172800000  OFFER_WINDOW_MS=86400000  REVIEW_CLAIM_MS=900000
AUTO_CONFIRM_MS=604800000  OUTBID_EMAIL_THROTTLE_MS=900000  FAVORITE_REMINDER_MS=3600000
SWEEPER_INTERVAL_MS=5000  TEST_CLOCK=false
# web
NEXT_PUBLIC_API_URL=/api  NEXT_PUBLIC_WS_URL=/  NEXT_PUBLIC_DEFAULT_LOCALE=uk
```

---

## 8. Decisions (go into the README)

1. **Second-chance offer price** is the participant's own max bid, as the assignment says. Their deposit was already released when they were outbid, so they pay the full price from their wallet within 24 h, and expiry carries no penalty. Paying is how they accept.
2. **Reserve price (confirmed).** When the leader's max is ≥ reserve but the computed price is below it, the price jumps to the reserve and the lot shows "reserve met". It sells at the end of the auction, and others can still outbid until then; it is not an instant close. Without this, a single bidder willing to pay the reserve would lose the lot. When no reserve is involved, the formula from invariant 2 is unchanged.
3. **Buy-now locks a deposit** (10% of the price, min 50 ₴), so non-payment is penalised the same way as for a won auction.
4. **The non-payment deposit goes entirely to the seller**, with no commission charged on it.
5. **Payouts go to the seller's wallet.** Withdrawal to a bank is out of scope because there are no external payment systems.
6. **Commission** is floored in kopecks (in the seller's favour), with a minimum of 10 ₴ that is capped at the sale price.
7. **Staff accounts** (moderator, finance) cannot bid, sell or own a wallet.
8. **Lot end** is decided by server time inside the locking transaction. The worker only does the bookkeeping afterwards.
9. **Emails are at-least-once to SMTP** with a dedupe key in Postgres. The only window for a duplicate is a crash between the SMTP send and the "sent" mark. Mailpit dedupes on Message-ID, and the acceptance check counts rows in `email_log`.
10. **Extra packages** `db`, `domain` and `test-kit`, for the reason given in §1.

## 9. Agreed

1. Extra packages `db`, `domain` and `test-kit`: yes.
2. Reserve price jump: yes (decision 2).
3. README and docs: English.
4. 8 commits as in §6.

## 10. Changes made while building (kept honest)

- **Block 2:** password hashing is **scrypt** (`node:crypto`), not argon2: nothing native to compile in Docker.
- **Block 2:** `packages/test-kit` is deferred to Block 3 (when `domain` needs shared fixtures). Until then the DB test helpers are `@auction/db/testing` (template database cloned per test file) plus `packages/db/test/helpers.ts`.
- **Block 2:** the API and worker connect as a **restricted, non-superuser role** (`APP_DB_USER`); only `db-init` uses the owner (`DATABASE_ADMIN_URL`). Without this, a superuser could switch every trigger off, so all the DB-level guarantees would be decoration. Found by a test that polluted its own connection with `session_replication_role = replica`.
- **Block 2:** the seed books each sale as its net effect, not every hold and release, and generates bid histories by running the real engine.
- **Block 2:** placeholder photo rows are seeded in Postgres; the placeholder image files are uploaded to MinIO in Block 4.
- **Block 3:** `packages/test-kit` exists now. It uses raw SQL fixtures only, so it cannot hide a domain bug by sharing its code.
- **Block 3:** the use cases return `{ result, effects }`; effects (socket events, notifications) are also persisted in the same transaction, so a lost push is recovered from Postgres.
- **Block 3:** the sweeper (`runSweep`) is the real timer; BullMQ jobs in Block 4 only make it faster.
- **Block 3:** the test suite was mutation-checked by hand: deliberately removing the deposit release, the clock check and the forfeit each makes tests fail.
- **Block 4:** two extra packages, `payment-stub` (the provider as its own module) and `platform` (Redis/BullMQ, S3, photo pipeline, Meilisearch, mail, realtime emitter), so `api` and `worker` share tested code. The worker is a thin NestJS shell around a functional `startWorker`.
- **Block 4:** Meilisearch v1.22 (the atomic index swap needs it); MinIO is the `pgsty/minio` community build.
