# Phoenix Perp Bot — Deep Research Report

## What This Is

A Telegram-native perpetuals trading bot for the Phoenix Perpetuals protocol on Solana. Users interact entirely through Telegram commands — depositing USDC, opening leveraged long/short positions, setting stop-loss/take-profit, monitoring positions in real-time, and earning rebates through a referral program. No web app, no wallet extension required: every user gets an embedded Solana wallet managed by Privy's server-auth SDK.

---

## Architecture Overview

Three independently deployable processes (Railway services):

```
[Telegram] ──webhook──> [Bot / Fastify] ──DB/Redis──> [PostgreSQL + Redis]
                                                              ^
[Phoenix WS] ──events──> [WS Worker] ──alertQueue──> [BullMQ]
                                                              |
                                               [Alert Worker] ──sendMessage──> [Telegram]
```

The bot process never sends alert messages directly. Instead, the WebSocket worker detects events, writes jobs to a BullMQ queue, and a separate alert worker drains the queue and calls Telegram. This means:
- A bot restart doesn't lose in-flight alert jobs (BullMQ persists in Redis)
- Alert throughput can be scaled by adding alert worker replicas
- The WS worker has no Telegram dependency (pure event detection + queueing)

### Entry Points

| File | Role |
|------|------|
| `src/main.ts` | Bot + Fastify server (webhook in prod, long-polling in dev) |
| `src/workers/ws.ts` | Per-user Phoenix WS subscriptions + price alert checking |
| `src/workers/alert.ts` | BullMQ consumer; calls `bot.api.sendMessage` |

---

## Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Bot framework | grammY | TypeScript-first, middleware system, webhook support |
| HTTP server | Fastify v5 | Low-overhead, plugin system for webhook route |
| Protocol SDK | `@ellipsis-labs/rise` 0.4.9 | Phoenix's own TypeScript SDK |
| Solana TX building | `@solana/kit` v6.9 | Modern functional API (vs legacy web3.js) |
| Wallet custody | `@privy-io/server-auth` | Server-side embedded wallets — no user key management |
| Database | Drizzle ORM + PostgreSQL (postgres.js) | Type-safe, migration-friendly |
| Job queue | BullMQ + ioredis | Redis-backed queue with retries and backoff |
| Logging | pino | Structured JSON logging, pretty-print in dev |
| Image rendering | satori + sharp | JSX → SVG → PNG pipeline for P&L cards |
| QR codes | qrcode | Deposit address QR generation |
| Validation | Zod | Env var schema + fail-fast startup |
| Linter/formatter | Biome | Single tool for both lint and format |
| ORM migrations | Drizzle Kit | SQL migration generation |
| Tests | Vitest | Unit + integration suites |

Module system: **ESM only** (`"type": "module"`). All imports must use `.js` extensions even for `.ts` source files. No `require()`.

---

## Directory Structure

```
src/
  config/index.ts          — Zod env validation, exports config object
  types/index.ts           — Shared TypeScript types (BotContext, TraderStateEvent, etc.)
  lib/
    logger.ts              — Pino singleton
    redis.ts               — ioredis singleton
    privy.ts               — Privy client singleton
  db/
    index.ts               — Drizzle ORM setup
    schema/
      users.ts             — users table
      alerts.ts            — alertSubscriptions table
      referrals.ts         — referrals table (T1/T2 chain)
      settings.ts          — userSettings table
      index.ts             — re-exports all schemas
    migrations/            — Generated SQL migrations
  bot/
    index.ts               — Bot setup, middleware, pending input dispatcher
    middleware/
      auth.ts              — Loads ctx.user from DB on every request
      rate-limit.ts        — Redis-backed rate limiting (global + order-specific)
    keyboards/
      trade.ts             — Size, leverage, confirm keyboards
      position.ts          — Position management keyboard
      market.ts            — Market action keyboard
    commands/              — One file per command (20+ files)
  services/
    wallet.ts              — Privy wallet creation + signing
    referral.ts            — Referral chain management
    image.ts               — P&L card image generation
    phoenix/
      client.ts            — Rise SDK client factory
      market.ts            — Market data queries
      position.ts          — Trader state + history
      trade.ts             — Order placement, TP/SL, close, deposit/withdraw
  workers/
    ws.ts                  — WebSocket subscriptions + price alert checks
    alert.ts               — BullMQ alert worker entry point
  jobs/
    queues.ts              — alertQueue definition
    processors/alert.ts    — Alert job processor
  server/
    index.ts               — Fastify server setup
    routes/health.ts       — GET /health
  main.ts                  — Application entry point

tests/
  setup.ts                 — Mocks env vars for tests
  unit/services/           — Unit tests (image, market, referral)
  integration/             — Integration tests (alerts, referral linking)

scripts/
  test-onchain.ts          — Standalone on-chain integration test (no Telegram/DB)
```

---

## Database Schema

### `users`
Primary key is the Telegram user ID (string). Each user gets one Privy wallet and one Phoenix account.

```
id              text PK (= telegramId)
telegramId      text UNIQUE NOT NULL
username        text (optional)
firstName       text (optional)
privyUserId     text NOT NULL
walletAddress   text NOT NULL    ← Solana pubkey
phoenixActivated boolean DEFAULT false
referralCode    text UNIQUE      ← 8-char uppercase hex (their own code)
referredBy      text             ← code used at signup
createdAt       timestamp
updatedAt       timestamp
```

### `alertSubscriptions`
One row per user per alert type. Symbol is null for non-market-specific alerts.

```
id          text PK (UUID)
userId      text FK→users.id (cascade delete)
type        enum (at_risk|cancellable|liquidatable|fill|tpsl_flip|price|funding_flip|large_funding)
symbol      text NULL
triggerPrice text NULL       ← for price alerts
enabled     boolean DEFAULT true
createdAt   timestamp
```

### `referrals`
Stores the T1/T2 referral chain separately. T1 = direct referral, T2 = secondary (grandparent gets a cut when their direct referral brings in someone new).

```
id          text PK (UUID)
referrerId  text FK→users.id
refereeId   text FK→users.id
tier        enum (t1|t2)
accruedUsdc numeric(20,6)    ← earned but not yet claimed
claimedUsdc numeric(20,6)    ← already paid out
createdAt   timestamp
updatedAt   timestamp
```

### `userSettings`
One row per user. Upserted on change, defaults applied at read if row missing.

```
userId          text PK FK→users.id (cascade delete)
slippageBps     integer DEFAULT 50   ← 0.5%
defaultLeverage integer DEFAULT 5
updatedAt       timestamp
```

---

## Command Reference

| Command | Syntax | What it does |
|---------|--------|-------------|
| `/start` | `/start [code]` | Onboarding: Privy wallet → Phoenix activation → referral link |
| `/balance` | `/balance` | Deposited collateral, effective collateral, uPnL, risk tier |
| `/deposit` | `/deposit` | QR code + USDC mint for deposits |
| `/withdraw` | `/withdraw <amount> <address>` | Two-step confirm; 5-min delay for new addresses |
| `/markets` | `/markets` | Paginated market list (10/page) with prices + funding |
| `/price` | `/price <symbol>` | Mark price, funding APR, OI, 24h volume |
| `/long` | `/long <symbol> <leverage>x <size>` | Opens long with confirmation step |
| `/short` | `/short <symbol> <leverage>x <size>` | Opens short with confirmation step |
| `/positions` | `/positions` | Open positions with per-position inline keyboard |
| `/pnl` | `/pnl` | Unrealized PnL summary |
| `/history` | `/history [page]` | Paginated trade history |
| `/alerts` | `/alerts` | Toggle alert types (fill, risk, funding, etc.) |
| `/alert` | `/alert <symbol> <price>` | Price threshold alert (+price = above, -price = below) |
| `/funding` | `/funding` | Top 10 markets by absolute funding rate |
| `/settings` | `/settings` | Set slippage (BPS) and default leverage |
| `/setsl` | `/setsl <symbol> <price> [market\|limit]` | Set stop-loss |
| `/settp` | `/settp <symbol> <price> [market\|limit]` | Set take-profit |
| `/referral` | `/referral` | Stats: referral count + accrued/claimable rebates |
| `/claim` | `/claim` | Claim referral USDC rebates (min $1) |
| `/share` | `/share <symbol>` | Generates a P&L card image for a closed trade |
| `/export` | `/export` | Informs user Privy dashboard handles key export |

---

## Multi-Step Command Flow (Pending Input Pattern)

Certain commands require follow-up text input after initial interaction. The pattern:

1. Command handler stores pending state in Redis: `pending:{userId}` → `"addmargin:SOL"`
2. TTL: 120 seconds
3. `bot.on("message:text")` in `bot/index.ts` checks for pending key
4. If found: calls the appropriate handler function with the input
5. Deletes the Redis key when done

This is used for:
- `addmargin` (from position keyboard → text input for amount)
- `editsl` (from position keyboard → text input for new SL price)
- `edittp` (from position keyboard → text input for new TP price)

---

## Phoenix Protocol Integration

### Market Access
All market data flows through `@ellipsis-labs/rise` SDK:
- `getMarkets()` — full market list
- `getMarketSnapshot(symbol)` — mark price, tick size, leverage tiers, fees, OI
- `getOrderbook(symbol)` — bids, asks, mid price
- `getFundingRateHistory(symbol)` — funding rate time series

### Market Categories
```
ISOLATED_ONLY_MARKETS = { GOLD, SILVER, SKR, WTIOIL }
```
These require a dedicated isolated subaccount. The bot currently rejects any order for these symbols with "coming soon." All other markets use cross-margin (subaccountIndex=0).

### Account Model
Phoenix uses a PDA-based account model:
- `(wallet_authority, portfolio_index, subaccount_index)`
- `subaccount_index=0` = cross-margin (used for all current trades)
- `subaccount_index>0` = isolated margin (not yet implemented)

### USDC & the Ember Proxy
Phoenix uses its own wrapped USDC (`PhUsd...`), not standard USDC (`EPjFWdd5...`). Deposits and withdrawals go through the **Ember proxy contract**, which wraps/unwraps 1:1. The trade service handles all the intermediate instructions (ATA creation, Ember wrap/unwrap, deposit/withdraw) in sequence.

### Builder Routing (Flight)
All trades are routed through a builder authority PDA for MEV protection. Builder fees are 10-15 bps (taker-only), configurable via `BUILDER_FEE_BPS`. The builder activates users via `POST /v1/invite/activate` using `BUILDER_ACCESS_CODE` — users never need their own codes.

### Order Types
- **Market order**: IOC (Immediate or Cancel) with slippage tolerance
- **Limit order**: Specific price, resting until filled
- **Close**: IOC with ReduceOnly flag, size from current position lots
- **Stop-Loss**: IOC (market) or limit conditional on price trigger
- **Take-Profit**: IOC (market) or limit conditional on price trigger

TP/SL trigger direction:
- Long SL: `LessThan` trigger, sell (ask) side
- Long TP: `GreaterThan` trigger, sell (ask) side
- Short SL: `GreaterThan` trigger, buy (bid) side
- Short TP: `LessThan` trigger, buy (bid) side

For market-mode TP/SL: price padded by 10% in the safe direction (SL 10% lower, TP 10% higher) to ensure fill.

---

## Wallet & Signing Architecture

### Privy Embedded Wallets
Every Telegram user gets a server-custodied Solana wallet. No seed phrase is ever shown to or managed by the user (though they can export via Privy's dashboard). The bot signs transactions server-side using Privy's API.

### The Signing Gap (Critical Blocker)
`src/services/wallet.ts` exposes three functions:

```typescript
createEmbeddedWallet(telegramUserId)  // works: creates wallet via Privy
getWalletSigner(walletAddress)         // partially works: Privy signing via legacy web3.js
getKitSigner(walletAddress)            // THROWS: "not yet implemented"
```

**All trade execution functions in `trade.ts` call `getKitSigner()`**, which throws at runtime. This means:
- No Telegram user can actually place a trade
- The test script (`scripts/test-onchain.ts`) bypasses this by loading a real keypair from `TEST_KEYPAIR` env var
- `getWalletSigner()` does exist and calls Privy, but it returns a web3.js-style signer incompatible with `@solana/kit`'s `KeyPairSigner` interface

This is **the primary blocker to production trading**.

---

## Alert Pipeline (WebSocket → BullMQ → Telegram)

### WebSocket Worker (`src/workers/ws.ts`)

**Per-user subscriptions** (`subscribeUser`):
- Opens dedicated WebSocket to Phoenix WS endpoint
- Subscribes to `traderState` channel for that wallet
- On each event, compares new state to cached state (Redis, 1h TTL):
  - Position side changed → `tpsl_flip` alert
  - Risk tier != Safe → risk alert (at_risk, cancellable, liquidatable)
  - New fills detected → `fill` alert + `accrueReferralFee()`
- Reconnects after 5s on disconnect

**Global price subscription** (`subscribeAllMids`):
- Single WebSocket for all market mid prices
- On each update, queries DB for all enabled `price` type alert subscriptions
- Compares price to trigger threshold
- Fires alert once via Redis dedup key (1h TTL) to prevent re-triggering on same threshold

**Bootstrap**: On startup, reads active wallet addresses from Redis keys and resubscribes all users (survives worker restarts).

### Alert Queue
BullMQ queue named `"alerts"` with:
- 3 retry attempts
- Exponential backoff starting at 1s
- Keep last 100 completed, 500 failed jobs

### Alert Processor (`src/jobs/processors/alert.ts`)
- Dedup check via Redis: `alert:dedup:{telegramId}:{type}:{symbol}` with 5s TTL
- Prevents duplicate messages in short burst scenarios
- Calls `bot.api.sendMessage()` with HTML parse mode
- Concurrency: 10 parallel jobs

---

## Referral System

Two-tier rebate chain, fully managed by the bot (independent of Phoenix's native referral program which requires $10K volume):

```
User A refers User B (T1): A earns 0.2 × builder_fee per B's trade
User B refers User C (T2): A earns 0.1 × builder_fee per C's trade (via B's chain)
```

`linkReferral(refereeId, referralCode)`:
1. Finds referrer by code
2. Prevents self-referral
3. Creates T1 row (referrer → referee)
4. If referrer has their own T1 parent (a grandparent), creates T2 row (grandparent → referee)

No three-level chaining: the T2 is anchored to the grandparent, not propagated further.

`accrueReferralFee(userId, notionalUsdc)`:
- Called from WS worker on each fill
- Calculates builder fee: `notionalUsdc × BUILDER_FEE_BPS / 10000`
- T1 referrer gets `fee × 0.2` added to `accruedUsdc`
- T2 referrer gets `fee × 0.1` added to `accruedUsdc`

`/claim` command:
- Requires minimum $1 USDC claimable
- Updates DB (marks accrued as claimed), notifies user that funds arrive within 24h
- Note: the actual USDC transfer mechanism is not implemented in code — manual fulfillment implied

---

## Rate Limiting

Two independent Redis-backed limiters using `INCR` + `EXPIRE` pattern:

| Limiter | Scope | Limit | Window |
|---------|-------|-------|--------|
| General | All commands, per user | 20 requests | 60 seconds |
| Order | `/long`, `/short` only | 5 orders | 60 seconds |

Redis keys: `ratelimit:{userId}` and `ratelimit:orders:{userId}`.

Implementation uses `INCR` followed by conditional `EXPIRE` (only on first request). If count exceeds limit, the middleware returns early without calling `next()` — the message is silently dropped (no user-facing error in current implementation).

---

## Image Generation Pipeline

`/share <symbol>` generates a 1200×630px PNG trade card:

1. `getTradeHistory()` fetches last 20 trades
2. Finds first `Closed` trade matching the symbol
3. Constructs `PnlCardData` (entry, exit, ROI%, PnL USDC)
4. `generatePnlCard(data)`:
   - Satori renders JSX component → SVG string
   - Sharp converts SVG → PNG Buffer
   - Font: Inter-Bold loaded from `assets/fonts/Inter-Bold.ttf`
5. Bot sends Buffer as photo (note: there's a known bug — needs `new InputFile(buffer)` wrapper)

Card colors:
- Long position: green accent
- Short position: red accent
- Profit PnL: green text
- Loss PnL: red text

---

## Known Bugs (Documented in CLAUDE.md)

1. **`alerts.ts`** — `findFirst` for alert subscription missing `type` filter; could load wrong alert type's row
2. **`deposit.ts` + `share.ts`** — `replyWithPhoto` receives raw `Uint8Array`/Buffer but needs `new InputFile(buffer)` wrapper
3. **`long.ts` + `short.ts`** — confirm callback regex `(\d+)` rejects decimal-point values (e.g., `5.5x` leverage)
4. **`referral.ts`** — T2 chain lookup can accidentally pick a T2 row as the parent referral; needs `eq(referrals.tier, "t1")` filter added
5. **Missing packages**: `ws` + `@types/ws` are imported in `src/workers/ws.ts` but not in `package.json`
6. **`vitest.config.ts`** — The file exists but CLAUDE.md says it's missing; tests may not run correctly without integration config being picked up
7. **`src/db/schema/settings.ts`** — Referenced in CLAUDE.md as missing, but the file exists in the repo; likely a stale bug note

---

## Environment Variables

All validated by Zod at startup (`src/config/index.ts`). Crash-on-failure with field-level error messages.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | No | `development` | Environment mode |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot authentication |
| `WEBHOOK_URL` | No | — | If set, enables webhook mode |
| `PRIVY_APP_ID` | Yes | — | Privy app identifier |
| `PRIVY_APP_SECRET` | Yes | — | Privy signing secret |
| `BUILDER_AUTHORITY_PUBKEY` | Yes | — | Phoenix builder PDA |
| `BUILDER_ACCESS_CODE` | Yes | — | Activates new users on Phoenix |
| `BUILDER_FEE_BPS` | No | `10` | Builder fee (1-50 bps) |
| `PHOENIX_API_URL` | No | `https://perp-api.phoenix.trade` | Phoenix REST API |
| `PHOENIX_WS_URL` | No | `wss://perp-api.phoenix.trade/v1/ws` | Phoenix WebSocket |
| `HELIUS_RPC_URL` | Yes | — | Solana RPC endpoint |
| `DATABASE_URL` | Yes | — | PostgreSQL connection |
| `REDIS_URL` | Yes | — | Redis connection |
| `PORT` | No | `3000` | Fastify bind port |
| `HOST` | No | `0.0.0.0` | Fastify bind host |

---

## Test Infrastructure

### Unit Tests (`tests/unit/`)
- `services/image.test.ts` — Smoke tests for PnL card generation (non-empty Buffer)
- `services/market.test.ts` — `isIsolatedOnly()` correctness
- `services/referral.test.ts` — Code format validation, uniqueness

### Integration Tests (`tests/integration/`)
- `alerts.test.ts` — Alert toggle correctness (targeted, idempotent)
- `referral.test.ts` — Full T1/T2 linking, self-referral prevention, 2-level cap

Tests use real DB operations. Setup file (`tests/setup.ts`) mocks only env vars. Integration tests require a running PostgreSQL instance.

### On-Chain Test Script (`scripts/test-onchain.ts`)
Not a test runner — a manual integration harness:
- Loads keypair from `TEST_KEYPAIR` env (bypassing Privy entirely)
- Runs 50 open/close cycles on SOL-PERP
- Measures total SOL gas cost
- Validates the full order placement and position closing flow

---

## Startup Flow

**Production (webhook mode)**:
```
main.ts
  → createServer() — Fastify with webhook route
  → server.listen(PORT, HOST)
  → bot.api.setWebhook(WEBHOOK_URL + "/webhook/" + TOKEN)
```

**Development (polling mode)**:
```
main.ts
  → bot.start() — grammY long polling
```

**Bot request lifecycle**:
```
POST /webhook/<token>
  → handleWebhook (grammY)
  → authMiddleware  (loads ctx.user from DB)
  → rateLimitMiddleware (20/60s per user)
  → [orderRateLimitMiddleware if /long or /short]
  → command handler
```

New users (`ctx.user === undefined`) only hit `/start`. All other commands guard with `if (!ctx.user) return` and prompt to run `/start`.

---

## Critical Path to Production Trading

The single biggest blocker is the `getKitSigner()` gap in `src/services/wallet.ts`. To enable live trading:

1. Implement a Privy → `@solana/kit` `KeyPairSigner` bridge
   - `@solana/kit` expects a signer with `address` + `signTransactions()` interface
   - Privy's server-auth provides `walletApi.solana.signTransaction()` which returns signed bytes
   - The bridge needs to wrap Privy's signing call into the `@solana/kit` signer interface
2. Verify `@ellipsis-labs/rise` SDK package name is stable (CLAUDE.md notes it "must be confirmed")
3. Fix the 7 documented bugs above
4. Add `ws` and `@types/ws` to `package.json`

Everything else — DB, Redis, BullMQ, WebSocket alerts, referrals, market data — appears structurally complete.

---

## Observations & Architectural Notes

- **No trade confirmation state in DB**: Long/short confirmation uses Telegram callback data to pass parameters (symbol, leverage, size, slippage). This means if the bot restarts between showing the confirm button and the user tapping it, the callback still works because all data is in the callback payload, not server state.

- **No realized PnL tracking**: The `/pnl` command shows only unrealized PnL from the current trader state. There's no local database of realized trades — history is fetched live from Phoenix API.

- **Referral claim is manual**: `/claim` updates the DB and tells the user "funds arrive within 24h" but doesn't trigger any on-chain USDC transfer. Presumably handled by backend/ops process polling `claimable > 0`.

- **Price alerts fire once**: A dedup key with 1h TTL prevents re-alerting for the same price threshold. After 1h, if price is still above/below the threshold, another alert could fire. There's no "cancel after trigger" logic — alerts stay active indefinitely.

- **WS bootstrap is wallet-address-based**: The worker re-subscribes users by scanning Redis keys matching the cached trader state pattern. This pattern requires users to have had at least one WebSocket event cached; brand-new users won't be resubscribed on worker restart until their first event.

- **No leverage validation in `/setsl` or `/settp`**: The TP/SL commands don't validate whether the trigger price makes sense relative to current mark price (e.g., setting an SL above current price for a long). This would result in an immediate trigger on the exchange.

- **Satori font loading**: The Inter-Bold font is loaded via `fs.readFileSync` at call time in `generatePnlCard()`. In production with high `/share` usage, this could be a bottleneck — the font should be cached in module scope.
