# SuperNova — Deep Codebase Research Report

## 1. What It Is

SuperNova is a **Telegram bot for trading perpetual futures on Phoenix Exchange (Solana)**, branded as "SuperNova". Users interact entirely through Telegram — they get a custodial Solana wallet, deposit USDC, and trade perps with leverage, all without leaving the chat interface.

The bot is a **single Node.js process** (no microservices, no Docker) that bundles four components: the Telegram bot, a WebSocket manager for real-time Phoenix data, a BullMQ alert worker, and a leaderboard scanner.

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js, ESM (`"type": "module"`, `.js` extensions in imports) |
| Language | TypeScript (strict, ES2022 target, NodeNext module resolution) |
| Bot framework | grammY (Telegram Bot API) |
| HTTP server | Fastify (webhook mode only) |
| Database | PostgreSQL via Drizzle ORM + postgres.js driver |
| Job queue | BullMQ (Redis-backed) |
| Cache / state | ioredis (pending flows, dedup, rate limits, position cache) |
| Blockchain | Solana via `@solana/kit` + `@solana/signers` + `@solana/web3.js` |
| Exchange SDK | `@ellipsis-labs/rise` (Phoenix perp SDK) |
| Wallet custody | Privy server-side embedded wallets |
| Image generation | Satori (JSX→SVG) + Sharp (SVG→PNG) |
| Technical analysis | `technicalindicators` (RSI, MACD, Bollinger, ATR) |
| Linting | Biome (formatter + linter, 100-char lines, double quotes) |
| Testing | Vitest (unit + integration configs) |
| Package manager | pnpm |

---

## 3. Architecture

### 3.1 Process Model

Everything starts from `src/main.ts`. Startup sequence:

1. Load test signer if `TEST_KEYPAIR` is set (dev mode)
2. Start action log retention (daily cleanup of 30-day-old logs)
3. Start alert worker (BullMQ consumer, 10 concurrent)
4. Start WS manager (per-user Phoenix WebSocket subscriptions + allMids price feed)
5. Start leaderboard scanner (production only — GPA discovery + periodic hydration)
6. Register 15 bot commands with Telegram
7. Start bot in **webhook mode** (production: Fastify server) or **polling mode** (dev)
8. Graceful shutdown on SIGTERM/SIGINT

### 3.2 Request Flow (Bot Commands)

```
Telegram → POST /webhook/<token>  (Fastify, production)
         → grammY polling          (dev)
  → sequentialize(ctx.from.id)     (serialize per-user)
  → authMiddleware                  (load ctx.user from DB by telegramId)
  → actionLogMiddleware             (track command, duration, outcome)
  → rateLimitMiddleware             (Redis INCR, 20 req/60s)
  → command handler or callback handler
```

`ctx.user` is `undefined` for new users — only `/start` handles onboarding. All other commands guard with `if (!ctx.user)`.

### 3.3 Multi-Step Flows (Pending State)

Commands like trading, deposit, withdraw use Redis-backed pending state:

```
Redis key: `pending:<telegramId>` → value: `<action>:<params>`
TTL: 600 seconds
```

A catch-all `bot.on("message:text")` handler in `src/bot/index.ts` reads this key and dispatches to the correct handler. Examples:
- `trade_size_input:long:SOL` — user typing custom margin amount
- `trade_lev_input:short:BTC:500` — user typing custom leverage
- `withdraw_amount:<address>` — user typing withdrawal amount
- `deposit_amount` — user typing deposit amount
- `pricealert_price:<symbol>` — user typing price alert target

### 3.4 Alert Pipeline

```
WS worker detects event (position change, risk tier, fill, price cross)
  → alertQueue.add(job)
  → Alert worker picks up job
  → Dedup check: Redis NX key `dedup:alert:<telegramId>:<type>` (5s window)
  → bot.api.sendMessage (HTML format + inline keyboard)
```

Alert types:
- **Risk tiers**: atRisk, cancellable, liquidatable, backstopLiquidatable, highRisk
- **Order fills**: symbol, side, size, price, notional, fee
- **TP/SL flip**: position reversed, existing orders cleared
- **Price alerts**: user-defined price targets (above/below)
- **Wallet monitor**: open/close/flip events on watched wallets
- **Funding flip/large funding**: funding rate direction changes
- **WS error**: connection lost notification

### 3.5 WebSocket Manager (`src/workers/ws.ts`)

Maintains per-wallet WebSocket connections to Phoenix:

- **Own wallets**: subscribes every registered user's wallet at startup
- **Monitored wallets**: subscribes wallets that users are watching
- **allMids feed**: single connection for all market mid-prices (price alerts)

Key data structures:
- `connections: Map<wallet, WebSocket>` — active WS connections
- `ownerMap: Map<wallet, telegramId>` — bot user → their own wallet
- `watcherIndex: Map<wallet, Set<telegramId>>` — wallet → who's watching
- `ownerUserIdCache: Map<wallet, userId>` — for referral fee accrual

Reconnection: 5s delay, max 3 failures before notifying user. Connections cleaned up when no watchers remain.

Redis pub/sub channel `monitor:events` allows bot commands to dynamically subscribe/unsubscribe monitored wallets without restarting the WS manager.

### 3.6 Leaderboard Scanner (`src/workers/leaderboard.ts`)

Two-phase trader discovery:

1. **GPA scan** (every 30 min): `getProgramAccounts` on Phoenix program to discover all trader PDAs on-chain. Parses discriminant, authority pubkey, collateral, market count. Seeds `leaderboard_snapshots` table.

2. **Hydration** (backfills stale entries every 2 hours): Fetches live trader state from Phoenix API (collateral, positions, unrealized PnL, risk tier). Optionally fetches trade history for volume/win rate/realized PnL.

3. **WebSocket discovery**: New traders seen via WS events are upserted and hydrated immediately.

4. **Wallet tags**: `data/wallet-tags.json` provides metadata (name, twitter, avatar, tags) for known wallets.

Rate-limit aware: aborts batch if 10+ consecutive 429s.

---

## 4. Database Schema (8 Tables)

### `users`
Primary identity table. PK is a UUID `id`, but `telegramId` is the real unique key.
- `telegramId` (string, unique) — Telegram user ID
- `username`, `firstName` — display info
- `privyUserId`, `privyWalletId` — Privy wallet custody IDs
- `walletAddress` — Solana public key
- `phoenixActivated` (boolean) — whether Phoenix trading account is activated
- `referralCode` — bot-native 8-char hex referral code
- `referredBy` — who referred this user

### `alert_subscriptions`
Per-user toggle for each alert type.
- `type` (pgEnum: at_risk, cancellable, liquidatable, fill, tpsl_flip, price, funding_flip, large_funding)
- `symbol` (nullable — null means all markets)
- `triggerPrice` (for price alerts)
- `enabled` (boolean)

### `referrals`
Two-tier referral chain tracking.
- `referrerId`, `refereeId` — FK to users
- `tier` (pgEnum: t1, t2) — direct vs indirect referral
- `accruedUsdc`, `claimedUsdc` — numeric(18,6) for fee tracking

### `user_settings`
User preferences.
- `slippageBps` (default 50 = 0.5%)
- `defaultLeverage` (default 5)

### `wallet_monitors`
Track up to 10 wallets per user.
- `watchedWallet` — Solana address to monitor
- `label` — optional display name
- `alertOnFill`, `alertOnPositionChange` — toggle flags
- Unique constraint: `(userId, watchedWallet)`

### `action_logs`
Audit trail for every bot interaction.
- `command`, `args` (JSONB) — what was executed
- `outcome` (success/error), `errorCode`, `errorCategory`
- `durationMs` — execution time
- `txSignature` — on-chain tx if applicable
- 30-day auto-retention cleanup

### `leaderboard_snapshots`
Cached trader stats for leaderboard display.
- `walletAddress` (unique)
- Collateral, effective collateral, unrealized PnL, portfolio value, accumulated funding
- `riskTier`, `positionCount`
- `totalVolume`, `realizedPnl`, `winCount`, `lossCount`, `totalTrades`
- `discoveredVia` (gpa / ws_trades)
- `metadata` (JSONB: name, twitter, avatar, tags)
- `lastHydratedAt` — staleness tracking

### `trades`
Local record of trades executed through the bot.
- `symbol`, `side`, `action` (open/close)
- `marginUsdc`, `leverage`, `notionalUsdc`
- `baseUnits`, `markPrice`, `feeUsdc`
- `closeFraction` — for partial closes
- `txSignature`, `status`

---

## 5. Phoenix Integration (`src/services/phoenix/`)

### 5.1 Client (`client.ts`)

Two singleton clients via `@ellipsis-labs/rise`:
- **Read client**: API + RPC URLs, no flight builder (for queries)
- **Trading client**: adds `flight.builderAuthority` for MEV-protected order routing (if valid pubkey configured)

Both use lazy initialization. `exchangeMetadata.stream: false` — no streaming metadata.

### 5.2 Market Data (`market.ts`)

- **Exchange config**: cached 5 minutes. Lists all markets with leverage tiers, fees, etc.
- **Market snapshots**: cached 30 seconds. Includes mark price (from orderbook mid), funding rate, max leverage, taker/maker fees, leverage tiers (converted to USD notional limits), open interest.
- **Isolated-only markets**: GOLD, SILVER, SKR, WTIOIL — require isolated subaccounts (not yet supported by the bot).
- **Market list items**: parallel fetched with `Promise.allSettled` for graceful degradation.

### 5.3 Position State (`position.ts`)

`getTraderState(wallet)` returns aggregated view across all subaccounts:
- Cross account (subaccountIndex=0) provides effective collateral and risk tier
- All positions aggregated with computed fields: side (from virtualQuotePosition sign), leverage (from initial margin), TP/SL prices
- Trade history via `getTraderTradesHistory` with cursor-based pagination (max 500 fills for analytics)

`computeWalletAnalytics(trades)` computes: volume, realized PnL, win rate, best/worst trades, per-market breakdown, long/short ratio, maker count.

### 5.4 Pre-Trade Validation (`preflight.ts`)

`preflightOpen()` runs 8 validation checks before any trade:

1. **Activation gate** — user must have `phoenixActivated = true`
2. **Isolated-only check** — rejects GOLD/SILVER/SKR/WTIOIL
3. **Input validation** — margin > 0, leverage >= 1
4. **Market exists** — fetches snapshot (skipCache if anchor price provided)
5. **Live price** — mark price must be > 0
6. **Collateral check** — totalCost (margin + fee) <= effective collateral
7. **Leverage tier enforcement** — notional must fit within tier limits
8. **Price drift detection** — if anchor price provided, drift must be within user's slippage tolerance (default 50 bps)

Returns: effective leverage (capped at market max), notional, fee, available collateral, liquidation price, total cost.

Liquidation price formula: `markPrice * (1 - 1/leverage + mmFrac)` for longs, `markPrice * (1 + 1/leverage - mmFrac)` for shorts, where `mmFrac = 0.5 / maxLeverage`.

### 5.5 Trade Execution (`trade.ts`)

**Transaction construction pattern:**
1. Build SDK instruction (market order, limit order, TP/SL, deposit, withdraw)
2. Get signer (test keypair or Privy embedded wallet)
3. Add compute budget (250K units, 200K microlamports/CU)
4. Add Jito MEV tip (200K lamports to random tip account from 10-account pool)
5. Sign with `signTransactionMessageWithSigners`
6. Submit via **Helius Sender** (`sender.helius-rpc.com/fast`) — not standard RPC
7. Poll confirmation (2s intervals, 60 attempts, validates against block height deadline)

**Supported operations:**
- `placeMarketOrder` — IOC order with base units
- `placeLimitOrder` — limit order with price and base units
- `setTpSl` — multi-level TP/SL via `buildPlaceStopLoss` (NOTE: fraction ignored — every rung is full-position close, TODO documented)
- `closePosition` — reduce-only IOC order for fraction of position (reads current position lots from snapshot)
- `cancelStopLoss` — cancel by execution direction
- `addMargin` / `depositCollateral` / `withdrawCollateral` — collateral management
- `transferUsdc` — SPL token transfer with idempotent ATA creation

**Blockhash caching**: 20-second TTL to reduce RPC calls during bursts.

### 5.6 Lot Conversion (`lots.ts`)

`marginToTokens(market, marginUsdc, leverage, overridePrice?)`:
- Computes `baseTokens = notional / price`
- Converts to base lots: `tokens / 10^(-baseLotsDecimals)`
- Validates minimum size (1 base lot after rounding)
- Returns string representation for SDK

`fractionToCloseLots(rawLots, fraction)`:
- Handles partial closes (25%, 50%, 100%)
- Ensures minimum 1 lot
- Returns BigInt lots count

### 5.7 Technical Analysis (`candles.ts`)

Fetches OHLCV candles from Phoenix API and computes:
- RSI (14 periods)
- MACD (12, 26, 9)
- Bollinger Bands (20 periods, 2 std dev)
- ATR (14 periods)

Used in `/markets` detail view to show technical indicators.

---

## 6. Bot Commands (Complete Inventory)

### Account Management
| Command | File | Description |
|---------|------|-------------|
| `/start` | `start.ts` | Onboarding: creates Privy wallet, stores user, shows welcome. Handles deep links (`long_SOL_0`, `pos_SOL_long`, `trade_<txSig>`, `wallet_<addr>`) |
| `/activate` | `activate.ts` | Activates Phoenix trading account via Flight builder `POST /v1/invite/activate` |
| `/deposit` | `deposit.ts` | Two-step: (1) send USDC to bot wallet (shows QR), (2) add as collateral on Phoenix |
| `/withdraw` | `withdraw.ts` | Withdraw to bot wallet (instant) or external address (two txs: withdraw collateral + transfer USDC) |
| `/settings` | `settings.ts` | Set slippage tolerance (0.1%–2.0%) and default leverage (2–50x) |
| `/wallet` | `wallet.ts` | View any trader's analytics: portfolio, positions, performance, per-market breakdown. Generates wallet summary card image |

### Trading
| Command | File | Description |
|---------|------|-------------|
| `/long [SYM] [LEV] [SIZE]` | `long.ts` | Open long. No args → symbol picker. Symbol only → size step. Full args → confirm. Size-first flow: size → leverage → confirm |
| `/short [SYM] [LEV] [SIZE]` | `short.ts` | Mirror of `/long` for short positions |
| `/positions` | `positions.ts` | List open positions or view detail. Actions: close (25/50/100%), add margin, set SL/TP, refresh |
| `/setsl` | `setsl.ts` | Set stop loss with preset % buttons or custom price input |
| `/settp` | `settp.ts` | Set take profit with preset % buttons or custom price input |

### Information
| Command | File | Description |
|---------|------|-------------|
| `/portfolio` | `portfolio.ts` | Full account overview: wallet balance, trading collateral, open P&L, positions summary, risk tier |
| `/markets` | `markets.ts` | Paginated market browser with funding rates, max leverage. Detail view includes technicals (RSI, MACD, Bollinger, ATR) |
| `/history` | `history.ts` | Trade history with P&L, paginated. Also works for arbitrary wallet addresses |
| `/funding` | `funding.ts` | Top 10 funding rates across all markets |
| `/leaderboard` | `leaderboard.ts` | Top traders sorted by volume, win rate, or realized PnL. Pagination, trader detail drill-down |
| `/share` | `share.ts` | Generate and share PnL card image for most recent closed trade on a symbol |

### Alerts & Monitoring
| Command | File | Description |
|---------|------|-------------|
| `/alerts` | `alerts.ts` | Toggle alert types: fills, risk, TP/SL flip, funding flip, large funding |
| `/pricealert` | `pricealert.ts` | Set price alerts for specific symbols (above/below current) |
| `/wallet-monitor` or inline | `wallet-monitor.ts` | Monitor up to 10 wallets. Get alerts when they open/close/flip positions. Copy-trade buttons |

### Referral
| Command | File | Description |
|---------|------|-------------|
| `/referral` | `referral.ts` | Show referral link, direct/indirect counts, accrued vs claimable rebate |
| `/claim` | `claim.ts` | Withdraw claimable referral rebate (minimum $1) |

### Admin/Dev
| Command | File | Description |
|---------|------|-------------|
| `/export` | `export.ts` | Dev-only: export private key from Privy |
| `/log` | `log.ts` | Admin-only: view last 10 action logs for a user |
| `/status` | `status.ts` | Dev-only: preview all 9 alert message formats |
| `/help` | `help.ts` | Help menu with categories |

---

## 7. Trade Flow (Detailed)

The trade flow is **size-first** (not leverage-first):

```
/long (no args)
  → Symbol picker (paginated, 8 per page, shows price + max leverage)
  → User taps symbol

/long SOL  (or taps symbol button)
  → Size step: shows balance, asks "how much to risk?"
  → Preset buttons: 10%, 25%, 50%, 100% of max safe margin
  → Or "Custom" → Redis pending state → free-text input

User picks size (e.g., $500)
  → Leverage step: shows leveraged notional for each option
  → Buttons: 2x, 5x, 10x, 25x, 50x (filtered by market max)
  → Default leverage highlighted
  → Funding cost shown inline if significant
  → Or "Custom" → Redis pending state → free-text input

User picks leverage (e.g., 10x)
  → Confirm step: full order summary
  → Entry price, notional, fee (bps + USD), liq price (distance %), daily funding cost
  → Single confirm button: "✅ Long $5,000 of SOL"

User confirms
  → Rate limit check (5 orders/60s)
  → Idempotency key claimed (120s TTL, prevents double-click)
  → Preflight validation (8 checks)
  → If price drifted: inline refresh button (not restart)
  → Message edited to "⏳ Submitting order to Solana…"
  → Async execution (fire-and-forget from callback):
    1. marginToTokens() → base units
    2. trackAction() wraps placeMarketOrder()
    3. recordTrade() to DB (fire-and-forget)
    4. subscribeUser() for WS alerts
    5. Edit message with success: entry, size, fee, liq price, Solscan link
    6. Offer SL/TP buttons
  → On failure: edit message with error + retry/back buttons
```

**One-liner shortcut**: `/long BTC 10x 500` skips symbol picker, size step, and leverage step — goes straight to confirm.

---

## 8. Wallet & Identity

### Privy Integration (`src/services/wallet.ts`)

- Each Telegram user gets a **server-side embedded Solana wallet** via Privy
- Wallet creation: `privy.walletApi.create({ chainType: "solana" })` on first `/start`
- Signing: `getPrivyKitSigner(walletAddress)` creates a `TransactionPartialSigner` that calls `privy.walletApi.solana.signTransaction()`
- Authorization: uses ED25519 signing with `PRIVY_AUTHORIZATION_PRIVATE_KEY` for request auth

### Dev Mode
- `TEST_KEYPAIR` env var: loads a local Solana keypair for testing without Privy
- Auto-creates test user in auth middleware if not in DB
- Blocked in production via Zod refinement

### Phoenix Activation
- New users must activate via Flight builder: `POST /v1/invite/activate` with `BUILDER_ACCESS_CODE`
- Users don't need their own invite codes — bot uses a single builder access code
- Activation status stored in `users.phoenixActivated`

---

## 9. Referral System

Two-tier, bot-native referral program (independent of Phoenix's native referral which requires $10K volume):

- **Code generation**: 8-character uppercase hex (`crypto.randomBytes(4).toString("hex").toUpperCase()`)
- **T1 (direct)**: user A refers user B → A gets T1 referral row
- **T2 (indirect)**: B refers C → A gets T2 referral row for C
- **No T3**: chain stops at 2 levels (enforced by `eq(referrals.tier, "t1")` filter on parent lookup)
- **Self-referral prevention**: referrer can't be referee
- **Fee accrual**: on every fill detected via WS, `accrueReferralFee(userId, notional)` is called
  - Builder fee rate: `BUILDER_FEE_BPS` (default 10 bps)
  - T1 gets 20% of builder fee
  - T2 gets 10% of builder fee
- **Claiming**: `/claim` withdraws if accrued >= $1

---

## 10. Image Generation (`src/services/image.ts`)

Two card types, both using Satori (JSX→SVG) + Sharp (SVG→PNG):

### PnL Card
- 1200×630 pixels
- Background: `win.jpg` or `lost.jpg` with gradient overlay (opaque left → transparent right)
- Left panel: market, direction badge (▲/▼ with color), realized PnL (large), ROI %
- Bottom stats bar: entry price, exit price, size, duration
- Font: Space Grotesk (400 + 700 weights)
- Credit watermark: "Created by @trankhac_vy"

### Wallet Summary Card
- Same dimensions and layout
- Shows: trader address (truncated), total PnL, win rate, best/worst trade
- Bottom bar: fills count, volume, avg PnL

---

## 11. Error Handling (`src/bot/lib/errors.ts`)

### BotError Class
Custom error with structured fields:
- `category`: validation, auth, config, api, network, ratelimit, tx_failed, io, gate, internal
- `code`: specific error code (e.g., `INSUFFICIENT_MARGIN`, `PRICE_DRIFT`, `BLOCKHASH_EXPIRED`)
- `userMessage`: safe for display to user
- `hint`: optional action suggestion
- `retryable`: boolean
- `meta`: arbitrary data for logging

### Error Classification (`toBotError`)
Pattern-matches raw errors against regex patterns to produce user-friendly BotErrors:
- Blockhash expiry → retryable network error
- Insufficient SOL → "deposit SOL for gas"
- Telegram 5xx → retryable API error
- Margin errors → validation with deposit hint
- No open position → validation
- Isolated-only market → validation with `/markets` hint
- Slippage → retryable with "reduce size or widen slippage"
- Network errors (ECONNRESET, timeout) → retryable

### Error Rendering (`renderBotError`)
Formats error for Telegram display with bold title, message, hint, retry indicator. Supports edit mode (for inline callbacks) and custom keyboards.

---

## 12. Middleware Stack

### Auth (`middleware/auth.ts`)
- Loads user from DB by `ctx.from.id` (Telegram user ID)
- Sets `ctx.user` (undefined if not found)
- Dev mode: auto-creates test user from `TEST_KEYPAIR` if not in DB

### Rate Limiting (`middleware/rate-limit.ts`)
Three independent limiters, all Redis-backed:
- **General**: 20 requests per 60 seconds per user (applied to all updates)
- **Order**: 5 orders per 60 seconds per user (applied at confirm callbacks)
- **Manual check**: `checkOrderRateLimit()` for use in callback handlers

Implementation: `INCR` + `EXPIRE` pattern on `ratelimit:<telegramId>` keys.

### Action Logging (`middleware/action-log.ts`)
Wraps every handler to capture:
- Command name + args
- Start/end time (duration in ms)
- Outcome (success/error)
- Error code + category
- TX signature (if trade)

Supports `ctx.actionLog = { skip: true }` to suppress logging for intermediate steps (e.g., before async trade execution takes over its own logging).

Sensitive field redaction: passwords, API keys, mnemonics, seeds, tokens, private keys — replaced with `[REDACTED]` recursively in JSONB args.

---

## 13. Utility Libraries

### Formatting (`bot/lib/fmt.ts`)
Rich formatting helpers:
- `num(n, min, max)` — locale-aware number formatting
- `usd(n)`, `price(n)` — currency formatting with appropriate precision
- `pct(n)` — percentage with sign
- `funding1h()`, `fundingDir()`, `fundingDot()`, `fundingTrend()`, `fundingDailyUsd()` — funding rate display (direction arrows, dots, daily USD cost)
- `pnlEmoji()`, `signedUsd()` — P&L with visual indicators
- `cryptoSize()` — smart rounding for crypto amounts
- `shortAddr()` — truncated Solana address
- `parseAmount()`, `parseLeverage()` — input parsing with validation
- `compactUsd()` — large USD formatting ($1M, $100K)
- `liqDistanceLabel()` — liquidation distance with direction

### Pagination (`bot/lib/paginate.ts`)
Generic pagination: `paginate(items, page, pageSize)` returns `{ items, page, totalPages }`.
`addPaginationRow(keyboard, prefix, page, totalPages)` adds `◀ / ▶` buttons.

### Idempotency (`bot/lib/idempotent.ts`)
`claimIdempotencyKey(userId, callbackId)`: Redis SETNX with 120s TTL. Prevents double-submit on confirm buttons.

### Pending State (`bot/lib/pending.ts`)
Redis-backed flow context: `setPending(telegramId, action)` / `getPending(telegramId)` / `clearPending(telegramId)`. 600s TTL.

### Retry (`lib/retry.ts`)
Generic retry with exponential backoff: `withRetry(fn, { attempts, baseDelayMs, retryIf })`. Default retries on rate limits, network errors, timeouts.

---

## 14. Configuration & Environment

### Zod Validation (`src/config/index.ts`)

All env vars validated at startup via Zod schema. Crashes with field-level errors on failure.

**Required:**
- `TELEGRAM_BOT_TOKEN` — bot token
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET` — wallet custody
- `BUILDER_AUTHORITY_PUBKEY` — Phoenix Flight builder pubkey
- `HELIUS_RPC_URL` — Solana RPC
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection string

**Optional with defaults:**
- `NODE_ENV` (default: development)
- `PORT` (default: 3000), `HOST` (default: 0.0.0.0)
- `BUILDER_FEE_BPS` (default: 10)
- `PHOENIX_API_URL` (default: `https://perp-api.phoenix.trade`)
- `PHOENIX_WS_URL` (default: `wss://perp-api.phoenix.trade/v1/ws`)
- `BUILDER_ACCESS_CODE` (default: empty string)

**Conditional:**
- `WEBHOOK_URL`, `WEBHOOK_SECRET` — required for production webhook mode
- `TEST_KEYPAIR` — dev-only, blocked in production
- `PRIVY_AUTHORIZATION_PRIVATE_KEY` — required when TEST_KEYPAIR not set

---

## 15. Testing

### Unit Tests (8 files)
- `trade-flow.test.ts` — leverage parsing, order rate limiting
- `errors.test.ts` — BotError construction, toBotError SDK adapter (12+ error patterns)
- `fmt.test.ts` — funding rate formatting, liquidation distance labels
- `action-log.test.ts` — sensitive field redaction (recursive, nested objects/arrays)
- `image.test.ts` — PnL card generates non-empty Buffer for profit/loss trades
- `lots.test.ts` — marginToTokens, fractionToCloseLots, baseLotsToTokens, error cases
- `market.test.ts` — isIsolatedOnly for GOLD/SILVER/SKR/WTIOIL
- `preflight.test.ts` — 10+ validation scenarios (activation, margins, leverage tiers, price drift, collateral)
- `referral.test.ts` — unique code generation

### Integration Tests (2 files)
- `alerts.test.ts` — alert subscription toggling, creation
- `referral.test.ts` — T1/T2 chaining, self-referral prevention, no T3

### Test Setup (`tests/setup.ts`)
Sets `NODE_ENV=test` and configures mock credentials for all services.

---

## 16. CI/CD

GitHub Actions workflow at `.github/workflows/ci.yml`. Deployed to **Coolify** with PostgreSQL + Redis (no Docker files in repo).

---

## 17. Key Design Decisions & Patterns

1. **Single process** — no container orchestration, no separate worker processes. Simplifies deployment but limits horizontal scaling.

2. **Privy for wallet custody** — users never see private keys (unless `/export` in dev). Server-side signing means the bot can execute trades on behalf of users without approval prompts.

3. **Helius Sender for tx submission** — bypasses standard RPC `sendTransaction`. Uses Helius's optimized sender endpoint with skipPreflight + maxRetries=0, then polls confirmation manually.

4. **Jito MEV tips** — every transaction includes a 200K lamport tip to a random Jito tip account. Provides MEV protection for trade execution.

5. **Size-first trade flow** — user picks risk amount before leverage. This is more intuitive for most traders than the leverage-first approach.

6. **Anchor price + drift detection** — the price shown at confirm time is embedded in the callback data. On execution, preflight re-checks and rejects if price moved beyond slippage tolerance, offering inline refresh instead of restarting the flow.

7. **Async execution from callbacks** — after confirm, the message is edited to "⏳ Processing…" and trade execution happens in a fire-and-forget async IIFE. This prevents Telegram callback timeout (30s limit) for slow on-chain transactions.

8. **Entity-based formatting** — all bot messages use `@grammyjs/parse-mode` with `FormattedString` entities. Never raw HTML. This avoids HTML injection and handles entity offsets correctly.

9. **Action logging with redaction** — every command is audit-logged with duration, outcome, and error details. Sensitive fields are recursively redacted before storage.

10. **Copy-trade via wallet monitoring** — monitored wallet alerts include "Copy Long" / "Counter Short" buttons that deep-link directly into the trade flow for the same symbol.

---

## 18. Known Limitations & TODOs

1. **Isolated margin not supported** — GOLD, SILVER, SKR, WTIOIL markets are blocked. The bot only trades on cross-margin subaccountIndex=0.

2. **TP/SL ladder fractions ignored** — `setTpSl` has a TODO: `level.fraction` is ignored; every rung becomes a full-position close. Need to switch to `buildPlacePositionConditionalOrder` with `sizeBaseLots/sizePercent`.

3. **No limit orders in trade flow** — the UI only offers market orders. `placeLimitOrder` exists in trade.ts but has no bot command wiring.

4. **Single-process scaling** — all WS connections, job processing, and bot handling run in one process. Heavy leaderboard GPA scans could impact bot responsiveness.

5. **Leaderboard only in production** — `startLeaderboardScanner()` is gated by `NODE_ENV === "production"`.

6. **Rate limit on hydration** — leaderboard hydration aborts after 10 consecutive 429s. Large trader pools may never fully hydrate.

7. **Phoenix USDC vs standard USDC** — Phoenix uses its own USDC (`PhUsd...`). Deposits/withdrawals go through the Ember proxy which wraps 1:1. The bot handles this via the Rise SDK's `buildDepositIxs`/`buildWithdrawIxs`.

8. **No Docker/container setup** — deployment is manual or via Coolify. No Dockerfile or docker-compose.

---

## 19. File Count Summary

| Directory | Files | Purpose |
|-----------|-------|---------|
| `src/bot/commands/` | 28 | Command handlers |
| `src/bot/keyboards/` | 3 | Inline keyboard builders |
| `src/bot/lib/` | 7 | Bot utilities |
| `src/bot/middleware/` | 3 | Auth, rate limit, action log |
| `src/services/phoenix/` | 7 | Exchange integration |
| `src/services/` | 6 | Business logic |
| `src/db/schema/` | 9 | Database tables |
| `src/db/migrations/` | 11 | SQL migrations |
| `src/workers/` | 2 | Background workers |
| `src/jobs/` | 2 | Job queue |
| `src/lib/` | 5 | Shared utilities |
| `src/server/` | 2 | HTTP server |
| `tests/` | 12 | Unit + integration |
| `docs/` | 30+ | Phoenix protocol docs |
| **Total** | **~130** | |
