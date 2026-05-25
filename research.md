# SuperNova Bot — Deep Codebase Research

## Executive Summary

SuperNova is a **Telegram trading bot** that lets users trade perpetual futures on **Phoenix DEX** (Solana) entirely from within Telegram. It handles wallet creation, deposits, trading, position management, real-time alerts, wallet monitoring, a leaderboard, referral system, and PnL image generation — all in a single Node.js process.

---

## 1. Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+, ESM (`"type": "module"`) |
| Language | TypeScript 5.7, strict `NodeNext` resolution (`.js` extensions mandatory) |
| Bot framework | grammY 1.31 + @grammyjs/parse-mode, auto-retry, runner (sequentialize) |
| HTTP server | Fastify 5 (webhook mode in production) |
| Database | PostgreSQL via postgres.js + Drizzle ORM 0.38 |
| Cache/Queue | Redis (ioredis) + BullMQ 5 |
| Blockchain | Solana — @solana/kit 6.9, @solana/web3.js 1.98, @ellipsis-labs/rise 0.4.9 |
| Wallet custody | Privy server-side embedded wallets (app-owned, server-signed) |
| Images | satori (SVG generation) + sharp (PNG conversion) |
| Technical analysis | technicalindicators (RSI, MACD, Bollinger, ATR) |
| Lint/Format | Biome 1.9 |
| Tests | Vitest 2.1 + @vitest/coverage-v8 |
| CI/CD | GitHub Actions → Coolify webhook deploy |
| Package manager | pnpm 10.15 |

---

## 2. Process Architecture

**Single process** — everything runs from `src/main.ts`:

```
main()
├── initTestSigner() — if TEST_KEYPAIR set (dev only)
├── startActionLogRetention() — daily sweep of 30+ day old logs
├── startAlertWorker() — BullMQ consumer for alert dispatch
├── startWsManager() — WebSocket subscriptions per user + allMids
├── startLeaderboardScanner() — (production only) GPA + WS discovery
├── bot.api.setMyCommands/setMyDescription
└── webhook mode (Fastify server) OR polling mode
```

### Shutdown
Graceful: `SIGTERM`/`SIGINT` → stop bot → close Fastify → stop WS → stop workers.

---

## 3. Bot Request Flow

```
Telegram → POST /webhook/<sha256(token)[:32]> (Fastify)
  → webhookSecret header validation
  → grammY webhookCallback
  → sequentialize (per telegram user ID — serialized per-user)
  → rateLimitMiddleware (20 req/min global, Redis INCR)
  → authMiddleware (loads ctx.user from DB by telegramId)
  → actionLogMiddleware (records commands to action_logs table)
  → command/callback handlers
```

In **development**: grammY long-polling mode (no Fastify needed).

---

## 4. Database Schema (Drizzle ORM)

### Tables

| Table | Purpose | Key columns |
|-------|---------|-------------|
| `users` | PK=telegram_id, wallet_address, privy IDs, phoenixActivated flag, referralCode | `telegramId`, `walletAddress`, `phoenixActivated`, `referralCode`, `referredBy` |
| `alert_subscriptions` | Per-user alert toggles | pgEnum: at_risk, cancellable, liquidatable, fill, tpsl_flip, price, funding_flip, large_funding. `symbol` (null=all), `triggerPrice` |
| `referrals` | T1/T2 chain referral tracking | `referrerId`, `refereeId`, `tier`, `accruedUsdc`, `claimedUsdc` |
| `user_settings` | User preferences | `slippageBps` (default 50), `defaultLeverage` (default 5) |
| `wallet_monitors` | User → watched wallet mapping (max 10/user) | `watchedWallet`, `label`, `alertOnFill`, `alertOnPositionChange` |
| `action_logs` | Command audit trail | `command`, `args` (JSONB), `outcome`, `durationMs`, `txSignature` |
| `leaderboard_snapshots` | All discovered traders | collateral, PnL, volume, win/loss, `metadata` (JSONB for tags/twitter/avatar) |
| `trades` | Local trade log | `symbol`, `side`, `action`, `marginUsdc`, `leverage`, `notionalUsdc`, `txSignature` |

### Migrations
8 migrations (0000–0007) tracked in `src/db/migrations/`.

---

## 5. Phoenix DEX Integration

### SDK: `@ellipsis-labs/rise` 0.4.9

The Rise SDK provides:
- `createPhoenixClient()` — read-only client (exchange config, orderbook, trades, funding)
- Trading client — adds Flight routing (builder fee path)
- `api.exchange()`, `api.orderbook()`, `api.funding()`, `api.traders()`, `api.trades()`, `api.candles()`
- Instruction builders: `placeMarketOrder`, `buildPlaceLimitOrder`, `buildPlaceStopLoss`, `buildCancelStopLoss`, `buildDepositIxs`, `buildWithdrawIxs`

### Client Architecture (`src/services/phoenix/client.ts`)

Two singleton clients:
1. **Read client** — no Flight routing, for fetching data
2. **Trading client** — includes Flight builder authority (10-15 bps taker fee). Only initialized if `BUILDER_AUTHORITY_PUBKEY` is a valid 43+ char pubkey.

### Market Data (`src/services/phoenix/market.ts`)

- Exchange config cached **5 minutes**
- Market snapshots cached **30 seconds**
- Leverage tiers computed per-market (maxLeverage × maxSizeBaseLots → maxNotionalUsdc)
- `ISOLATED_ONLY_MARKETS`: GOLD, SILVER, SKR, WTIOIL (not tradeable via bot — need isolated subaccounts)
- Also checks `market.isolatedOnly` from live config as fallback

### Trade Execution (`src/services/phoenix/trade.ts`)

Full Solana transaction construction pipeline:
1. Build instruction via Rise SDK
2. `addSignersToInstruction` (Solana Kit signers)
3. Construct v0 transaction with compute budget (250K units, 200K μlamports/CU) + Jito tip (200K lamports)
4. Sign via `signTransactionMessageWithSigners`
5. Submit via **Helius Sender** (`sender.helius-rpc.com/fast`, base64, skipPreflight)
6. Poll confirmation (up to 60 attempts × 2s = 2 min timeout, validates against block height deadline)

**Jito tip**: randomly selects from 10 hardcoded tip accounts.
**Blockhash cache**: 10s TTL to avoid redundant RPC calls.

### Operations Available

| Operation | Function | Details |
|-----------|----------|---------|
| Market order | `placeMarketOrder()` | IOC order with computed base units |
| Limit order | `placeLimitOrder()` | With price and base units (no UI wiring yet) |
| Set TP/SL | `setTpSl()` | Builds stop loss instructions per level. **TODO**: fraction ignored — every rung is full-position close |
| Close position | `closePosition()` | ReduceOnly IOC order for fraction of position lots |
| Cancel stop loss | `cancelStopLoss()` | Cancel by execution direction |
| Add margin | `addMargin()` → `depositCollateral()` | Collateral deposit |
| Deposit | `depositCollateral()` | Rise SDK `buildDepositIxs` → `dispatchInstructions` |
| Withdraw | `withdrawCollateral()` | Rise SDK `buildWithdrawIxs` → `dispatchInstructions` |
| Transfer USDC | `transferUsdc()` | Creates ATA idempotently + transferChecked |
| Balance check | `getUsdcAtaBalanceNative()` | Token account balance via RPC |

### Preflight Checks (`src/services/phoenix/preflight.ts`)

Before every trade open, 8 validations:
1. Activation gate (`phoenixActivated`)
2. Isolated-only market check
3. Input validation (margin > 0, leverage >= 1)
4. Live market snapshot fetch
5. Mark price validity (> 0)
6. Balance sufficiency (margin + fees ≤ effectiveCollateral)
7. Leverage tier compliance (notional within tier limits)
8. Price drift detection (vs anchor price, configurable slippage tolerance, default 50 bps)

**Liquidation price formula**: `markPrice × (1 - 1/leverage + 0.5/maxLeverage)` for longs (inverted for shorts).

### Position Tracking (`src/services/phoenix/position.ts`)

- `getTraderState()` → aggregates positions from all subaccounts (cross + isolated)
  - Cross account (subaccountIndex=0) provides collateral + risk tier
  - Position side determined by `virtualQuotePosition.value` sign
  - Leverage approximated from `initialMargin`
- `getTradeHistory()` / `fetchAllTradeHistory()` — cursor-based pagination (max 500 fills)
- `computeWalletAnalytics()` — PnL, volume, win rate, per-market breakdown, best/worst trade, long/short ratio

### Technical Analysis (`src/services/phoenix/candles.ts`)

Fetches 1H candles (60 periods), computes:
- **RSI(14)** — with overbought/oversold labels (>70 / <30)
- **MACD(12,26,9)** — histogram sign for bull/bear
- **Bollinger Bands(20,2)** — upper/lower bands
- **ATR(14)** — volatility measure

Shown in `/markets` detail view.

### Lot Math (`src/services/phoenix/lots.ts`)

- `marginToTokens(snap, marginUsdc, leverage)`: computes `tokens = notional / price`, validates minimum 1 base lot, floor-rounds to lot precision
- `fractionToCloseLots(rawLots, fraction)`: handles partial closes (25/50/100%), returns BigInt
- `baseLotsToTokens(snap, lots)`: converts lots back to tokens for display

---

## 6. Wallet & Identity System

### Privy Integration (`src/services/wallet.ts`)

- **App-owned wallets**: server-side signing without user JWT
- Wallet creation: `privy.users().create()` + `privy.wallets().create({ chain_type: "solana" })`
- Authorization key: PKCS8 DER → SPKI public key derivation for Privy API
- Signing: `createSolanaKitSigner(privy, { walletId, address, authorizationContext })`

### Dev Mode
- `TEST_KEYPAIR` env var → `createKeyPairSignerFromBytes` (bypasses Privy)
- Auto-creates test user in auth middleware with `phoenixActivated=true`
- Blocked in production via Zod refinement

### Phoenix Activation (`src/bot/commands/activate.ts`)
- Two attempts: `POST /v1/invite/activate` (invite code) → if fails, tries `/v1/invite/activate-with-referral` (referral code)
- Users don't need their own invite codes — builder access code can activate

---

## 7. Real-Time Alert System

### WebSocket Manager (`src/workers/ws.ts`)

**Three WebSocket channels:**

1. **Per-user traderState** — one WS connection per registered wallet (max 500)
   - Detects: risk tier changes, position side flips, fills
   - Exponential backoff reconnection (up to 60s, max 3 failures → notifies user)

2. **allMids** — single connection for all market mid-prices
   - Throttled to 1 check/second
   - Checks price alert subscriptions (DB-cached 30s)
   - Price alert dedup: 1 hour per user/symbol/trigger

3. **Wallet monitors** — reuses per-wallet WS connections
   - Detects opens, closes, flips on external wallets
   - Sends copy/counter trade buttons in alerts

### Key data structures:
- `connections: Map<wallet, WebSocket>` — active WS connections
- `ownerMap: Map<wallet, telegramId>` — bot user → their own wallet
- `watcherIndex: Map<wallet, Set<telegramId>>` — wallet → all watchers
- Previous positions cached in Redis (`ws:positions:<wallet>`, 1h TTL) for diff detection

### Wallet Monitoring
- Up to 10 external wallets per user
- Redis pub/sub (`monitor:events` channel) for dynamic subscribe/unsubscribe
- Alert types: monitor_open, monitor_close, monitor_flip, monitor_fill
- Copy/counter trade buttons (skips isolated-only markets)

### Alert Pipeline

```
WS event → alertQueue.add(job) → BullMQ → Alert Worker → bot.api.sendMessage
```

- **Dedup**: Redis `SET NX EX 5` — 5-second window per user+type+symbol
- **Retries**: 3 attempts with exponential backoff (1s base)
- **Non-retryable errors** (user blocked bot, etc.): dropped with warning
- **Concurrency**: 10 parallel alert consumers
- **Queue config**: removeOnComplete=100, removeOnFail=500

### Alert Types

| Type | Trigger | Source |
|------|---------|--------|
| Risk tiers | atRisk, cancellable, liquidatable, backstopLiquidatable, highRisk | traderState WS |
| Fill | Order executed | traderState WS (fills array) |
| TP/SL flip | Position side reversed | Position diff |
| Price alert | User-defined price crossed | allMids WS |
| Monitor events | Watched wallet opens/closes/flips/fills | traderState WS |
| WS error | Connection lost after 3 retries | WS error handler |

---

## 8. Leaderboard System (`src/services/leaderboard.ts` + `src/workers/leaderboard.ts`)

### Discovery Methods

1. **GPA (getProgramAccounts)** — scans Phoenix program (`EtrnLzg...`) for trader PDAs
   - Discriminant: `[41, 97, 73, 105, 110, 214, 112, 9]` (8 bytes)
   - Data slice: offset 8, length 148 (extracts authority, collateral, markets, lastUpdateSlot)
   - Aggregates across subaccounts per wallet

2. **WS trades** — subscribes to all markets' trade channels
   - Discovers new takers in real-time
   - Dedup via Redis NX (1h TTL per wallet)
   - Immediately upserts + hydrates new traders

3. **Bot users** — separately hydrates all activated bot users

### Hydration Pipeline

For each trader:
1. Fetch live trader state from Phoenix API (collateral, PnL, positions, risk tier)
2. Optionally fetch trade history (up to 200 fills)
3. Compute analytics (volume, realized PnL, win/loss count)
4. Upsert to `leaderboard_snapshots` table

### Scheduling

| Interval | Action |
|----------|--------|
| Startup | GPA full scan + bot user hydration + WS trade subscriptions |
| 30 min | Backfill stale traders (batch of 50, collateral > 0, not hydrated in 30 min) |
| 2 hours | Full GPA re-scan + history hydration |

Rate limiting protection: aborts after 10 consecutive 429s. Concurrency: 2 parallel hydrations with 500ms delay between batches.

### Wallet Tags

`data/wallet-tags.json` — pre-labeled wallets with `WalletMetadata` (name, twitter, avatar, tags). Synced to DB at startup.

### Leaderboard Query

Sortable by: `total_volume`, `win_rate`, `realized_pnl`. Paginated (10/page). Filters out wallets with zero collateral.

---

## 9. Trade Flow (User Experience)

### Size-First Flow: `/long` or `/short`

```
1. Symbol picker (paginated, 8/page, deep-linked, shows price + max leverage)
2. Size step → preset amounts (10%, 25%, 50%, 100% of max safe margin) or custom
   - max safe margin = available / (1 + maxLev × totalFeeRate)
   - Validates against collateral
3. Leverage step → preset multipliers (2x, 5x, 10x, 25x, 50x) or custom
   - Shows funding cost estimate at selected leverage
   - Default leverage highlighted from user settings
4. Confirm screen → entry price, notional, fee (bps + USD), liq price (distance %), daily holding cost
5. Execute → placeMarketOrder on-chain
6. Success → SL/TP buttons + Solscan link
```

### One-liner support
`/long BTC 10x 500` — skips interactive flow, goes to confirm. Decimal leverage accepted (`2.5x`).

### Safety mechanisms
- **Trade lock**: Redis NX 150s TTL prevents concurrent trades per user
- **Idempotency key**: per callback query ID, 120s TTL — prevents double-tap
- **Order rate limit**: 5 orders/minute per user
- **Price drift check**: rejects if price moved > slippage tolerance since quote → offers inline refresh
- **Async execution**: trade runs in detached IIFE — UI shows "Submitting..." immediately, avoids Telegram 30s callback timeout
- **Balance re-validation**: checked at preflight (execution time), not just at quote time

---

## 10. Deposit / Withdraw Flow

### Deposit (2-step)
1. **Step 1**: Show wallet address + QR code → user sends standard USDC externally
   - QR generated via `qrcode` npm package (256px PNG)
   - Notes: only standard USDC (`EPjF...Dt1v`), keep ≈0.01 SOL for gas
2. **Step 2**: "I've sent USDC" → check wallet balance → confirm → `depositCollateral()` on-chain
   - Minimum $1
   - "All" or custom amount options
   - Balance re-checked before confirm

### Withdraw
- **Internal** (Phoenix PDA → bot wallet): single `withdrawCollateral()` tx
  - Shows safe vs deposited amounts
  - Warns if amount exceeds safe (affects open positions)
  - Redis lock (150s TTL) prevents concurrent withdrawals
- **External** (Phoenix → bot wallet → external): two transactions
  - Step 1: `withdrawCollateral()`
  - Step 2: `transferUsdc()` (creates ATA idempotently)
  - Requires ~0.001 SOL for gas (checked before confirm)
  - Atomic confirm data stored in Redis (600s TTL, consumed via GETDEL)
  - Handles partial failure: if step 2 fails, funds are in bot wallet (recovery message shown)

---

## 11. Referral System

### Bot-Native Referral (independent of Phoenix's $10K volume requirement)

- Each user gets a unique 8-char hex code at signup (`crypto.randomBytes(4)`)
- **T1**: direct referrer gets **20%** of builder fee
- **T2**: referrer's referrer gets **10%** of builder fee
- **No T3**: chain stops at 2 levels (enforced by T1-only parent lookup)
- Self-referral prevented
- Builder fee: `BUILDER_FEE_BPS / 10000` × notional (default 10 bps)
- **Accrual**: on each fill event (WS worker), updates referral rows with SQL increment
- **Claiming**: `/claim` command (minimum $1, transfers via on-chain USDC)
- **Feature-flagged**: `REFERRAL_ENABLED` env var (default false)

---

## 12. Image Generation (`src/services/image.ts`)

Uses **satori** (React-like virtual DOM → SVG) + **sharp** (SVG → PNG):

### PnL Card (`generatePnlCard`)
- 1200×630px
- Background: `win.jpg` or `lost.jpg` with gradient overlay (opaque left → transparent right)
- Left panel: market name, direction badge (▲ LONG / ▼ SHORT with colored border), realized PnL (large), ROI%
- Bottom stats bar: entry, exit, size, duration (with vertical dividers)
- Font: SpaceGrotesk (400 + 700)
- Credit: "Created by @trankhac_vy"

### Wallet Summary Card (`generateWalletCard`)
- Same layout and dimensions
- Left panel: trader address (truncated), total PnL (large), win rate, best/worst trade
- Bottom bar: fills, volume, avg PnL, best, worst

Generated on: position close (PnL card), wallet analytics view (wallet card).

---

## 13. Action Logging

### Schema: `action_logs`
Records: userId, command, sanitized args (JSONB), outcome, errorCode, errorCategory, durationMs, txSignature.

### Security — Redaction (`src/services/action-log.ts`)
20+ patterns automatically redacted: password, private_key, token, mnemonic, seed, authorization, access_token, refresh_token, keypair, secret_key, database_url, redis_url, webhook_secret, etc.

Recursive: handles nested objects, arrays, Dates, Errors, Buffers.

### `trackAction()` wrapper
Wraps any async operation: times it, records success/failure with BotError classification.

### Retention
Auto-deleted after 30 days (daily `setInterval` sweep in main.ts).

---

## 14. Error Handling

### `BotError` class (`src/bot/lib/errors.ts`)
Structured: `category`, `code`, `userMessage`, `hint`, `retryable`, `meta`.

### Categories
`validation`, `auth`, `config`, `api`, `network`, `ratelimit`, `tx_failed`, `io`, `gate`, `internal`

### SDK Pattern Matching (`toBotError`)
9 regex patterns convert raw errors into structured BotErrors:

| Pattern | Code | Retryable |
|---------|------|-----------|
| `isolated only` | ISOLATED_ONLY_MARKET | No |
| `insufficient sol/lamports` | INSUFFICIENT_SOL | No |
| `insufficient margin/collateral` | INSUFFICIENT_MARGIN | No |
| `trader not registered` | NOT_REGISTERED | No |
| `no open position` | NO_POSITION | No |
| `slippage/price moved` | SLIPPAGE_EXCEEDED | Yes |
| `blockhash not found/expired` | BLOCKHASH_EXPIRED | Yes |
| `rate limit/429` | RATE_LIMIT | Yes |
| `bad gateway/timeout/ECONNRESET` | NETWORK | Yes |

### `renderBotError`
Bold header + message + hint + retry indicator. Supports edit mode + custom keyboards.

---

## 15. Rate Limiting

| Scope | Limit | Window | Key format |
|-------|-------|--------|------------|
| Global per-user | 20 requests | 60s | `ratelimit:<telegramId>` |
| Order submission | 5 orders | 60s | `ratelimit:orders:<telegramId>` |
| Wallet creation | 10 new users | 60s | `ratelimit:wallet_create:global` |

All implemented via Redis `MULTI → INCR → EXPIRE NX → EXEC` (atomic).

---

## 16. Middleware Stack

### 1. `rateLimitMiddleware` — 20 req/min per user
### 2. `authMiddleware` — loads `ctx.user` from DB by `ctx.from.id`
- Dev mode: auto-creates test user if `TEST_KEYPAIR` is set
### 3. `actionLogMiddleware` — records every command
- Captures: command name, args, start time
- On completion: duration, outcome, error code, tx signature
- Supports `ctx.actionLog = { skip: true }` to suppress for intermediate steps
- `ctx.actionLog = { outcome, errorCode, errorCategory }` for manual overrides

### Order rate limit
Applied as middleware to `/long` and `/short` commands, and checked in confirm callbacks via `checkOrderRateLimit()`.

---

## 17. Bot Commands (Complete Inventory)

### Account Management
| Command | File | Description |
|---------|------|-------------|
| `/start` | `start.ts` | Onboarding + deep link handling (pos_, hist_, mkt_, wallet_, long_, short_) |
| `/activate <code>` | `activate.ts` | Activate Phoenix trading via Flight builder API |
| `/deposit` | `deposit.ts` | Two-step: send USDC → add collateral |
| `/withdraw` | `withdraw.ts` | Internal (1 tx) or external (2 tx) withdrawal |
| `/settings` | `settings.ts` | Slippage tolerance + default leverage |
| `/wallet <addr>` | `wallet.ts` | View any trader's analytics + summary card |

### Trading
| Command | File | Description |
|---------|------|-------------|
| `/long [SYM] [LEV] [SIZE]` | `long.ts` | Open long. Size-first flow or one-liner |
| `/short [SYM] [LEV] [SIZE]` | `short.ts` | Mirror of `/long` |
| `/positions` | `positions.ts` | List/detail positions. Close (25/50/100%), add margin, SL/TP |
| `/setsl` | `setsl.ts` | Stop loss (preset % or custom price). Registration commented out |
| `/settp` | `settp.ts` | Take profit. Registration commented out |

### Information
| Command | File | Description |
|---------|------|-------------|
| `/portfolio` | `portfolio.ts` | Full account: wallet SOL/USDC, trading collateral, PnL, positions, risk |
| `/markets` | `markets.ts` | Paginated browser. Detail: price, leverage, OI, funding, technicals |
| `/history` | `history.ts` | Trade history with P&L, paginated |
| `/funding` | `funding.ts` | Top funding rates |
| `/leaderboard` | `leaderboard.ts` | Top traders by volume/win rate/PnL |
| `/share` | `share.ts` | Generate PnL card image |

### Alerts & Monitoring
| Command | File | Description |
|---------|------|-------------|
| `/alerts` | `alerts.ts` | Toggle alert types |
| `/pricealert` | `pricealert.ts` | Set price alerts for specific symbols |
| `/monitor <addr>` | `wallet-monitor.ts` | Monitor up to 10 wallets |

### Referral
| Command | File | Description |
|---------|------|-------------|
| `/referral` | `referral.ts` | Stats: T1/T2 counts, accrued, claimable |
| `/claim` | `claim.ts` | Withdraw claimable referral rebate (min $1) |

### Admin/Dev
| Command | File | Description |
|---------|------|-------------|
| `/export` | `export.ts` | Dev: export private key from Privy |
| `/log` | `log.ts` | Admin: view action logs |
| `/status` | `status.ts` | Dev: preview all alert message formats |
| `/help` | `help.ts` | Help menu |

---

## 18. Utility Libraries

### Formatting (`src/bot/lib/fmt.ts`)
- `num(n, min, max)` — locale-aware number
- `usd(n)`, `price(n)` — currency with precision auto-select
- `pct(n)` — signed percentage
- `funding1h()`, `fundingDir()`, `fundingDot()`, `fundingTrend()`, `fundingDailyUsd()` — funding display
- `pnlEmoji()`, `signedUsd()` — PnL indicators
- `cryptoSize()`, `shortAddr()`, `compactUsd()`, `timeAgo()` — display helpers
- `parseAmount()`, `parseLeverage()` — input parsing (`$` and commas stripped, `x/X` suffix removed)
- `solscanUrl()` — Solscan transaction link

### Pagination (`src/bot/lib/paginate.ts`)
Generic: `paginate(items, page, pageSize)` → `{ items, page, totalPages }`. `addPaginationRow()` adds ◀/▶ buttons.

### Idempotency (`src/bot/lib/idempotent.ts`)
`claimIdempotencyKey(userId, callbackId)`: Redis SETNX 120s. Returns false on duplicate.

### Pending State (`src/bot/lib/pending.ts`)
Redis-backed: `setPending()` / `getPending()` / `clearPending()`. 600s TTL.

### Retry (`src/lib/retry.ts`)
`withRetry(fn, { attempts=3, baseDelayMs=1000, retryIf })`: exponential backoff. Default retries on rate limits, network errors, timeouts.

### Validation (`src/bot/lib/validate.ts`)
`BASE58_RE` — regex for valid Solana addresses.

### Activation (`src/bot/lib/activation.ts`)
`requireActivation(ctx)` — checks `phoenixActivated`, sends prompt if not.

---

## 19. Server & Health

### Fastify Server (`src/server/index.ts`)
- CORS disabled (`origin: false`)
- Webhook endpoint: `POST /webhook/<sha256(token)[:32]>` with secret token validation
- Health endpoint: `GET /health` — checks DB (`SELECT 1`) + Redis (`PING`), returns 200/503

---

## 20. Configuration & Environment

### Zod Validation (`src/config/index.ts`)

**Refinements**:
- `TEST_KEYPAIR` forbidden in production
- `PRIVY_AUTHORIZATION_PRIVATE_KEY` required when `TEST_KEYPAIR` not set
- `WEBHOOK_SECRET` required when `WEBHOOK_URL` is set in production

**Crash-on-invalid**: `process.exit(1)` with field-level errors in dev, field names only in prod.

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot authentication |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | Yes | — | Wallet custody API |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | Conditional | — | Server-side wallet signing |
| `BUILDER_AUTHORITY_PUBKEY` | Yes | — | Phoenix Flight builder identity |
| `BUILDER_FEE_BPS` | No | 10 | Taker fee basis points |
| `BUILDER_ACCESS_CODE` | No | "" | User activation code |
| `REFERRAL_ENABLED` | No | false | Feature flag |
| `TEST_KEYPAIR` | No | — | Dev-only base58 keypair |
| `PHOENIX_API_URL` | No | `https://perp-api.phoenix.trade` | REST API |
| `PHOENIX_WS_URL` | No | `wss://perp-api.phoenix.trade/v1/ws` | WebSocket |
| `HELIUS_RPC_URL` | Yes | — | Solana RPC |
| `DATABASE_URL` | Yes | — | PostgreSQL |
| `REDIS_URL` | Yes | — | Redis |
| `WEBHOOK_URL` | No | — | Telegram webhook (production) |
| `WEBHOOK_SECRET` | Conditional | — | Webhook header validation |
| `PORT` / `HOST` | No | 3000 / 0.0.0.0 | Server binding |

---

## 21. CI/CD Pipeline

### GitHub Actions (`.github/workflows/ci.yml`)
1. **CI job**: pnpm install → Biome check → tsc build → vitest coverage
   - Services: Postgres 16 + Redis 7
2. **Deploy job**: on push to main → triggers Coolify webhook (Bearer token)

---

## 22. Testing

### Unit Tests (9 files)
- `trade-flow.test.ts` — leverage parsing
- `errors.test.ts` — BotError construction, pattern matching
- `fmt.test.ts` — formatting helpers
- `action-log.test.ts` — redaction (recursive, nested)
- `image.test.ts` — PnL card generation (non-empty Buffer)
- `lots.test.ts` — marginToTokens, fractionToCloseLots, edge cases
- `market.test.ts` — isIsolatedOnly
- `preflight.test.ts` — all 8 validation checks
- `referral.test.ts` — unique code generation

### Integration Tests (2 files)
- `alerts.test.ts` — alert subscription toggling
- `referral.test.ts` — T1/T2 chaining, self-referral prevention

---

## 23. Key Design Decisions

1. **Single process** — no container orchestration. Simplifies deployment at cost of scaling.

2. **Privy for custody** — users never see private keys. Server-side signing = trades execute without approval prompts.

3. **Helius Sender** — bypasses standard `sendTransaction`. Optimized for fast inclusion with skipPreflight.

4. **Jito MEV tips** — every tx includes 200K lamport tip. MEV protection for trade execution.

5. **Size-first trade flow** — user picks risk (margin) before leverage. More intuitive than leverage-first.

6. **Anchor price + drift detection** — price at confirm time embedded in callback data. Re-checked at execution. Inline refresh on drift (not flow restart).

7. **Async execution from callbacks** — detached IIFE after "⏳ Submitting..." edit. Prevents Telegram 30s timeout for slow on-chain txs.

8. **Entity-based formatting** — `@grammyjs/parse-mode` with `FormattedString` entities. Never raw HTML. Prevents injection, handles offsets correctly.

9. **Action logging with redaction** — every command audit-logged. 20+ sensitive patterns recursively redacted.

10. **Copy-trade via monitoring** — wallet alerts include "Copy Long" / "Counter Short" buttons that deep-link into trade flow.

---

## 24. Known Limitations & TODOs

1. **Isolated margin not supported** — GOLD, SILVER, SKR, WTIOIL blocked with "coming soon"
2. **TP/SL ladder fractions ignored** — every rung is full-position close (TODO in code: switch to `buildPlacePositionConditionalOrder`)
3. **No limit orders in UI** — `placeLimitOrder()` exists but has no bot command wiring
4. **SetSl/SetTp commands commented out** — registration disabled in `index.ts` (functionality exists via position detail buttons only)
5. **Single-process scaling** — all WS + jobs + bot in one process. 500 WS connection cap.
6. **Liquidation price approximate** — ignores existing cross-margin positions
7. **Rate limit abort** — leaderboard hydration gives up after 10 consecutive 429s
8. **No Docker** — deployed via Coolify, no Dockerfile in repo

---

## 25. Caching Strategy Summary

| Data | TTL | Storage |
|------|-----|---------|
| Exchange config | 5 min | In-memory |
| Market snapshots | 30 sec | In-memory Map |
| Blockhash | 10 sec | In-memory |
| Price alert subscriptions | 30 sec | In-memory |
| WS position state (for diff) | 1 hour | Redis |
| Leaderboard WS dedup | 1 hour | Redis |
| Price alert fired dedup | 1 hour | Redis |
| Alert dedup | 5 sec | Redis |
| Pending state | 600 sec | Redis |
| Idempotency keys | 120 sec | Redis |
| Trade lock | 150 sec | Redis |
| Withdraw lock | 150 sec | Redis |
| Rate limit counters | 60 sec | Redis |

---

## 26. File Organization

```
src/
├── main.ts                    # Entry, startup orchestration, shutdown
├── config/index.ts            # Zod-validated env vars
├── bot/
│   ├── index.ts               # Bot instance, middleware chain, free-text dispatch
│   ├── commands/ (28 files)   # One per command/feature
│   ├── keyboards/ (3 files)   # Inline keyboard builders (market, position, trade)
│   ├── lib/ (7 files)         # errors, fmt, pending, paginate, validate, idempotent, activation
│   └── middleware/ (3 files)  # auth, rate-limit, action-log
├── db/
│   ├── index.ts               # postgres.js + drizzle instance
│   ├── schema/ (9 files)      # Table definitions + type exports
│   └── migrations/            # SQL + snapshots
├── services/
│   ├── phoenix/ (7 files)     # client, market, position, trade, preflight, lots, candles
│   ├── wallet.ts              # Privy wallet management
│   ├── referral.ts            # Referral fee logic
│   ├── leaderboard.ts         # GPA discovery + hydration
│   ├── action-log.ts          # Audit trail with redaction
│   ├── image.ts               # satori/sharp card generation
│   └── trade-log.ts           # Local trade recording
├── workers/
│   ├── ws.ts                  # WebSocket manager (traderState + allMids + monitors)
│   └── leaderboard.ts         # Scanner orchestration
├── jobs/
│   ├── queues.ts              # BullMQ queue definitions
│   └── processors/alert.ts    # Alert consumer
├── server/
│   ├── index.ts               # Fastify setup
│   └── routes/health.ts       # /health (DB + Redis check)
├── lib/
│   ├── constants.ts           # Shared constants
│   ├── logger.ts              # pino logger
│   ├── privy.ts               # Privy client singleton
│   ├── redis.ts               # ioredis singleton
│   └── retry.ts               # Generic retry with exponential backoff
└── types/index.ts             # BotContext, TraderStateEvent, PhoenixPosition, PhoenixFill
```

---

## 27. Dependencies Worth Noting

| Package | Version | Purpose |
|---------|---------|---------|
| `@ellipsis-labs/rise` | ^0.4.9 | Phoenix perp DEX SDK (core trading) |
| `@privy-io/node` | ^0.19 | Server-side wallet custody |
| `@solana/kit` | ^6.9 | Modern Solana tx construction (v0, signers) |
| `@solana/web3.js` | ^1.98 | Legacy Solana (GPA, getBalance) |
| `grammy` | ^1.31 | Telegram Bot API framework |
| `satori` | ^0.10 | SVG from virtual DOM (no browser) |
| `sharp` | ^0.33 | Image processing (SVG→PNG) |
| `technicalindicators` | ^3.1 | RSI, MACD, BB, ATR |
| `qrcode` | ^1.5 | Deposit address QR |
| `bullmq` | ^5.34 | Job queue for alerts |
| `drizzle-orm` | ^0.38 | Type-safe SQL ORM |
| `fastify` | ^5.2 | HTTP server (webhook mode) |
| `bs58` | ^6.0 | Base58 encoding for keypairs |
