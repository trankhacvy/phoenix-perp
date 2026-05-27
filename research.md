# SuperNova Bot — Deep Research Report

## 1. What Is This Project?

**SuperNova** (`supernova-bot`) is a Telegram trading bot for Phoenix perpetual futures on Solana. Users interact entirely through Telegram: create a wallet, deposit USDC, go long/short with leverage, manage TP/SL orders, set automated risk guards, and monitor other traders — all without leaving the chat.

Tech stack in one line: **grammY + Fastify** (transport), **Drizzle ORM + postgres.js** (database), **BullMQ + ioredis** (job queue), **Privy embedded wallets** (key management), **@ellipsis-labs/rise** (Phoenix Solana SDK), **pino** (logging).

---

## 2. Process Model

Single Node.js process (`src/main.ts`). Everything starts from `main()`:

```
main()
├── startActionLogRetention()        — daily DB sweep, 30-day retention
├── startAlertWorker()               — BullMQ consumer (10 concurrent)
├── startMarketRefresher()           — 25-sec Phoenix market cache refresh
├── startWsManager()                 — one WS per wallet subscribed
├── startLeaderboardScanner()        — production only, non-fatal failure
└── bot.start() or webhook mode      — polling vs webhook based on NODE_ENV
```

Shutdown is graceful: SIGTERM/SIGINT → bot.stop → server.close → workers/scanners drain.

No sub-processes, no worker threads. Workers are modules with `start/stop` exports.

---

## 3. Entry Points & Request Flow

### Telegram → Bot

**Polling mode** (dev): `bot.start()` — grammY long-polls Telegram.  
**Webhook mode** (prod): Fastify server on `PORT`, path `/webhook/<sha256-slug-of-token>`, secret token verified by Telegram.

Middleware stack (applied in order):
1. `sequentialize(getSessionKey)` — serializes updates per-user (prevents race conditions on concurrent callbacks)
2. `rateLimitMiddleware` — 20 req/min per user via Redis `INCR`
3. `authMiddleware` — loads `ctx.user` from DB by `telegramId`; no-op if user not found
4. `actionLogMiddleware` — records command name, duration, outcome, tx signature

Special middleware for trade commands: `orderRateLimitMiddleware` (5 orders/min) applied only to `/long` and `/short`.

### Free-text Dispatch

`bot.on("message:text")` handles all multi-step wizard inputs by reading a pending state key from Redis (`pending:<telegramId>`). The key encodes action type and context parameters:

| Pending key pattern | Flow |
|---|---|
| `withdraw_custom:internal` | Withdrawal amount step |
| `deposit_amount` | Custom deposit amount |
| `trade_size_input:side:SYMBOL` | Trade size input |
| `trade_lev_input:side:SYMBOL:AMT` | Leverage input |
| `tpsl_px:leg:SYM:side` | TP/SL price input |
| `tpsl_sz:leg:SYM:side:price` | TP/SL size input |
| `grd_threshold:ruleType:symbol` | Guardian rule threshold |
| `grd_margin_amt:...` | Guardian auto-margin amount |
| `monitor_add` | Add wallet monitor address |
| `pricealert:SYMBOL` | Price alert target |

---

## 4. Identity & Wallet Architecture

### Users Table

```
users
├── id                 — telegram_id cast to text (PRIMARY KEY)
├── telegramId         — unique, used for Telegram message routing
├── privyUserId        — Privy user UUID
├── privyWalletId      — Privy embedded wallet UUID
├── walletAddress      — Solana base58 public key
├── phoenixActivated   — bool, true after builder activation call
├── referralCode       — 8-char hex (bot-native, not Phoenix native)
└── referredBy         — referral code used at signup
```

### Privy Integration (`src/services/wallet.ts`)

- `createEmbeddedWallet()`: creates app-owned (server-custodied) Solana wallet via `@privy-io/node`, links to Telegram ID as account
- `resolvePrivyWalletId()`: fetches wallet UUID from Privy by walletId stored in DB
- `getPrivyKitSigner()`: returns a `CryptoKeyPair`-based Solana Kit signer; **uses `PRIVY_AUTHORIZATION_PRIVATE_KEY`** (bot-first auth model — no user interaction required for signing)

Privy handles all private key storage. The bot never sees raw private keys.

### Phoenix Activation

Users need activation via the builder before trading. `src/bot/lib/activation.ts` and `src/bot/commands/activate.ts` gate this. Builder calls `POST /v1/invite/activate` with `BUILDER_ACCESS_CODE`. Activation is stored as `phoenixActivated = true` in DB.

---

## 5. Phoenix SDK Integration (`src/services/phoenix/`)

### Client (`client.ts`)

Two singleton clients:
- `getPhoenixClient()` — read-only, no flight/builder config
- `getTradingClient()` — includes `flight.builderAuthority` for fee collection

Both use `@ellipsis-labs/rise` (`createPhoenixClient`). Config: Phoenix API URL + Helius RPC URL.

### Market Service (`market.ts`)

- **5-minute cache** for exchange config (full market list)
- **30-second cache** for market snapshots (price, funding, leverage tiers, fees)
- Background refresher at 25-second intervals keeps cache warm
- `isIsolatedOnly(symbol)` — special markets (GOLD, SILVER, SKR, WTIOIL) require isolated subaccounts
- `getMarketStatsHistory()` and `getOrderbook()` for market detail screen
- `getFundingRateHistory()` for funding command

### Trade Service (`trade.ts`)

Core execution functions:
- `placeMarketOrder(symbol, side, wallet, sizeLots, fee)` — immediate fill via Rise SDK
- `placeLimitOrder(symbol, side, wallet, sizeLots, price, fee)` — limit order
- `closePosition(symbol, wallet, fraction, fee)` — close 0–100% of position
- `addMargin(symbol, wallet, amount, fee)` — add collateral to a position
- `depositCollateral(wallet, amount, fee)` — USDC from bot wallet → Phoenix account
- `withdrawCollateral(wallet, amount, fee)` — Phoenix account → bot wallet
- `transferUsdc(wallet, toAddress, amount)` — direct USDC transfer

Fee modes: `eco` / `normal` / `turbo` / `custom`. Custom fee is in SOL (0.0001–0.01). Normal and turbo use Helius priority fee estimates + optional Jito MEV bribe.

Transaction confirmation: polls 60 attempts with exponential backoff.

### Position Service (`position.ts`)

- `getTraderState(walletAddress)` — calls Rise API for cross-account state; computes leverage from effective collateral vs. notional
- `getTradeHistory(wallet, cursor, limit)` — paginated fills (100/page)
- `fetchAllTradeHistory(wallet)` — up to 500 fills
- `computeWalletAnalytics(wallet)` — realized PnL, win rate, volume, best/worst trade, per-market breakdown

### Conditional Orders / TP/SL (`conditional.ts`)

Phoenix supports bracket conditional orders on positions. Key design:
- Trigger ID format: `ctp-{assetId}-{index}-{gt|lt}` (TP) / `csl-...` (SL)
- Max 8 rungs per market per trader account
- PDA init (`buildCreateConditionalOrdersAccount`) is lazy, bundled into first tx, cached per wallet
- Size resolution: `full` (100% of position), `percent`, `lots`, `tokens`
- Execution modes: `market` (IOC with ±10% slippage buffer) or `limit` (exact trigger price)
- Direction: long TP → `greaterTriggerOrder`; long SL → `lessTriggerOrder`; short flipped

### Lots Math (`lots.ts`)

- `marginToTokens(margin, leverage, markPrice, baseLotsDecimals)` → base lots
- `fractionToCloseLots(fraction, positionLots)` → integer lots
- `baseLotsToTokens(lots, decimals)` → human-readable token count

### Pre-flight Checks (`preflight.ts`)

Before opening any trade, checks:
1. Phoenix activation
2. Isolated-only market rule
3. Margin/leverage bounds
4. Available collateral (effective collateral after positions)
5. Fee calculation (taker + builder fee in bps)
6. Leverage tier overflow (notional cap per tier)
7. Price drift vs. anchor (prevents stale confirm execution)
8. Estimated liquidation price

Returns a structured result used to render the confirm screen.

### Candles & TA (`candles.ts`)

- Fetches 60 × 1h OHLCV candles from Phoenix
- Computes: RSI-14, MACD histogram, Bollinger Bands, ATR-14
- Used on the market detail screen

---

## 6. Alert & Monitoring Pipeline

### WebSocket Manager (`src/workers/ws.ts`)

One WebSocket connection to `wss://perp-api.phoenix.trade/v1/ws` **per tracked wallet**. Max 500 connections.

Data structures:
- `connections: Map<wallet, WebSocket>` — active sockets
- `ownerMap: Map<wallet, telegramId>` — bot users own their wallet
- `watcherIndex: Map<wallet, Set<telegramId>>` — multiple watchers per wallet (monitor feature)

Reconnect: exponential backoff (5s base, max 60s), jitter, max 3 failures before alerting user.

On each `traderState` event:
1. Load previous positions from Redis (`ws:positions:{wallet}`)
2. For owner: `evaluatePositionFlip` → `evaluateRiskTier` → `evaluateGuardianRules` → `accrueReferralFee`
3. For watchers: `evaluateMonitorAlerts`
4. Persist new positions to Redis (TTL 1h)

### Dynamic Subscription via Pub/Sub

Wallet-monitor add/remove events published on Redis channel `monitor:events` are consumed by a dedicated `monitorSub` Redis connection inside the WS manager. This decouples the bot command handler from the WS manager without inter-process calls.

### Alert Evaluators (`src/workers/evaluators/`)

| Evaluator | Trigger |
|---|---|
| `risk-tier.ts` | riskTier enters `atRisk`, `cancellable`, `liquidatable`, `backstopLiquidatable`, `highRisk`; 5-min dedup |
| `position-flip.ts` | Position symbol appears/disappears (open/close detection) for watchers |
| `monitor.ts` | External wallet position changes and fills for wallet-monitor subscribers |
| `guardian.ts` | Per-rule condition checks on every WS event; cooldown gating |
| `price-alert.ts` | Periodic watcher (polls all active price alerts from DB against current mark price) |
| `shared.ts` | `isAlertEnabled(userId, type)` — checks `alert_subscriptions` table; `esc()` — HTML escape |

### Alert Queue (`src/jobs/`)

BullMQ queue `alerts` backed by Redis. Job data:
```typescript
{ telegramId, type, message, symbol?, keyboard? }
```

Worker (`src/jobs/processors/alert.ts`):
- 10 concurrent handlers
- **Dedup**: Redis `SET NX EX 5` on key `dedup:alert:{telegramId}:{type}:{symbol}` — drops duplicate within 5 seconds
- Non-retryable errors (Telegram 403/400): drop job
- Retryable errors: 3 attempts, exponential backoff from 1s

---

## 7. Guardian Risk System

### Rules (`src/db/schema/guardian.ts`)

6 rule types:
| Type | What it checks |
|---|---|
| `liq_distance` | % distance between mark price and liquidation price |
| `drawdown` | PnL drop from peak (tracked in Redis per user/symbol) |
| `pnl_target` | PnL % above/below threshold (target take-profit or stop-loss) |
| `funding_drain` | Daily funding cost in USD for held position |
| `exposure_limit` | Total portfolio notional exceeds limit |
| `margin_ratio` | Effective collateral / total exposure ratio |

5 action types:
| Action | Behavior |
|---|---|
| `notify` | Sends Telegram alert |
| `suggest` | Alert + inline buttons (close, reduce 50%, add margin, snooze 30m) |
| `auto_close` | Executes `closePosition(fraction=1)` autonomously |
| `auto_reduce` | Executes `closePosition(fraction=actionParam/100)` |
| `auto_margin` | Executes `addMargin(actionParam)` |

Key implementation details:
- Cooldown: `lastTriggeredAt` + `cooldownSec` (default 300s) prevents spam
- Auto-action lock: Redis `SET NX EX 150` prevents concurrent auto-executions for same user
- Peak tracking for drawdown: Redis key `guardian:peak:{userId}:{symbol}` → cleared when position closes
- Max 20 rules per user
- Kill switch: `disableAllAutoActions()` demotes all auto_close/auto_reduce/auto_margin → suggest

---

## 8. Trade Flow (Long/Short)

Step-by-step wizard:
1. `/long` or `/short` → market picker (paginated, 10/page via `src/bot/lib/paginate.ts`)
2. Activation gate check (via `src/bot/lib/activation.ts`)
3. Size step: shows available collateral, presets ($50/$100/$200/$500/all), custom input
4. Leverage step: presets (1×/2×/5×/10×/20×/custom)
5. Confirm screen: mark price, fees, estimated liquidation price, rate-limit check
6. Execute: `placeMarketOrder()` → optional auto TP/SL setup from settings
7. Success: receipt with tx link on Solscan; if trade log enabled → DB insert

Auto TP/SL: if user has `autoTpPct`/`autoSlPct` set in settings, automatically places conditional orders post-fill.

Pending state keys:
- `trade_size_input:side:SYMBOL` — waiting for size text
- `trade_lev_input:side:SYMBOL:AMT` — waiting for leverage text

---

## 9. TP/SL System (`tpsl.ts` + `conditional.ts`)

### Entry Point

`/positions` → tap position → `🎯 Set TP` / `🛑 Set SL` inline button.

### Ladder System

- Up to 8 rungs per leg (TP or SL) per position
- Each rung: trigger price + size + execution mode (limit/market)
- Display: coverage % per rung, cumulative, remaining
- Presets: "50/50 split", single full-size rung
- Per-rung: edit price, edit size, flip mode, remove
- Clear all with confirmation gate

### Price Validation

- TP on long: must be > mark price
- SL on long: must be > liquidation price (safety floor) but < mark price
- Short: reversed
- Aggregate rung size cannot exceed position size

### Pending State Keys

- `tpsl_px:leg:SYM:side` — price input
- `tpsl_px:leg:SYM:side:E:idx` — edit price of existing rung
- `tpsl_sz:leg:SYM:side:px` — size input
- `tpsl_editsz:leg:SYM:side:idx` — edit size of existing rung (uses "0" sentinel for price, looks up rung by index)

---

## 10. Deposit / Withdraw Flows

### Deposit

1. `/deposit` → shows wallet address + QR code + fund collateral button
2. "Fund collateral" → shows wallet USDC balance, presets, custom amount
3. Confirm → `depositCollateral(wallet, amount, fee)` — on-chain tx

QR codes: SVG generated from `qrcode.js`, rendered via `@resvg/resvg-js` to PNG.

### Withdraw

Three modes:
- **Internal** (trading → bot wallet): `withdrawCollateral()` — single tx
- **External** (trading → bot wallet → external Solana address): `withdrawCollateral()` then `transferUsdc()` — two txs
- **Wallet-source** (bot wallet → external): `transferUsdc()` — single tx

Custom amount flows via pending state. Safe amount: deposited collateral (excludes unrealized PnL).

SOL gas check: requires minimum SOL balance before executing.

---

## 11. Wallet Monitor Feature

Users track up to 10 external wallets:
- DB table: `wallet_monitors` — userId, watchedWallet, label, enabled, alertOnFill, alertOnPositionChange
- Add: send wallet address → validated as base58 → subscribed to WS if enabled
- Per-wallet toggles for fill/position alerts
- Events dispatched via Redis pub/sub to WS manager without requiring a restart
- UI: list, settings per monitor, remove with confirmation

---

## 12. Leaderboard Scanner (`src/workers/leaderboard.ts`)

Production-only. Multi-phase startup:
1. Sync wallet tags from `data/wallet-tags.json`
2. Load existing DB wallets into memory set
3. Fetch known traders from Phoenix GPA (GetProgramAccounts)
4. Seed DB with discovered wallets
5. Hydrate stale traders (REST API, rate-limited at 0.5/sec)
6. Subscribe to trade-channel WS for real-time discovery

Background tasks:
- Every 30 minutes: re-hydrate stale traders
- Every 2 hours: full GPA rescan

Leaderboard display: sort by `total_volume`, `win_rate`, or `realized_pnl`. Pagination 10/page.

Data stored in `leaderboard_snapshots` table with comprehensive metrics (portfolio value, realized PnL, volume, win/loss counts, open positions, wallet metadata).

---

## 13. Referral System (`src/services/referral.ts`)

Feature-flagged (`REFERRAL_ENABLED`). Two tiers:
- **T1**: direct referral — user A referred user B → A gets 20% of builder fee on B's trades
- **T2**: indirect referral — user A referred B who referred C → A gets 10% of C's builder fee

`accrueReferralFee(userId, notional)`:
- Called per fill from WS handler
- Builder fee = `BUILDER_FEE_BPS` bps of notional
- T1 gets 20% of builder fee, T2 gets 10%
- Amounts stored in `referrals` table (`accruedUsdc` field)

Claim flow: `claim.ts` aggregates claimable, presumably triggers on-chain settlement (implementation detail not fully read).

Referral code: 8-char hex, generated at user creation, unique constraint.

Note: Phoenix's native referral program requires $10K volume; this bot-native system is independent.

---

## 14. Database Schema Summary

| Table | Key fields | Purpose |
|---|---|---|
| `users` | telegram_id PK, wallet_address, privy_*, phoenix_activated | User identity |
| `alert_subscriptions` | user_id, type (enum), symbol, trigger_price | Alert preferences |
| `guardian_rules` | user_id, rule_type, threshold, action, cooldown_sec | Risk automation |
| `referrals` | referrer_id, referee_id, tier (t1/t2), accrued_usdc | Referral rewards |
| `leaderboard_snapshots` | wallet_address, portfolio_value, realized_pnl, volume, win/loss | Leaderboard data |
| `trades` | user_id, symbol, side, margin, leverage, notional, tx_sig | Trade history |
| `settings` | user_id, slippage_bps, default_leverage, fee_mode, auto_tp_pct, auto_sl_pct | User preferences |
| `wallet_monitors` | user_id, watched_wallet, label, alert_on_fill, alert_on_position_change | External wallet tracking |
| `action_logs` | user_id, command, args, outcome, duration_ms, tx_signature | Audit trail (30-day retention) |

Drizzle ORM. Migrations in `src/db/migrations/`. 11 migration files (0000–0010).

---

## 15. Message Formatting Rules

All bot messages use `@grammyjs/parse-mode`:
- `fmt` tagged template literal composes `FormattedString` values
- Sent as `{ text, entities }` — never `{ parse_mode: "HTML" }`
- Exception: guardian alert messages use raw HTML strings directly (inconsistency — guardian evaluator uses string interpolation with `esc()` function for manual HTML escaping)
- `link_preview_options: { is_disabled: true }` whenever URLs present

---

## 16. Configuration & Environment

Validated at startup via Zod (`src/config/index.ts`). Crashes with field-level errors if invalid.

Required variables:
- `TELEGRAM_BOT_TOKEN`
- `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`
- `BUILDER_AUTHORITY_PUBKEY`, `BUILDER_ACCESS_CODE`
- `HELIUS_RPC_URL`
- `DATABASE_URL`
- `REDIS_URL`

Optional:
- `WEBHOOK_URL`, `WEBHOOK_SECRET` (required in production if WEBHOOK_URL set)
- `PHOENIX_API_URL`, `PHOENIX_WS_URL` (defaults to Phoenix mainnet)
- `REFERRAL_ENABLED` (default false)
- `BUILDER_FEE_BPS` (default 10, max 50)
- `PRIVY_AUTHORIZATION_KEY_ID`

---

## 17. Error Handling

`src/bot/lib/errors.ts`:
- `toBotError(err)`: normalizes any error to `{ userMessage, retryable, code }`
- `renderBotError(ctx, err)`: sends user-visible error message; tries to edit existing message first, falls back to reply
- Logs all errors to action_log with `outcome: "error"`, `errorCode`, `errorCategory`

Bot-level catch:
- `GrammyError` — Telegram API errors (logged with method/code)
- `HttpError` — network failures to Telegram
- Generic — logged with full update context

---

## 18. Notable Specificities & Quirks

1. **No isolated subaccount creation in bot** — isolated-only markets are gated at command entry but creating a new isolated subaccount mid-flow is not implemented; user must have one already or be directed to Phoenix UI.

2. **Pending state race condition protection** — `sequentialize()` ensures updates per user run serially, preventing double-dispatch on rapid taps.

3. **Builder fee validation** — `BUILDER_PUBKEY_VALID` check (length ≥ 43) guards trading client construction; if key is missing/short, builder config is omitted but trading still works (just no fee collection).

4. **Action log retention** — daily sweep deletes logs older than 30 days. No archive.

5. **Leaderboard only in production** — `if (config.NODE_ENV === "production")` gate. Dev mode skips entirely, failure is non-fatal even in prod.

6. **WS connection cap** — 500 max connections. Beyond that, new subscriptions are silently skipped with a warn log. No eviction policy for idle watchers.

7. **Guardian auto-action lock** — Redis `SET NX EX 150` prevents concurrent auto-executions for same user, but does not prevent the same rule from queuing an alert while another rule executes. Each rule is independently evaluated per event.

8. **Price alert watcher** — separate polling loop (not event-driven). Polls all active price alerts against current mark prices. Cache-busted on mutation via `bustPriceAlertCache`.

9. **Drawdown peak tracking** — Redis-based, cleared when position closes. If bot restarts, peak is lost → rule won't trigger until a new peak is established (conservative behavior).

10. **ESM-strict** — `"type": "module"` + NodeNext resolution. All imports require `.js` extension even for TypeScript sources.

11. **Deep-link support** — `/start pos_`, `/start hist_`, `/start mkt_`, `/start wallet_`, `/start long_`, `/start short_` are parsed in `start.ts` to route directly to specific views (e.g., share links, market open flows).

12. **Idempotent callbacks** — `src/bot/lib/idempotent.ts` provides dedup for callback queries that might fire twice on unstable connections.

13. **Image generation** — `src/services/image.ts` generates P&L share cards using SVG + `@resvg/resvg-js`. Assets include Inter and Space Grotesk fonts. Win cards use `assets/win.jpg` background, loss cards `assets/lost.jpg`.

14. **Privy Bot-First Auth** — signing uses `PRIVY_AUTHORIZATION_PRIVATE_KEY` (an Ed25519 key registered in Privy dashboard). This means the bot signs transactions on behalf of users without any user interaction. Security model: bot controls all wallets.

15. **Funding flip alert (deprecated)** — `funding_flip` and `large_funding` alert types exist in the enum but are documented as deprecated. No active evaluator produces them.

---

## 19. Key Gaps / Incomplete Areas

- **Rise SDK stubs** — per CLAUDE.md the original stubs have been replaced by `@ellipsis-labs/rise` `^0.4.9`, which is now in `package.json`. The client is functional.
- **Ember proxy for deposits** — CLAUDE.md references Ember proxy for USDC wrapping; actual deposit implementation uses direct `depositCollateral` — proxy handling may be inside the Rise SDK.
- **Claim flow** — `src/bot/commands/claim.ts` exists but was not fully read; referral claim settlement on-chain is unclear.
- **Price alert WS integration** — price alerts use a polling evaluator rather than tapping the WS event stream; this is less real-time than risk-tier alerts.
- **No test coverage for trade execution paths** — tests exist (`pnpm test`) but coverage of critical paths (trade confirm, TP/SL execution) is unknown.
