# Phoenix Perp Bot — Research Report

## 1. Project Overview

`phoenix-perp-bot` is a Telegram-native trading interface for [Phoenix](https://phoenix.trade), a Solana-based perpetual futures DEX. Users never leave Telegram: they deposit USDC, open leveraged long/short positions, manage TP/SL, and receive real-time risk/fill alerts — all through bot commands. Wallets are created and held server-side via [Privy](https://privy.io) embedded wallets, so users need no Phantom or seed phrase.

**Version:** 0.1.0 — MVP Phase 0/1 (partially functional; on-chain execution stubs not bridged)

---

## 2. Architecture

### 2.1 Process Model

Three independently deployed processes (intended for Railway.app):

| Process | Entry point | Role |
|---|---|---|
| **Bot** | `src/main.ts` | grammY Telegram bot + Fastify webhook server |
| **WS Worker** | `src/workers/ws.ts` | Phoenix WebSocket subscriptions, risk/fill detection, price alert scanning |
| **Alert Worker** | `src/workers/alert.ts` | BullMQ consumer; deduplicates and dispatches Telegram messages |

They share Redis and Postgres but **never call each other directly**. The WS worker emits jobs to BullMQ (`alertQueue`); the alert worker consumes them.

```
Telegram Update
  → Fastify POST /webhook/{token}
    → grammY webhookCallback
      → authMiddleware  (loads ctx.user from DB)
      → rateLimitMiddleware  (Redis INCR, 20 req/min)
      → command handler

WS Worker
  → Phoenix WS traderState/allMids
    → alertQueue.add(job)
      → Alert Worker
        → Redis NX dedup (5s)
          → bot.api.sendMessage(telegramId)
```

### 2.2 Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.7, ES modules (`"type":"module"`) |
| Runtime | Node.js 22+, `tsx` for dev |
| Bot | grammY v1.31 |
| HTTP server | Fastify v5.2 + `@fastify/cors` |
| Database | PostgreSQL via `drizzle-orm` + `postgres.js` |
| Cache / Queue | Redis (`ioredis` v5.4) + BullMQ v5.34 |
| Blockchain | `@solana/kit` v6.9, `@solana/web3.js` v1.98 |
| Phoenix SDK | `@ellipsis-labs/rise` v0.4.9 (Rise SDK) |
| Embedded wallet | `@privy-io/server-auth` v1.20 |
| Image rendering | `satori` + `sharp` + `@resvg/resvg-js` |
| Logging | `pino` v9.6 (pino-pretty in dev, JSON in prod) |
| Linting | Biome 1.9.4 |
| Testing | Vitest 2.1 |

### 2.3 Import Rules

`"moduleResolution": "NodeNext"` — all imports must include `.js` extensions even when the source is `.ts`. CommonJS `require()` is forbidden.

---

## 3. Configuration & Environment

**File:** `src/config/index.ts` — Zod schema validates all env vars at startup; missing or malformed vars crash with field-level errors before the bot touches anything.

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot identity |
| `WEBHOOK_URL` | Production Fastify webhook base URL |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Embedded wallet provider |
| `BUILDER_AUTHORITY_PUBKEY` | Phoenix Flight routing (builder fee) |
| `BUILDER_ACCESS_CODE` | Bulk Phoenix account activation code |
| `BUILDER_FEE_BPS` | Builder fee in basis points (default 10, range 1–50) |
| `PHOENIX_API_URL` | REST API base (https://perp-api.phoenix.trade) |
| `PHOENIX_WS_URL` | WebSocket URL (wss://perp-api.phoenix.trade/v1/ws) |
| `HELIUS_RPC_URL` | Solana RPC |
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `PORT` / `HOST` | Fastify server binding |
| `TEST_KEYPAIR` | Dev-only: base58 keypair for on-chain testing |

---

## 4. Database Schema (Drizzle ORM + PostgreSQL)

### 4.1 `users`

Primary key is `id` = `telegramId` (text). No auto-increment numeric ID.

| Column | Type | Notes |
|---|---|---|
| `id` | text | PK, telegram_id |
| `telegramId` | text | UNIQUE |
| `username` | text | nullable |
| `firstName` | text | nullable |
| `privyUserId` | text | Privy user ID |
| `walletAddress` | text | Solana address |
| `phoenixActivated` | boolean | default false |
| `referralCode` | text | UNIQUE, 8-char hex |
| `referredBy` | text | code used at signup |
| `createdAt` / `updatedAt` | timestamp | DEFAULT NOW |

### 4.2 `alert_subscriptions`

| Column | Type | Notes |
|---|---|---|
| `id` | text | PK |
| `userId` | text | FK → users.id, CASCADE DELETE |
| `type` | pgEnum | `at_risk \| cancellable \| liquidatable \| fill \| tpsl_flip \| price \| funding_flip \| large_funding` |
| `symbol` | text | null = all markets |
| `triggerPrice` | text | price alerts only |
| `enabled` | boolean | default true |

### 4.3 `referrals`

| Column | Type | Notes |
|---|---|---|
| `id` | text | PK |
| `referrerId` | text | FK → users.id |
| `refereeId` | text | FK → users.id |
| `tier` | pgEnum | `t1 \| t2` |
| `accruedUsdc` | numeric(20,6) | builder fee rebate accrued |
| `claimedUsdc` | numeric(20,6) | claimed by user |

### 4.4 `user_settings`

| Column | Type | Notes |
|---|---|---|
| `userId` | text | PK, FK → users.id, CASCADE |
| `slippageBps` | integer | default 50 (= 0.5%) |
| `defaultLeverage` | integer | default 5 |
| `updatedAt` | timestamp | |

---

## 5. Wallet & Identity

### 5.1 Privy Embedded Wallets

Every user gets a server-side Solana wallet created automatically during `/start`. The flow:

1. `privy.importUser()` with `telegramId` as linked account identifier
2. `privy.walletApi.solana.create()` creates a non-custodial Solana wallet
3. `walletAddress` saved to `users` table

Users never see a seed phrase. They can optionally export via the Privy dashboard (`/export` command redirects there).

### 5.2 Transaction Signing — Critical Gap

`getKitSigner(walletAddress)` in `src/services/wallet.ts` is **not implemented for production**:

- It throws unless `TEST_KEYPAIR` env var is set (dev workaround)
- The Privy `signTransaction` API returns a different format than `@solana/kit` expects
- The bridge between `@privy-io/server-auth` and `@solana/kit` `KeyPairSigner` is an open TODO

**Impact:** Every trade command (`/long`, `/short`, `/deposit`, `/withdraw`, close, TP/SL) will fail at the signing step in production. The bot can display quotes, confirmations, and market data — but cannot execute on-chain.

### 5.3 Phoenix Account Activation

On first `/start`, `activatePhoenixAccount(walletAddress)` calls `POST /v1/invite/activate` with the `BUILDER_ACCESS_CODE`. Phoenix requires activation before the first trade. The builder code enables bulk onboarding — individual users don't need their own codes.

---

## 6. Phoenix SDK Integration

### 6.1 Client Factory (`src/services/phoenix/client.ts`)

Two client variants:

- `getPhoenixClient()` — read-only (market data, positions)
- `getTradingClient()` — includes Flight builder config if `BUILDER_AUTHORITY_PUBKEY.length >= 43`

Flight config passes `builderAuthority` to the Rise SDK so that taker fees are routed through the builder's flight program. If the pubkey is absent/invalid, Flight is skipped silently.

### 6.2 Markets (`src/services/phoenix/market.ts`)

`ISOLATED_ONLY_MARKETS = Set(["GOLD", "SILVER", "SKR", "WTIOIL"])` — these assets cannot be traded cross-margin (subaccount_index must be > 0). The bot labels them `[Isolated — Advanced]` in `/markets` and blocks the standard long/short flow.

`getMarketSnapshot(symbol)` is the main aggregator: combines market config, mid price from orderbook, 24h funding history, leverage tiers, tick size, fee structure, and isolated-only flag into a single object used by trade commands.

### 6.3 Positions (`src/services/phoenix/position.ts`)

`getTraderState(walletAddress)` hits the REST API and parses the raw snapshot:

- Side logic: `virtualQuotePosition <= 0 ? "long" : "short"` (inverted — Phoenix's quote-virtual convention)
- Mark price: `positionValue / positionSize` (derived, not returned directly)
- Risk tiers: `safe → healthy → atRisk → cancellable → liquidatable → backstopLiquidatable`
- Returns effective collateral (discounted unrealized PnL by market risk factor — not raw deposited + uPnL)

### 6.4 Trade Execution (`src/services/phoenix/trade.ts`)

All functions require a `KeyPairSigner` from `getKitSigner()` (broken in prod):

| Function | What it does |
|---|---|
| `placeMarketOrder()` | IOC market order via Rise SDK `ixs.placeMarketOrder()` |
| `placeLimitOrder()` | Limit order with price in ticks |
| `setTpSl()` | Stop-loss and/or take-profit; converts USD price → ticks; market mode adds 10% slippage |
| `closePosition()` | Fetches position size from snapshot; market order with ReduceOnly flag |
| `cancelStopLoss()` | Cancels pending TP/SL by direction (LessThan / GreaterThan execution trigger) |
| `depositCollateral()` | `buildDepositIxs()` — wraps standard USDC through Ember proxy → Phoenix USDC |
| `withdrawCollateral()` | `buildWithdrawIxs()` — subject to global 2M USDC queue (450 USDC/slot replenish) |
| `addMargin()` | Convenience wrapper over `depositCollateral` for isolated positions |

### 6.5 Collateral Model

Phoenix uses its own USDC mint (`PhUsd...`) distinct from standard USDC (`EPjFWdd5...`). Deposits and withdrawals go through the **Ember proxy contract** (`EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy`) at 1:1. The bot instructs users to send standard USDC to their Privy wallet address; `buildDepositIxs()` handles the wrap automatically.

### 6.6 Account PDAs

Account PDA is keyed by `(wallet_authority, portfolio_index, subaccount_index)`:
- `subaccount_index = 0` → cross-margin (all positions share one collateral pool)
- `subaccount_index > 0` → isolated (each position has its own margin)

---

## 7. Bot Commands (22 total)

### 7.1 Onboarding

**`/start [code]`** — full onboarding flow:
1. Attestation gate: inline keyboard "Are you a US person?" — selecting YES blocks the user permanently
2. Creates Privy wallet
3. Activates Phoenix account via builder code
4. Generates unique 8-char hex referral code
5. Links referral chain if `code` provided

### 7.2 Account

| Command | Function |
|---|---|
| `/balance` | Shows Phoenix USDC collateral, effective collateral, uPnL, unsettled funding, wallet SOL |
| `/deposit` | Generates QR code for wallet address; instructions for sending SOL (gas) + standard USDC |
| `/withdraw <amount>` | 2-step confirm with 5-minute security delay; notes withdrawal queue |
| `/export` | Redirects to Privy dashboard for private key export |
| `/settings` | Slippage (0.1–2%, default 0.5%) and default leverage (2–25x, default 5x) |

### 7.3 Trading

**`/long <symbol> <leverage>x <size_usdc>`** and **`/short <symbol> <leverage>x <size_usdc>`**:

1. Fetches `getMarketSnapshot(symbol)`
2. Calculates effective leverage (capped to market max), notional, fees, estimated entry, estimated liquidation price
3. Shows confirmation with encoded callback: `confirm:long:SYMBOL:LEVERAGE:SIZE:MARKPRICE`
4. On confirm: `placeMarketOrder()` → on-chain execution

Liq price formula:
- Long: `entryPrice * (1 - 1/leverage)`
- Short: `entryPrice * (1 + 1/leverage)`

**`/setsl <symbol> <price> [market|limit]`** and **`/settp <symbol> <price> [market|limit]`**:
- Fetches current position to confirm which side to set the trigger on
- Market mode: IOC with ±10% slippage buffer
- Limit mode: standard limit order at exact price

### 7.4 Position Management

**`/positions`** — lists all open positions with inline action keyboard per position:
```
[Close 25%] [Close 50%]
[Close 75%] [Close 100%]
[Add Margin] [Edit SL] [Edit TP]
```
Multi-step flows (add margin, edit SL/TP) use Redis pending state: `pending:{telegramId}` → `action:symbol`. A global `bot.on("message:text")` handler in `src/bot/index.ts` reads this key and dispatches the next action.

**`/history`** — 20 most recent closed trades (symbol, side, price, realized PnL, date)

**`/pnl`** — summary of current unrealized PnL + unsettled funding

### 7.5 Market Data

| Command | Function |
|---|---|
| `/markets` | Paginated list (10/page), badges for isolated-only markets |
| `/price <symbol>` | Mark price, funding APR, open interest; inline `[Long]` `[Short]` `[Alert]` `[Chart]` buttons |
| `/funding` | Top 10 funding rates by APR magnitude with direction label |

### 7.6 Alerts

**`/alerts`** — toggle panel for 8 alert types via inline buttons:

| Type | Default | Trigger |
|---|---|---|
| `at_risk` | ON | Risk tier = AtRisk |
| `cancellable` | ON | Risk tier = Cancellable |
| `liquidatable` | ON | Risk tier = Liquidatable |
| `fill` | ON | Order filled |
| `tpsl_flip` | ON | Position flipped, TP/SL cancelled |
| `price` | OFF | User-defined price threshold crossed |
| `funding_flip` | OFF | Funding rate changes sign (not fully implemented) |
| `large_funding` | OFF | Funding APR > ±50% (not fully implemented) |

**`/alert <symbol> <price>`** — creates custom price alert in `alert_subscriptions` with `type: "price"` and `triggerPrice`. Positive = alert when ≥ price; negative = alert when ≤ price.

### 7.7 Referral & Viral

**`/referral`** — shows `https://t.me/{bot}?start={code}`, T1/T2 counts, accrued/claimable USDC.

**`/share <symbol>`** — generates a PnL card image (1200×630 PNG, Inter Bold, green/red branding) from the most recent closed trade and sends it as a photo.

**`/claim`** — marks all referral `accruedUsdc` as claimed (minimum $1 USDC threshold).

---

## 8. Referral System

Two-tier chain, entirely bot-native (independent of Phoenix's own referral program which requires $10K volume):

- **T1** (direct referral): 20% of builder fee rebate
- **T2** (referral's referral): 10% of builder fee rebate
- Builder fee: `BUILDER_FEE_BPS / 10000 * notional_usdc` (default 10 bps = 0.1%)
- Accrual triggered by WS worker on each fill event via `accrueReferralFee()`

Referral code = 8-char uppercase hex, e.g., `A1B2C3D4`.

---

## 9. Alert Pipeline

```
Phoenix WS (traderState / allMids)
  → WS Worker detects event
    → alertQueue.add({ telegramId, type, message, symbol })
      → BullMQ (Redis-backed)
        → Alert Worker (concurrency: 10)
          → Redis NX dedup (5s TTL per user+type)
            → bot.api.sendMessage(telegramId, message, { parse_mode: "HTML" })
```

Dedup key format: `dedup:alert:{telegramId}:{type}` (5-second window prevents duplicate bursts).

Price alert dedup key: `alert:price:{userId}:{symbol}:{trigger}` — 1 hour TTL (prevents re-firing same threshold multiple times in a short window).

BullMQ job options: 3 retry attempts, exponential backoff (1s initial), keep 100 completed / 500 failed jobs.

---

## 10. Middleware

### 10.1 Auth Middleware (`src/bot/middleware/auth.ts`)

Runs on every update. Looks up user by `telegramId` in Postgres and attaches to `ctx.user`. New users get `ctx.user = undefined`; the `/start` handler is the only one that operates without a user record.

Dev shortcut: if `TEST_KEYPAIR` is set and user is not found, auto-registers the user (skips onboarding for testing).

### 10.2 Rate Limit Middleware (`src/bot/middleware/rate-limit.ts`)

- General commands: 20 requests/minute per user (Redis INCR with 60s TTL)
- Order commands (`/long`, `/short`): 5 orders/minute (separate key)
- Exceeding limit: "Too many requests, please try again" — no command execution

---

## 11. WebSocket Worker Details

**Startup:**
1. Load all `ws:positions:{walletAddress}` Redis keys to find active users
2. Subscribe each to `traderState` channel on Phoenix WS
3. Subscribe to global `allMids` channel

**Per-update logic (traderState):**
- Compares new risk tier to cached previous tier → emits risk alert if changed
- Detects position side flip (long ↔ short) → emits `tpsl_flip` alert
- Detects new fills vs cached fill set → emits `fill` alerts + calls `accrueReferralFee()`
- Caches state in Redis for next comparison

**Per-update logic (allMids):**
- Loads all active price alert subscriptions from DB
- Compares current mid price to `triggerPrice`
- Positive trigger = alert when price ≥ threshold; negative = price ≤ threshold
- Emits `price-alert` job; dedup via 1h Redis key

**Auto-reconnect:** Closes trigger a 5-second backoff before reconnecting.

---

## 12. Image Generation

`src/services/image.ts` renders PnL share cards:

- **Engine:** Satori (JSX → SVG) → resvg (SVG → PNG) → Sharp (PNG compression)
- **Size:** 1200 × 630 px
- **Font:** Inter Bold (loaded from disk at `src/assets/Inter-Bold.ttf`)
- **Content:** symbol, direction (long/short), entry price, exit price, ROI %, PnL in USDC, bot @handle
- **Colors:** green for long, red for short

Used exclusively by `/share <symbol>`.

---

## 13. Known Bugs

Documented in `CLAUDE.md` as "Phase 0" unfixed bugs:

| # | File | Bug | Fix needed |
|---|---|---|---|
| 1 | `src/bot/commands/alerts.ts` | `findFirst` in alert toggle missing `type` filter — may return wrong subscription | Add `eq(alertSubscriptions.type, type)` to query |
| 2 | `src/bot/commands/deposit.ts`, `share.ts` | `replyWithPhoto` receives raw `Uint8Array` / `Buffer` — grammY requires `InputFile` | Wrap: `new InputFile(buffer, "filename.png")` |
| 3 | `src/bot/commands/long.ts`, `short.ts` | Confirm callback regex `(\d+)` rejects decimal prices (e.g., `150.50`) | Change to `([\d.]+)` |
| 4 | `src/services/referral.ts` | `accrueReferralFee()` T2 lookup doesn't filter `tier = "t1"` — can pick a T2 row as T1 parent, creating ghost T3 payouts | Add `eq(referrals.tier, "t1")` filter |
| 5 | `package.json` | `ws` and `@types/ws` missing from dependencies but imported in `src/workers/ws.ts` | Add to dependencies |
| 6 | `vitest.config.ts` | File exists and is valid (counter to original CLAUDE.md note) | — |
| 7 | `src/db/schema/settings.ts` | File exists and defines `userSettings` table (counter to original CLAUDE.md note) | — |

**Critical gap (not a bug — incomplete feature):**
- `getKitSigner()` in `src/services/wallet.ts` throws in production (Privy → @solana/kit bridge unimplemented). All on-chain actions are dead until this is resolved.

---

## 14. Testing

**Setup:** `vitest.config.ts` with `tests/setup.ts` as `setupFiles`.

**Test files found:**
- `tests/unit/services/referral.test.ts` — unit tests for referral fee accrual logic
- `tests/integration/` — integration test harness (uses `TEST_KEYPAIR` for mainnet testing)
- `vitest.integration.config.ts` — separate config for integration tests

Integration tests appear to test the full on-chain flow against mainnet Phoenix (hence the `HELIUS_RPC_URL` and `TEST_KEYPAIR` requirements).

---

## 15. Deployment Notes

### Railway.app Services

Three services expected:
1. **bot** — runs `src/main.ts`
2. **worker-ws** — runs `src/workers/ws.ts`
3. **worker-alert** — runs `src/workers/alert.ts`

All share the same Postgres and Redis instances (separate Railway add-ons or external providers).

### Dev Mode

Long-polling is used in dev (`bot.start()`). Webhook is only registered in production when `WEBHOOK_URL` is set. Fastify still starts in dev — it just doesn't receive Telegram traffic (polling takes priority).

### Build

`npm run build` runs `tsc --noEmit` (type check) then emits to `dist/`. No bundling — Node.js runs the compiled JS directly.

---

## 16. Architectural Observations

### Strengths
- Clean separation of concerns: bot, WS worker, alert worker are independently restartable
- BullMQ provides durable job storage — alert jobs survive worker restarts
- Redis dedup prevents alert floods during volatile markets
- Zod config validation fails fast with clear error messages
- Referral system is completely decoupled from Phoenix's native referral (no $10K volume requirement)
- Satori-based PnL card generation is fully server-side (no external image service dependency)

### Weaknesses / Gaps
1. **Wallet signing bridge is the single biggest blocker** — the bot is essentially read-only until `getKitSigner()` works with Privy server-side signing
2. **No retry on failed Telegram messages** — if `bot.api.sendMessage` fails in the alert worker, the job retries but the same HTML message is re-sent (no idempotency concern since dedup NX key already expired)
3. **Isolated-only market handling is incomplete** — `ISOLATED_ONLY_MARKETS` gates the UI but the isolated subaccount creation flow is deferred
4. **No pending state TTL enforcement** — Redis `pending:{telegramId}` keys have no expiry documented; stale pending states could cause unexpected text dispatch
5. **Hardcoded referral percentages** (T1: 20%, T2: 10%) — not configurable via env
6. **WS worker has no horizontal scaling support** — two instances would double-subscribe wallets and double-emit alerts
7. **Alert worker dedup window (5s) is very short** — a fill that triggers multiple alert types in rapid succession would still fire multiple messages

### Interesting Design Choices
- `virtualQuotePosition <= 0 → "long"` is counterintuitive but correct for Phoenix's accounting where quote virtual position represents the notional borrowed
- Effective collateral (discounted uPnL) is used throughout — prevents over-leveraging based on unrealized gains
- The withdrawal queue (450 USDC/slot global budget) is a Phoenix protocol constraint, not a bot choice — the bot correctly surfaces this as "queued" rather than an error
- Builder fee routing via Flight is optional (graceful degradation if `BUILDER_AUTHORITY_PUBKEY` missing)
