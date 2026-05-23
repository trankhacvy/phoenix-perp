# Phoenix Perp Bot — Deep Research Report

## Overview

`phoenix-perp-bot` is a **Telegram-based perpetuals trading bot** built on the Phoenix DEX (Ellipsis Labs) on Solana. It provides an embedded, non-custodial wallet experience (via Privy) with full margin trading, position management, real-time alerts, and a two-tier referral program. Users never handle private keys — the wallet is fully server-managed through Privy's server-auth SDK.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js, ESM modules (`"type": "module"`) |
| Language | TypeScript (strict, NodeNext resolution) |
| Bot framework | grammY + `@grammyjs/parse-mode` |
| Web server | Fastify v5 |
| Database | PostgreSQL (Drizzle ORM, postgres.js driver) |
| Cache / session | Redis (ioredis) |
| Job queue | BullMQ |
| Wallet | Privy server-auth (embedded Solana wallets) |
| Blockchain RPC | Helius |
| Trading SDK | `@ellipsis-labs/rise` v0.4.9 |
| Image generation | Satori + Sharp (PnL cards, wallet cards) |
| Logging | pino + pino-pretty |
| Lint / format | Biome |
| Testing | Vitest (unit + integration configs) |
| Package manager | pnpm |

---

## Process Architecture

Three independently deployed services (Railway):

```
┌──────────────────────────────────────────────────┐
│  Bot  (src/main.ts)                              │
│  ├─ grammY bot (long-poll dev / webhook prod)    │
│  └─ Fastify server (POST /webhook/:token)        │
└────────────────────┬─────────────────────────────┘
                     │ alertQueue (BullMQ / Redis)
┌────────────────────▼─────────────────────────────┐
│  Alert Worker  (src/workers/alert.ts)            │
│  ├─ BullMQ consumer (concurrency 10)             │
│  ├─ Dedup via Redis NX (5s window)               │
│  └─ bot.api.sendMessage → Telegram               │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│  WS Worker  (src/workers/ws.ts)                  │
│  ├─ Phoenix WebSocket subscriptions per wallet   │
│  ├─ Risk tier transition detection               │
│  ├─ Fill detection                               │
│  └─ alertQueue.add(job) → Alert Worker           │
└──────────────────────────────────────────────────┘
```

The bot and workers **never call each other directly**. The bot publishes jobs to BullMQ; the alert worker consumes them. The WS worker can also publish. Redis pub/sub (`monitor:events` channel) is used for real-time subscribe/unsubscribe coordination between bot and WS worker.

---

## Bot Request Flow

```
Telegram → POST /webhook/<token>  (Fastify)
  → handleWebhook (grammY webhookCallback)
    → authMiddleware        # loads ctx.user by telegramId
    → actionLogMiddleware   # measures time, logs command + outcome
    → rateLimitMiddleware   # 20 req/min global; 5 orders/min for /long and /short
      → command handler
```

`ctx.user` is `undefined` for new (unregistered) users. The `/start` command handles onboarding. All other commands guard with `if (!ctx.user)` and short-circuit with an error.

---

## Multi-Step Flow Pattern (Redis Pending State)

Complex commands (/long, /short, /withdraw, /setsl, /settp, etc.) use Redis-backed pending state to span multiple message exchanges:

```
pending:<telegramId> → "action:arg1:arg2"  (TTL 10 min)
```

A free-text handler in `src/bot/index.ts` dispatches based on this key. Example for `/long BTC`:
1. User sends `/long BTC`
2. Bot sets `pending:<id>` = `"trade_leverage:long:BTC"`, shows leverage picker keyboard
3. User taps leverage button → callback clears pending, sets `"trade_size:long:BTC:10"`
4. User enters size → flow computes preflight → shows confirm screen
5. User taps Confirm → trade executes → pending cleared

Supported pending actions: `withdraw_amount`, `trade_leverage`, `trade_size`, `pricealert`, `addmargin`, `editsl`, `edittp`, `monitor_add`.

---

## Database Schema

### users
PK: `id` (telegram_id as text). Key columns: `telegramId`, `privyUserId`, `walletAddress`, `phoenixActivated`, `referralCode` (8-char hex), `referredBy`.

### alert_subscriptions
Enum types: `at_risk`, `cancellable`, `liquidatable`, `fill`, `tpsl_flip`, `price`, `funding_flip`, `large_funding`. Per-user, per-type, per-symbol toggles. Price alerts carry `triggerPrice`.

### action_logs
Full audit trail: command, jsonb args (secrets redacted), outcome enum, errorCode/errorCategory, durationMs, txSignature. Indexed on (userId, createdAt) and (command, createdAt). Retention: rows older than 30 days auto-purged hourly via `startActionLogRetention()`.

### referrals
Tier enum: `t1` (direct, 20% of builder fee), `t2` (indirect, 10%). Tracks `accruedUsdc` and `claimedUsdc` per referral row. Independent of Phoenix's native referral program.

### user_settings
Per-user: `slippageBps` (default 50 = 0.5%), `defaultLeverage` (default 5x).

### wallet_monitors
Users can subscribe to alerts on any third-party wallet. Unique on `(userId, watchedWallet)`. Flags: `alertOnFill`, `alertOnPositionChange`.

### leaderboard_snapshots
On-chain GPA discovery results. Stores per-wallet: collateral, unrealized PnL, portfolio value, realized PnL, win/loss counts, volume. Unique on `walletAddress`. Indexed on portfolio_value, realized_pnl, updated_at.

---

## Phoenix / Rise SDK Integration

### Key Concepts
- **Phoenix USDC** (`PhUsd...`) is distinct from standard USDC (`EPjFWdd5...`). All deposits/withdrawals go through the **Ember proxy contract** (1:1 wrapping).
- **Account PDA:** `(wallet_authority, portfolio_index, subaccount_index)`. `subaccount_index=0` = cross-margin; `>0` = isolated.
- **Isolated-only markets:** GOLD, SILVER, SKR, WTIOIL. Require a dedicated isolated subaccount.
- **Builder fees (Flight):** 10–15 bps, taker-only. Routed through Flight MEV-protection layer.
- **Builder activation:** Users are activated via `POST /v1/invite/activate` with the bot's `BUILDER_ACCESS_CODE`. Users don't need their own codes.

### Client Singletons (`src/services/phoenix/client.ts`)
Two singletons:
- `getPhoenixClient()` — read-only, no builder
- `getTradingClient()` — builder-enabled, validates `BUILDER_AUTHORITY_PUBKEY ≥ 43 chars`

### Market Data (`src/services/phoenix/market.ts`)
- `getMarkets()` — cached 60 seconds
- `getMarketSnapshot(symbol)` — mark price, tick size, funding rate, max leverage, leverage tiers, isolated-only flag; wrapped in `withRetry`
- `getOrderbook(symbol)` — live bid/ask/mid

### Trader State (`src/services/phoenix/position.ts`)
- `getTraderState(wallet)` — aggregates all subaccounts (cross + isolated), computes leverage from margin/notional, sums PnL and funding
- `fetchAllTradeHistory(wallet, maxFills=500)` — paginated cursor fetch
- `computeWalletAnalytics(wallet)` — full stats: volume, realized PnL, win rate, per-market breakdown, best/worst trade

### Trade Execution (`src/services/phoenix/trade.ts`)
- `placeMarketOrder` — IOC market order, returns tx signature
- `placeLimitOrder` — limit order
- `setTpSl` — TP/SL ladder (multiple levels), builds stop instructions
- `closePosition` — fractional close (25/50/100%), uses `fractionToCloseLots()`
- `addMargin` / `depositCollateral` / `withdrawCollateral` — collateral management

### Preflight Validation (`src/services/phoenix/preflight.ts`)
Before any trade executes, `preflightOpen()` validates:
1. Phoenix account activated
2. Not an isolated-only market (unless isolated subaccount exists)
3. Market exists and price is live
4. Leverage within market tier limits
5. Notional within tier USD bounds
6. `margin + fees ≤ availableCollateral`
7. Price drift within slippage tolerance (if anchor price provided)

Returns: `effectiveLeverage`, `notional`, `feeUsdc`, `availableCollateral`, estimated `liqPrice`, `totalCost`.

### Unit Conversion (`src/services/phoenix/lots.ts`)
- `marginToTokens` — `(margin × leverage) / price`, rounded to `baseLotsDecimals`
- `fractionToCloseLots` — `fraction × abs(rawLots)` as BigInt
- Validates minimum position size

---

## Wallet & Identity

- **Privy** creates one embedded Solana wallet per user, keyed by `telegramId`.
- `createEmbeddedWallet(telegramUserId)` → `privy.importUser()` → extract Solana wallet.
- `getWalletSigner(walletAddress)` → returns a signer that calls `privy.walletApi.solana.signTransaction()`.
- `getKitSigner(walletAddress)` → for test mode, uses a local `KeyPairSigner` from `TEST_KEYPAIR` env var. Production Privy adapter is **not yet implemented** (throws).
- `activatePhoenixAccount(wallet)` → `POST /v1/invite/activate` with `BUILDER_ACCESS_CODE`.

---

## Referral System

Two-tier structure independent of Phoenix's native program:

```
User A (referrer, T1) → invites → User B
User B (referee)      → invites → User C
  ↓ On User C's trade:
  T1: User B gets 20% of builder fee (T1 referral row)
  T2: User A gets 10% of builder fee (T2 referral row)
```

- **Fee accrual:** `accrueReferralFee(userId, notionalUsdc)` → updates `accruedUsdc` on T1 and T2 rows.
- **Claim:** minimum $1 claimable; `claimedUsdc` updated on claim.
- **Known bug:** T2 lookup can pick up a T2 row as the parent — needs `eq(referrals.tier, "t1")` filter.

---

## Alert Pipeline

```
WS Worker detects event
  → alertQueue.add({telegramId, type, message, symbol})
    → Alert Worker processes job
      → Redis NX dedup check (key: alert:dedup:<id>:<type>:<symbol>, 5s TTL)
      → bot.api.sendMessage (HTML parse_mode)
```

Alert types triggered by WS worker:
- **Risk tier transitions:** `at_risk`, `cancellable`, `liquidatable`, `backstopLiquidatable`, `highRisk`
- **Fill alerts:** position opened/closed
- **TP/SL flip:** take-profit or stop-loss triggered
- **Funding direction flips**
- **Price alerts:** trigger price crossed
- **Wallet monitor:** third-party wallet position changes

WS worker maintains per-wallet WebSocket connections. Reconnect logic: max 3 attempts on close. Monitor subscribe/unsubscribe is coordinated via Redis pub/sub (`MONITOR_EVENTS_CHANNEL`).

---

## Image Generation

Two card types generated with Satori (JSX → SVG) + Sharp (SVG → PNG):

### PnL Card (`generatePnlCard`)
- 1200×630px canvas
- Background: win/loss themed image
- Left panel: symbol, direction badge, realized PnL, ROI%
- Bottom bar: entry price, exit price, size, duration
- Font: Space Grotesk (Regular 400, Bold 700, static TTF embedded)

### Wallet Card (`generateWalletCard`)
- Similar layout for trader summary
- Fields: wallet address, realized PnL, win rate, total fills, volume, best/worst trade

Both rendered synchronously in the bot process. Sharp converts SVG bytes to PNG `Buffer`, which is sent via `InputFile` as a Telegram photo.

---

## Leaderboard (On-Chain Discovery)

- `discoverTraderWallets()` — `getProgramAccounts(PHOENIX_PROGRAM_ID)` with `memcmp` filter using the trader account discriminant `[41, 97, 73, 105, 110, 214, 112, 9]` (SHA256 of `"account:trader"`). Extracts authority pubkey at offset 56.
- `hydrateTrader(wallet)` — fetches trader state from Phoenix API, computes portfolio value.
- Snapshots stored in `leaderboard_snapshots`. `/leaderboard` command reads from DB, paginated, sortable by realized PnL or portfolio value.

---

## Error Handling

### BotError System (`src/bot/lib/errors.ts`)
All errors are converted to typed `BotError` via `toBotError(err)`:

| Code | Category | User message |
|------|----------|-------------|
| `INVALID_INPUT` | validation | "Invalid value entered" |
| `SIZE_TOO_SMALL` | validation | "Position size is too small" |
| `LEV_OUT_OF_RANGE` | validation | "Leverage outside allowed range" |
| `UNKNOWN_MARKET` | validation | "Market not found" |
| `PHOENIX_NOT_ACTIVATED` | auth | "Account not activated on Phoenix" |
| `INSUFFICIENT_MARGIN` | validation | "Not enough margin available" |
| `ISOLATED_ONLY_MARKET` | gate | "Market requires isolated subaccount" |
| `PRICE_DRIFT` | validation | "Price moved too much since quote" |
| `NO_POSITION` | validation | "No open position for that market" |
| `SLIPPAGE_EXCEEDED` | tx_failed | "Transaction exceeded slippage tolerance" |
| `BLOCKHASH_EXPIRED` | network | "Transaction expired, please retry" |
| `INSUFFICIENT_SOL` | config | "Need ~0.01 SOL for transaction fees" |
| `RATE_LIMIT` | ratelimit | "Too many requests" |
| `NETWORK` | network | "Network error, please retry" |
| `UNKNOWN` | internal | "Unexpected error occurred" |

`renderBotError(ctx, err)` formats and sends the error to the user with a hint and retry indicator. All errors are logged with category/code in `action_logs`.

---

## Message Formatting Rules

**Always use `@grammyjs/parse-mode`** — never raw HTML or `parse_mode: "HTML"`.

```typescript
const msg = fmt`${bold("BTC · LONG")}  (Cross)
Entry  ${bold("$87.00")}`;

await ctx.reply(msg.text, { entities: msg.entities });
```

For alert worker messages (sent via bare `bot.api.sendMessage`): currently uses `parse_mode: "HTML"` directly — this is an inconsistency with the bot's formatting rule.

Key helpers: `FormattedString.b()`, `.i()`, `.u()`, `.code()`, `.link()`, `FormattedString.join(arr, sep)`.

---

## Number Formatting Utilities (`src/bot/lib/fmt.ts`)

| Function | Description |
|----------|-------------|
| `usd(n)` | `$1,234.56` |
| `price(n)` | `$87.25` / `$0.0001` (precision-aware) |
| `pct(n)` | `+1.23%` / `-4.56%` |
| `fundingApr(rate)` | Annualized % with direction sign |
| `pnlEmoji(n)` | `🟢` / `🔴` |
| `signedUsd(n)` | `+$1.23` / `-$4.56` |
| `compactUsd(n)` | `$1.2M` / `$500K` / `$123` |
| `fundingTrend(rates)` | `↑↑` / `↑` / `→` / `↓` / `↓↓` |
| `cryptoSize(n, sym)` | `1.25 BTC` |
| `shortAddr(addr)` | `abc1...xyz4` |
| `timeAgo(ts)` | `2h ago` / `3d ago` |
| `parseAmount(raw)` | Strip `$`/spaces, parse float |
| `parseLeverage(raw)` | Strip `x`/`X`, parse float |
| `solscanUrl(sig)` | Solscan tx URL |

---

## Pagination Pattern

All list views (/positions, /markets, /history, /leaderboard) use a shared `paginate<T>()` helper:
- Returns `{ items, page, totalPages, hasPrev, hasNext }`
- `addPaginationRow(kb, callbackPrefix, page, total)` appends `← Prev | Page X / Y | Next →` to any inline keyboard
- Page size: typically 5 items

Deep links via `/start <payload>`:
- `pos_<symbol>_<side>` → open position detail
- `hist_<globalIdx>_<page>` → open trade history at entry
- `mkt_<symbol>_<page>` → open market at page

---

## Retry Logic (`src/lib/retry.ts`)

`withRetry(fn, opts)` with exponential backoff:
- Default 3 attempts, 1000ms base delay, doubles each attempt
- Default retry condition: `/rate.?limit|429|network|timeout|fetch failed/i`
- Used on market snapshot fetches and Phoenix API calls

---

## Configuration & Environment Validation

`src/config/index.ts` uses Zod to validate all env vars at startup. Crashes immediately with field-level errors on any missing required var. Key vars:

| Variable | Notes |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | required |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | required |
| `BUILDER_AUTHORITY_PUBKEY` | min 43 chars (Flight pubkey) |
| `BUILDER_ACCESS_CODE` | for Phoenix activation |
| `BUILDER_FEE_BPS` | 1–50 bps (default 10) |
| `PHOENIX_API_URL` | default `https://perp-api.phoenix.trade` |
| `PHOENIX_WS_URL` | default `wss://perp-api.phoenix.trade/v1/ws` |
| `HELIUS_RPC_URL` | required Solana RPC |
| `DATABASE_URL` | required PostgreSQL |
| `REDIS_URL` | required Redis |
| `WEBHOOK_URL` | optional (production only) |
| `TEST_KEYPAIR` | dev/test only, base58 keypair for test signer |

---

## Commands Registry

| Command | Description |
|---------|-------------|
| `/start [code]` | Onboarding, deep links, jurisdiction check |
| `/portfolio` | Account snapshot (collateral, PnL, positions, risk tier) |
| `/deposit` | Wallet address + QR code |
| `/withdraw [amount]` | 2-step security delayed withdrawal |
| `/export` | Privy private key export instructions |
| `/long [sym] [lev] [size]` | Open long (3-step guided or one-shot) |
| `/short [sym] [lev] [size]` | Open short (3-step guided or one-shot) |
| `/positions` | Paginated position list + detail drill-down |
| `/markets` | Market browser (price, funding, max leverage) |
| `/setsl <symbol>` | Stop-loss presets or custom |
| `/settp <symbol>` | Take-profit ladder or custom |
| `/history` | Trade history (last 30 fills, paginated) |
| `/share <symbol>` | Generate PnL card PNG |
| `/referral` | Referral link + T1/T2 counts + accrued USDC |
| `/claim` | Claim accrued referral rebates (min $1) |
| `/alerts` | Toggle alert type subscriptions |
| `/alert <symbol>` | Set price alert trigger |
| `/settings` | Slippage tolerance + default leverage |
| `/funding` | Top 10 markets by funding APR |
| `/leaderboard` | On-chain trader leaderboard |
| `/log` | Recent action logs |
| `/wallet` | Wallet address, balance, settings |
| `/monitor add <addr>` | Subscribe to third-party wallet alerts |

Navigation callbacks: `nav:balance`, `nav:deposit`, `nav:withdraw`, `nav:positions`, `nav:history`, `nav:long`, `nav:short`, `nav:alerts`. All trigger the corresponding handler.

---

## Known Bugs (Phase 0 — from CLAUDE.md)

1. **`src/bot/commands/alerts.ts`** — Alert toggle `findFirst` missing `type` filter; may match wrong subscription type.
2. **`src/bot/commands/deposit.ts` + `share.ts`** — `replyWithPhoto` receives raw `Uint8Array`; needs `new InputFile(uint8array, "card.png")`.
3. **`src/bot/commands/long.ts` + `short.ts`** — Confirm callback regex `(\d+)` rejects decimal leverage and size values.
4. **`src/services/referral.ts`** — T2 chain lookup can pick a T2 referral row as the parent referrer; needs `eq(referrals.tier, "t1")` filter added.
5. **`ws` package missing** — `src/workers/ws.ts` imports `ws` but it may not be in `package.json` as a direct dependency (risk of resolution failure).
6. **`vitest.config.ts` present** but was initially listed as missing in bug list; confirmed present in repo.
7. **`src/db/schema/settings.ts` missing** — `user_settings` table is referenced in `drizzle.config.ts` schema list but the file needs to exist with the correct export.

---

## Architecture Specifics & Non-Obvious Details

### ESM Strict Import Rules
`"type": "module"` + `"moduleResolution": "NodeNext"`. All imports require `.js` extensions even for `.ts` source files. `require()` is prohibited everywhere.

### Action Log Retention
`startActionLogRetention()` runs hourly via `setInterval`, deletes `action_logs` rows older than 30 days. Called once from `src/main.ts` on startup.

### Rate Limit Tiers
Two separate Redis keys per user:
- `ratelimit:<id>` — 20 req/min global
- `ratelimit:orders:<id>` — 5 orders/min (only for /long and /short)

### Price Drift Protection
When user first views the trade confirm screen, the current mark price is captured as `anchorPrice`. When they tap Confirm (potentially seconds later), `preflightOpen` re-validates price drift vs slippage tolerance (default 50 bps = 0.5%). If price moved more than that, the trade is rejected with `PRICE_DRIFT`.

### Builder Fee Routing
Trading client (`getTradingClient()`) includes a `builderFee` config with the `BUILDER_AUTHORITY_PUBKEY`. Phoenix's Flight layer routes taker orders through this for MEV protection and collects the builder fee on-chain. The bot then off-chain accrues referral shares into the DB — these are rebates that must eventually be paid out from builder revenue.

### Leaderboard GPA Discovery
Uses Solana `getProgramAccounts` with a `memcmp` filter at offset 0 for the 8-byte discriminant. Authority pubkey extracted at offset 56 from raw account data. This is a low-level on-chain scan — rate-limited by Helius RPC and should only run periodically.

### Alert Dedup Key
`alert:dedup:<telegramId>:<type>:<symbol>` with 5s `NX` TTL. For alerts without a symbol (e.g., risk tier alerts), the key omits the symbol component. This means a user can receive at most one alert per type per 5 seconds.

### WS Worker Reconnection
Each wallet gets its own WebSocket connection. On `close` event: up to 3 reconnect attempts with delay. The `watcherIndex` (Map from wallet → Set of telegramIds) and `ownerMap` (wallet → owner telegramId) are maintained in-memory only — restarts lose state and require re-subscription.

### Test Mode
If `TEST_KEYPAIR` is set, `authMiddleware` auto-creates a user using the test signer instead of Privy. `getKitSigner()` returns the local `KeyPairSigner` for signing transactions in tests. This allows end-to-end trade testing without Privy.

### Isolation Between Bot and Alert Worker
The alert worker imports `bot` from `src/bot/index.ts` purely to call `bot.api.sendMessage`. It does not register any handlers or middleware. The bot instance is used only as an API client, not as a running bot (no `bot.start()` in the alert worker).
